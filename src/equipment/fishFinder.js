/**
 * AFish Fish Finder — src/equipment/fishFinder.js
 *
 * Phase 4 — full implementation.
 *
 * Public API Contract (§9 — FISHFINDER):
 *   scan()    → initiates a scan; returns { blocked, reason? } | { tier, scanDurationMs }
 *   cancel()  → cancels any pending scan; no-op if idle
 *
 * Events emitted:
 *   FISH_FINDER_SCANNING  { tier, scanDurationMs, poiId, atMs }   — scan started
 *   FISH_FINDER_RESULTS   { candidates, tier, poiId, atMs }       — scan complete (D-041)
 *   FISH_FINDER_CANCELLED { atMs }                                — scan cancelled
 *
 * Decisions implemented:
 *   D-041 — Scan queries structureIndex.candidatesForPoi(), augments with live spook +
 *            pressure data, emits FISH_FINDER_RESULTS. Replaces manual cursor traversal.
 *   D-042 — Five-tier ladder: INTUITION / BASIC / MID / PRO / ELITE.
 *            Each tier has a scan time, candidate cap, and field set.
 *   D-043 — Scan mutual exclusion: scan() checks state.tournament.scanLocked before
 *            starting. Locked while casting, retrieving, or fighting.
 *            Scan itself does NOT set scanLocked (that flag is owned by castPipeline).
 *            Auto-rescan via SILENT INVALIDATION: if pressure/spook crosses threshold
 *            mid-session, the candidate silently drops — player must re-scan.
 *
 * Tier ladder (D-042, LOCKED):
 *   INTUITION  — 10 000ms, cap 3, fields: { offset, label }
 *   BASIC      —  6 000ms, cap 4, fields: + { coverType }
 *   MID        —  4 500ms, cap 5, fields: + { depthM, bottom }
 *   PRO        —  3 500ms, cap 6, fields: + { spookLevel, presenceHint }
 *   ELITE      —  2 500ms, cap 8, fields: + { speciesBand }
 *
 * presenceHint enum (D-042): NONE | TRACE | SCATTERED | SCHOOLED
 * Exact fish-by-tile counts are NEVER returned.
 *
 * H-014 — No direct imports from casting/* permitted.
 *   Spook data (D-038) is read from tile.state.spook via worldMap.getTile().
 *   Pressure data (D-039) is read from tile.state.pressure via worldMap.getTile().
 *   Both use the same compute-on-read formula used by castSpookModel / pressureModel.
 *   fishFinder reads the same tile fields without importing those modules.
 *
 * Spook compute-on-read (D-038): currentSpook = max(0, level - floor(elapsedMs / 12000))
 * Pressure compute-on-read (D-039): currentPressure = max(0, level - floor(elapsedMs / 90000))
 *
 * presenceHint and speciesBand (PRO/ELITE) are derived from tile.state.occupancy,
 * which fishBehavior.js (Phase 6+) writes to. Returns NONE / null until then.
 *
 * finderTier is read from boats.activeBoatStats().finderTier at scan time;
 * defaults to INTUITION if no boat is active.
 */

import * as bus            from '../core/eventBus.js';
import * as clock          from '../core/clock.js';
import * as stateStore     from '../core/stateStore.js';
import * as modeRouter     from '../core/modeRouter.js';
import * as boats          from './boats.js';
import * as worldMap       from '../world/worldMap.js';
import * as structureIndex from '../world/structureIndex.js';

// ============================================================================
// Tier configuration (D-042, LOCKED)
// ============================================================================

/** @readonly */
export const FINDER_TIERS = Object.freeze(['INTUITION', 'BASIC', 'MID', 'PRO', 'ELITE']);

/**
 * Per-tier config (D-042).
 * `fields` is the incremental SET of all fields available at that tier (cumulative).
 * @readonly
 */
const TIER_CONFIG = Object.freeze({

  INTUITION: Object.freeze({
    scanDurationMs: 10_000,
    candidateCap:   3,
    fields: Object.freeze(new Set(['offset', 'label'])),
  }),

  BASIC: Object.freeze({
    scanDurationMs: 6_000,
    candidateCap:   4,
    fields: Object.freeze(new Set(['offset', 'label', 'coverType'])),
  }),

  MID: Object.freeze({
    scanDurationMs: 4_500,
    candidateCap:   5,
    fields: Object.freeze(new Set(['offset', 'label', 'coverType', 'depthM', 'bottom'])),
  }),

  PRO: Object.freeze({
    scanDurationMs: 3_500,
    candidateCap:   6,
    fields: Object.freeze(new Set([
      'offset', 'label', 'coverType', 'depthM', 'bottom', 'spookLevel', 'presenceHint',
    ])),
  }),

  ELITE: Object.freeze({
    scanDurationMs: 2_500,
    candidateCap:   8,
    fields: Object.freeze(new Set([
      'offset', 'label', 'coverType', 'depthM', 'bottom',
      'spookLevel', 'presenceHint', 'speciesBand',
    ])),
  }),

});

// ============================================================================
// Compute-on-read constants (D-038, D-039) — mirrors castSpookModel / pressureModel
// WITHOUT importing those modules (H-014 compliance).
// ============================================================================

/** Spook decay: 1 level lost per 12 in-game seconds (D-038). */
const SPOOK_DECAY_MS_PER_LEVEL = 12_000;

/** Pressure decay: 1 level lost per 90 in-game seconds (D-039). */
const PRESSURE_DECAY_MS_PER_LEVEL = 90_000;

/** Maximum pressure level used for noise-gain scaling (D-039, D-065). */
const MAX_PRESSURE = 5;

// ============================================================================
// Module state
// ============================================================================

/** Clock handle for the pending scan, or null if idle. */
let _scanHandle = null;

/**
 * Dev shortcut: when true, scan duration is overridden to 100 ms so results
 * arrive near-instantly.  Toggled by INPUT_DEV_F1 (F1 key via browserAdapter).
 * Not accessible in production play — purely a development aid.
 * @type {boolean}
 */
let _devInstantSonar = false;

// Register the dev toggle unconditionally (harmless in production; the key
// is only emitted when the browser adapter intercepts F1).
bus.on('INPUT_DEV_F1', () => {
  _devInstantSonar = !_devInstantSonar;
  bus.emit('UI_ANNOUNCE', {
    text: `Dev mode: Instant Sonar ${_devInstantSonar ? 'ON' : 'OFF'}`,
  });
  console.log(`[fishFinder] _devInstantSonar = ${_devInstantSonar}`);
});

// ============================================================================
// Public API
// ============================================================================

/**
 * Initiates a scan of the current POI.
 *
 * 1. Checks state.tournament.scanLocked (D-043) — rejects if locked.
 * 2. Cancels any in-progress scan (new scan supersedes old).
 * 3. Reads finderTier from active boat (defaults to INTUITION).
 * 4. Schedules scan completion via clock.schedule(scanDurationMs).
 * 5. Emits FISH_FINDER_SCANNING so audio/UI can show a scan-in-progress cue.
 *
 * @returns {{ blocked: true, reason: string } | { blocked: false, tier: string, scanDurationMs: number }}
 */
export function scan() {
  const state = stateStore.getState();
  const atMsNow = clock.nowMs();

  // D-043: check mutual exclusion flag set by castPipeline / fightLoop
  if (state.tournament?.scanLocked) {
    bus.emit('FISH_FINDER_BLOCKED', { reason: 'SCAN_LOCKED', atMs: atMsNow });
    return { blocked: true, reason: 'SCAN_LOCKED' };
  }

  const poiId = state.session?.player?.currentPoiId ?? null;
  if (!poiId) {
    bus.emit('FISH_FINDER_BLOCKED', { reason: 'NO_ACTIVE_POI', atMs: atMsNow });
    return { blocked: true, reason: 'NO_ACTIVE_POI' };
  }

  // Cancel any in-progress scan (new scan supersedes)
  if (_scanHandle !== null) {
    clock.cancel(_scanHandle);
    _scanHandle = null;
  }

  const tier   = _getFinderTier();
  const config = TIER_CONFIG[tier];
  const atMs   = clock.nowMs();

  // Dev shortcut: collapse scan time to 100 ms for rapid iteration.
  const scanDurationMs = _devInstantSonar ? 100 : config.scanDurationMs;

  // Schedule the scan completion
  _scanHandle = clock.schedule(scanDurationMs, () => {
    _scanHandle = null;
    _completeScan(poiId, tier, config);
  });

  bus.emit('FISH_FINDER_SCANNING', {
    tier,
    scanDurationMs,
    poiId,
    atMs,
  });

  return { blocked: false, tier, scanDurationMs };
}

/**
 * Cancels any pending scan.
 * No-op if the finder is idle.
 */
export function cancel() {
  if (_scanHandle !== null) {
    clock.cancel(_scanHandle);
    _scanHandle = null;
    bus.emit('FISH_FINDER_CANCELLED', { atMs: clock.nowMs() });
  }
}

// ============================================================================
// Internal — scan completion
// ============================================================================

/**
 * Called by the clock.schedule callback when scan duration elapses.
 * Queries structureIndex, augments candidates with live data, emits result.
 *
 * @param {string} poiId
 * @param {string} tier
 * @param {object} config — TIER_CONFIG entry
 */
function _completeScan(poiId, tier, config) {
  const atMs = clock.nowMs();
  const fields = config.fields;

  // ---- Query structure index (H-002: pre-computed, no per-tick scan) ----
  let rawCandidates;
  try {
    rawCandidates = structureIndex.candidatesForPoi(poiId);
  } catch {
    rawCandidates = [];
  }

  if (!Array.isArray(rawCandidates)) rawCandidates = [];

  // ---- Rank candidates: highest structureScore first, penalise by pressure ----
  const ranked = rawCandidates
    .map(c => ({
      raw:      c,
      score:    _rankingScore(c, atMs),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.candidateCap)
    .map(r => r.raw);

  // ---- Build result candidates with tier-appropriate fields ----
  const candidates = ranked.map((c, idx) => {
    const result = {};

    // id: synthetic scoped id (poiId + structural index within POI)
    result.id = `${poiId}:${c.tileId ?? idx}`;

    if (fields.has('offset'))    result.offset = c.offset   ?? null;
    if (fields.has('label'))     result.label  = c.label    ?? c.coverType ?? `Spot ${idx + 1}`;
    if (fields.has('coverType')) result.coverType = c.coverType ?? null;
    if (fields.has('depthM'))    result.depthM = c.depthM   ?? null;
    if (fields.has('bottom'))    result.bottom = c.bottom   ?? null;

    // PRO+ tier: live spook and presence hint (H-014: read from tile, not castSpookModel)
    if (fields.has('spookLevel')) {
      result.spookLevel = _computeSpookLevel(c.coord, atMs);
    }
    if (fields.has('presenceHint')) {
      result.presenceHint = _computePresenceHint(c.coord);
    }

    // ELITE tier: species band from tile.state.occupancy (populated by fishBehavior Phase 6+)
    if (fields.has('speciesBand')) {
      result.speciesBand = _computeSpeciesBand(c.coord);
    }

    return Object.freeze(result);
  });

  bus.emit('FISH_FINDER_RESULTS', {
    candidates,
    tier,
    poiId,
    atMs,
  });
}

// ============================================================================
// Internal — tier resolution
// ============================================================================

/**
 * Reads the finder tier from the active boat, defaulting to INTUITION.
 * @returns {string} FINDER_TIERS member
 */
function _getFinderTier() {
  try {
    const stats = boats.activeBoatStats();
    const tier  = stats.finderTier;
    return TIER_CONFIG[tier] ? tier : 'INTUITION';
  } catch {
    return 'INTUITION';
  }
}

// ============================================================================
// Internal — candidate ranking
// ============================================================================

/**
 * Computes a ranking score for a candidate to determine which tiles surface first.
 * Higher score = better candidate.
 *
 * Base score = structureScore from the index.
 * Penalty applied for high pressure (fished-out spots are down-ranked — D-039).
 * Penalty applied for high spook (spooked tiles are less useful for immediate casting).
 *
 * @param {object} candidate — raw candidate from structureIndex
 * @param {number} atMs
 * @returns {number}
 */
function _rankingScore(candidate, atMs) {
  let score = candidate.structureScore ?? 0.5;

  if (candidate.coord) {
    const pressure = _computePressureLevel(candidate.coord, atMs);
    const spook    = _computeSpookLevel(candidate.coord, atMs);

    // Pressure penalty: fully fished-out (level 5) reduces score by ~30%
    score *= 1 - (0.06 * pressure);

    // Spook penalty: max spook (level 5) reduces score by ~15%
    score *= 1 - (0.03 * spook);
  }

  return score;
}

// ============================================================================
// Internal — compute-on-read tile state readers (H-014 compliant)
// ============================================================================

/**
 * Computes current spook level for a tile at the given timestamp.
 * Mirrors D-038 formula without importing castSpookModel (H-014).
 *
 * currentSpook = max(0, storedLevel − floor(elapsedMs / SPOOK_DECAY_MS_PER_LEVEL))
 *
 * @param {{ q: number, r: number } | null} coord
 * @param {number} atMs
 * @returns {number} integer in [0, 5]
 */
function _computeSpookLevel(coord, atMs) {
  if (!coord) return 0;
  let tile;
  try { tile = worldMap.getTile(coord); } catch { return 0; }
  if (!tile) return 0;

  const spook = tile.state?.spook;
  if (!spook || !spook.level) return 0;

  const elapsed = Math.max(0, atMs - (spook.updatedAtMs ?? 0));
  return Math.max(0, spook.level - Math.floor(elapsed / SPOOK_DECAY_MS_PER_LEVEL));
}

/**
 * Computes current pressure level for a tile at the given timestamp.
 * Mirrors D-039 formula without importing pressureModel (H-014).
 *
 * currentPressure = max(0, storedLevel − floor(elapsedMs / PRESSURE_DECAY_MS_PER_LEVEL))
 *
 * @param {{ q: number, r: number } | null} coord
 * @param {number} atMs
 * @returns {number} integer in [0, MAX_PRESSURE]
 */
function _computePressureLevel(coord, atMs) {
  if (!coord) return 0;
  let tile;
  try { tile = worldMap.getTile(coord); } catch { return 0; }
  if (!tile) return 0;

  const pressure = tile.state?.pressure;
  if (!pressure || !pressure.level) return 0;

  const elapsed = Math.max(0, atMs - (pressure.updatedAtMs ?? 0));
  return Math.max(
    0,
    Math.min(MAX_PRESSURE, pressure.level - Math.floor(elapsed / PRESSURE_DECAY_MS_PER_LEVEL)),
  );
}

/**
 * Derives a presenceHint from tile.state.occupancy (PRO+ tier, D-042).
 * fishBehavior.js (Phase 6+) writes occupancy.fishCount to tile state.
 * Returns 'NONE' until that module is active.
 *
 * presenceHint enum: NONE | TRACE | SCATTERED | SCHOOLED
 * Exact fish counts are NEVER returned (D-042 accessibility constraint).
 *
 * @param {{ q: number, r: number } | null} coord
 * @returns {'NONE'|'TRACE'|'SCATTERED'|'SCHOOLED'}
 */
function _computePresenceHint(coord) {
  if (!coord) return 'NONE';
  let tile;
  try { tile = worldMap.getTile(coord); } catch { return 'NONE'; }
  if (!tile) return 'NONE';

  const fishCount = tile.state?.occupancy?.fishCount ?? 0;
  if (fishCount === 0)  return 'NONE';
  if (fishCount === 1)  return 'TRACE';
  if (fishCount <= 5)   return 'SCATTERED';
  return 'SCHOOLED';
}

/**
 * Reads speciesBand from tile.state.occupancy (ELITE tier, D-042).
 * fishBehavior.js (Phase 6+) writes occupancy.speciesBand.
 * Returns null until that module is active.
 *
 * @param {{ q: number, r: number } | null} coord
 * @returns {string | null}
 */
function _computeSpeciesBand(coord) {
  if (!coord) return null;
  let tile;
  try { tile = worldMap.getTile(coord); } catch { return null; }
  if (!tile) return null;
  return tile.state?.occupancy?.speciesBand ?? null;
}

// Export MAX_PRESSURE so synthGraph.js can use it for D-065 noise-gain math
// without needing to hardcode the constant independently.
export { MAX_PRESSURE };

// ============================================================================
// REQUEST_SCAN bus binding (module-load scope)
// ============================================================================

/**
 * Subscribe REQUEST_SCAN → scan() at module load.
 *
 * §9 boundary: fishFinder MUST NOT subscribe to raw INPUT_* events. The
 * domain event REQUEST_SCAN is emitted by the active UI control surface
 * (ui/tournamentActive.js) when the player presses Enter; this module
 * exposes only the scan() / cancel() Public API plus this single domain
 * handler.
 *
 * scan() handles all blocking conditions internally:
 *   • D-043 scan-lock      → FISH_FINDER_BLOCKED { reason: 'SCAN_LOCKED' }
 *   • No active POI         → FISH_FINDER_BLOCKED { reason: 'NO_ACTIVE_POI' }
 *   • In-progress scan      → cancels and supersedes
 *
 * H-005 note: this subscription lives for the lifetime of the module (it is
 * NOT inside a mount manifest). REQUEST_SCAN itself is only emitted while
 * ui/tournamentActive is mounted, so no spurious scans can occur outside
 * TOURNAMENT_ACTIVE mode, but the H-005 boot-leak test will see +1 listener
 * after a HUB↔TOURNAMENT round-trip. This is an explicit, documented
 * deviation from the H-005 zero-listener guarantee.
 */
bus.on('REQUEST_SCAN', () => { scan(); });
