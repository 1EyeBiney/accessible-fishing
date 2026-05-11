/**
 * AFish Cast Pipeline — src/casting/castPipeline.js
 *
 * Public API Contract: (no exported functions — purely event-driven FSM)
 *
 * Owns the full 5-tap casting sequence from TARGET_LOCKED to CAST_LANDED (D-014).
 * Implements Bird's Nest penalty (D-015), Spool Wall boundary clamping (D-016),
 * mismatched-lure scatter penalty (D-052), and scan mutual exclusion (D-043).
 *
 * Lifecycle:
 *   Mounted in TOURNAMENT_ACTIVE via modeRouter mount manifest.
 *   All bus subscriptions and clock handles are released on onUnmount (H-005).
 *
 * ── Cast FSM Phases (D-014) ──────────────────────────────────────────────────
 *
 *   IDLE
 *     Waiting for TARGET_LOCKED (emitted by targetSelector after player confirms).
 *     Arrow and Spacebar events are ignored in this phase.
 *
 *   BACKSWING  (entered on TARGET_LOCKED)
 *     Wind vector is sampled and held for the cast's lifetime (D-012).
 *     state.tournament.scanLocked is set → blocks new scans (D-043).
 *     Waiting for: Tap 1 — any Arrow key.
 *
 *   POWER      (entered on Tap 1 Arrow)
 *     Records _tap1AtMs. Wind Mitigation timer has NOT yet started.
 *     Waiting for: Tap 2 — Spacebar.
 *
 *   APEX       (entered on Tap 2 Spacebar)
 *     Records _tap2AtMs — opens Wind Mitigation timing window (D-014).
 *     Waiting for: Tap 3 — any Arrow key.
 *
 *   RELEASE    (entered on Tap 3 Arrow)
 *     Records _tap3AtMs. Scatter circle radius computed from Tap1→Tap3 timing.
 *     D-052 mismatched-lure scatter penalty applied here.
 *     Wind Mitigation timer is now in play between Tap2 and the upcoming Tap4.
 *     Waiting for: Tap 4 — Spacebar.
 *
 *   SPLASHDOWN (entered on Tap 4 Spacebar)
 *     Records _tap4AtMs — closes Wind Mitigation window.
 *     Mitigation factor computed from (Tap2→Tap4) vs (Tap1→Tap3) duration match.
 *     D-014: perfect match → 80% wind reduction.
 *     Waiting for: Tap 5 — any Arrow key.
 *
 *   → CAST_LANDED (on Tap 5 Arrow)
 *     Computes final landing offset: target + wind drift (mitigated) + scatter.
 *     D-016 Spool Wall: clamps landing to POI frameRadius if exceeded.
 *     Determines splash kind (SILENT / NORMAL / LOUD) from cast accuracy.
 *     Calls castSpookModel.applySplash to register spook on the landing tile.
 *     Emits CAST_LANDED bus event (consumed by fishBehavior Phase 6).
 *     Dispatches CAST_PHASE_CHANGED({ cast: null }) and SCAN_UNLOCKED.
 *     Returns to IDLE.
 *
 * ── Bird's Nest Penalty (D-015) ──────────────────────────────────────────────
 *
 *   If the player fails to deliver the next expected tap within INTER_TAP_TIMEOUT_MS
 *   (3 s), the cast is voided:
 *     1. inputAdapter.lock('BIRDS_NEST', nestDurationMs) — physical lockout.
 *        nestDurationMs is random in [10 000, 15 000] ms (D-015).
 *     2. CAST_BIRDS_NEST bus event emitted { nestDurationMs, atMs }.
 *     3. CAST_PHASE_CHANGED({ cast: null }) dispatched.
 *     4. SCAN_UNLOCKED dispatched.
 *     5. State reset to IDLE.
 *   The world clock CONTINUES to run during the lockout (D-015, D-013).
 *
 * ── Scatter & Mitigation Math ────────────────────────────────────────────────
 *
 *   Scatter radius (set at Tap 3, Apex):
 *     idealMs     = IDEAL_BACKSWING_MS (600 ms) — sweet-spot backswing duration
 *     elapsed     = Tap3.atMs − Tap1.atMs
 *     deviation   = |elapsed − idealMs|
 *     quality     = clamp(1 − deviation / SCATTER_QUALITY_WINDOW, 0, 1)
 *     baseScatter = lerp(MAX_SCATTER_TILES, MIN_SCATTER_TILES, quality)
 *     After D-052 mismatch check: scatter *= MISMATCH_SCATTER_MULTIPLIER if applicable.
 *
 *   Mitigation factor (set at Tap 4, close wind window):
 *     reference   = Tap3.atMs − Tap1.atMs  (the backswing window the player just set)
 *     window      = Tap4.atMs − Tap2.atMs  (how long the player held the spacebar window)
 *     deviation   = |window − reference|
 *     quality     = clamp(1 − deviation / MITIGATION_MATCH_WINDOW_MS, 0, 1)
 *     mitigFactor = quality  (0 = no reduction, 1 = full 80% reduction)
 *     Wind reduction applied = mitigFactor × 0.80  (D-014: perfect = 80%, not 100%)
 *
 *   Landing offset:
 *     windStrength = _windAtCast.intensityMs × WIND_DRIFT_SCALE
 *     windReduced  = windStrength × (1 − mitigFactor × 0.80)
 *     windDrift    = { dx: windVec.dx × windReduced, dy: windVec.dy × windReduced }
 *     scatterAngle = rngStream('cast').next() × 2π
 *     scatterMag   = rngStream('cast').next() × scatterRadius
 *     scatter      = { dx: cos(angle)×mag, dy: sin(angle)×mag }
 *     landing      = target.offset + windDrift + scatter
 *     D-016 clamp: if |landing| > poi.frameRadius → scale landing to frameRadius
 *
 * ── Splash Kind → Spook (D-014, D-038) ──────────────────────────────────────
 *
 *   accuracy = 1 − clamp(scatterRadius / MAX_SCATTER_TILES, 0, 1)
 *   SILENT : accuracy > SPLASH_SILENT_THRESHOLD  (0.75) → spook increment = 0
 *   NORMAL : accuracy ≥ SPLASH_NORMAL_THRESHOLD  (0.35) → spook increment = +1
 *   LOUD   : accuracy < SPLASH_NORMAL_THRESHOLD          → spook increment = +3
 *
 * ── Mismatched-Lure Scatter Penalty (D-052) ──────────────────────────────────
 *
 *   Reads the first rod and first lure from state.tournament.activeTackle.
 *   If lure.weightOz < rod.lureWeightRangeOz.min
 *      OR lure.weightOz > rod.lureWeightRangeOz.max:
 *     scatterRadius *= MISMATCH_SCATTER_MULTIPLIER (2.0)
 *   No cast distance penalty (D-052). No Bird's Nest forced (D-052).
 *
 * ── Spool Wall (D-016) ───────────────────────────────────────────────────────
 *
 *   If |landing| > poi.frameRadius: landing is scaled to exactly frameRadius,
 *   preserving direction. The lure drops straight down at the boundary.
 *   Spook is applied at the clamped coordinate, not the intended landing.
 *
 * ── Scan Lock (D-043) ────────────────────────────────────────────────────────
 *
 *   SCAN_LOCKED dispatched on TARGET_LOCKED received (entering BACKSWING).
 *   SCAN_UNLOCKED dispatched on CAST_LANDED and on CAST_BIRDS_NEST.
 *   SCAN_UNLOCKED also dispatched in onUnmount if the pipeline was mid-cast.
 *
 * ── Events Emitted ───────────────────────────────────────────────────────────
 *
 *   CAST_PHASE_CHANGED  { cast: { phase, ...extra } | null, atMs }
 *     — emitted on bus AND dispatched to stateStore on every phase transition.
 *
 *   CAST_BIRDS_NEST     { nestDurationMs, phase, atMs }
 *     — emitted when the inter-tap timer fires.
 *
 *   CAST_LANDED         { poiId, candidateId, finderTier, landing, target,
 *                         splashKind, scatterRadius, mitigationFactor, atMs }
 *     — emitted when Tap 5 completes. Consumed by fish/fishBehavior (Phase 6).
 *
 * H-005 note: All _unsubs and the _nestHandle are cancelled in onUnmount.
 * H-014 note: This module does NOT import fishFinder.js or targetSelector.js.
 */

import * as bus            from '../core/eventBus.js';
import * as clock          from '../core/clock.js';
import * as rng            from '../core/rng.js';
import * as stateStore     from '../core/stateStore.js';
import * as inputAdapter   from '../core/inputAdapter.js';
import * as modeRouter     from '../core/modeRouter.js';
import * as wind           from '../navigation/wind.js';
import * as poiGraph       from '../world/poiGraph.js';
import * as equipment      from '../equipment/equipment.js';
import * as castSpookModel from './castSpookModel.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum milliseconds between consecutive taps before a Bird's Nest fires (D-015).
 * Applied from TARGET_LOCKED → Tap1, and between every subsequent tap pair.
 */
const INTER_TAP_TIMEOUT_MS = 3_000;

/** Minimum Bird's Nest lockout duration in ms (D-015). */
const BIRDS_NEST_MIN_MS = 10_000;

/** Maximum Bird's Nest lockout duration in ms (D-015). */
const BIRDS_NEST_MAX_MS = 15_000;

/**
 * Ideal Tap1→Tap3 backswing duration in ms.
 * Timing the apex (Tap3) exactly this long after the backswing start (Tap1)
 * yields zero scatter quality penalty (maximum accuracy).
 */
const IDEAL_BACKSWING_MS = 600;

/**
 * Maximum deviation from IDEAL_BACKSWING_MS before scatter quality hits 0.
 * A deviation of SCATTER_QUALITY_WINDOW ms produces the worst-case scatter.
 */
const SCATTER_QUALITY_WINDOW = 800;

/** Minimum scatter radius in tiles (perfect timing, no mismatch penalty). */
const MIN_SCATTER_TILES = 0.05;

/** Maximum scatter radius in tiles (worst timing or max mismatch penalty). */
const MAX_SCATTER_TILES = 2.5;

/**
 * Maximum deviation of (Tap2→Tap4) from (Tap1→Tap3) before mitigation quality
 * hits 0. Deviations above this produce zero wind reduction.
 */
const MITIGATION_MATCH_WINDOW_MS = 600;

/**
 * Scatter multiplier applied when the lure weight is outside the rod's rated
 * weight range (D-052). Applied multiplicatively on top of the timing scatter.
 */
const MISMATCH_SCATTER_MULTIPLIER = 2.0;

/**
 * Wind drift scale: converts wind intensity (m/s from wind.sample()) to tile drift
 * at 100% wind (0% mitigation). At max wind (~6 m/s) the cast drifts ~1.5 tiles.
 * Tuned to match navigation.js WIND_DRIFT_SCALE for perceptual consistency.
 */
const WIND_DRIFT_SCALE = 0.25; // tiles per m/s

/**
 * Accuracy threshold above which the splash is SILENT (spook increment = 0, D-038).
 * accuracy = 1 - clamp(scatterRadius / MAX_SCATTER_TILES, 0, 1)
 */
const SPLASH_SILENT_THRESHOLD = 0.75;

/**
 * Accuracy threshold above which the splash is NORMAL (+1 spook).
 * Below this threshold the splash is LOUD (+3 spook).
 */
const SPLASH_NORMAL_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Current FSM phase.
 * @type {'IDLE'|'BACKSWING'|'POWER'|'APEX'|'RELEASE'|'SPLASHDOWN'}
 */
let _phase = 'IDLE';

/**
 * Target committed at TARGET_LOCKED (D-011 anchoring).
 * @type {{ poiId: string, offset: {dx:number, dy:number}, candidateId: string, finderTier: string } | null}
 */
let _target = null;

/**
 * Wind vector sampled at TARGET_LOCKED time (D-012, held constant for flight).
 * @type {{ dx: number, dy: number, intensityMs: number } | null}
 */
let _windAtCast = null;

/** Tournament-clock timestamp of Tap 1 (Arrow, Backswing start). @type {number|null} */
let _tap1AtMs = null;

/** Tournament-clock timestamp of Tap 2 (Spacebar, open Wind Mitigation). @type {number|null} */
let _tap2AtMs = null;

/** Tournament-clock timestamp of Tap 3 (Arrow, Apex / scatter set). @type {number|null} */
let _tap3AtMs = null;

/** Tournament-clock timestamp of Tap 4 (Spacebar, close Wind Mitigation). @type {number|null} */
let _tap4AtMs = null;

/** Computed scatter radius in tiles, set at Tap 3. @type {number} */
let _scatterRadius = 0;

/** Computed mitigation factor [0,1], set at Tap 4. @type {number} */
let _mitigationFactor = 0;

/**
 * Clock handle for the inter-tap Bird's Nest timer.
 * Cancelled on each successful tap; null when idle.
 * @type {number|null}
 */
let _nestHandle = null;

/**
 * Lazy-initialised RNG stream for cast scatter and Bird's Nest duration (§5d).
 * Created on first use after engine.boot() has called rng.seed().
 * @type {{ next():number, int(min:number,max:number):number } | null}
 */
let _castRng = null;

/**
 * Bus unsubscribe functions acquired in onMount.
 * All must be called in onUnmount (H-005).
 * @type {Array<Function>}
 */
let _unsubs = [];

// ---------------------------------------------------------------------------
// RNG helper
// ---------------------------------------------------------------------------

/**
 * Returns the cast RNG stream, initialising it on first call.
 * Lazy init ensures rng.seed() has been called by engine.boot() before the
 * first cast stream is derived.
 *
 * @returns {{ next():number, int(min:number,max:number):number }}
 */
function _getRng() {
  if (!_castRng) _castRng = rng.rngStream('cast');
  return _castRng;
}

// ---------------------------------------------------------------------------
// Bird's Nest timer management (D-015)
// ---------------------------------------------------------------------------

/** Schedule a Bird's Nest timer for INTER_TAP_TIMEOUT_MS from now. */
function _scheduleBirdNest() {
  _cancelBirdNest();
  _nestHandle = clock.schedule(INTER_TAP_TIMEOUT_MS, _fireBirdNest);
}

/** Cancel any pending Bird's Nest timer. No-op when no timer is active. */
function _cancelBirdNest() {
  if (_nestHandle !== null) {
    clock.cancel(_nestHandle);
    _nestHandle = null;
  }
}

/**
 * Called by the clock.schedule callback when the inter-tap timeout elapses.
 *
 * D-015: the penalty is an input lockout of 10–15 s. The world clock continues
 * to run during the lockout (D-013). The lockout duration is randomly drawn
 * from [BIRDS_NEST_MIN_MS, BIRDS_NEST_MAX_MS] to prevent exploitable patterns.
 *
 * D-030: inputAdapter.lock() will emit forced INPUT_*_UP events for any held
 * inputs at the moment of locking — no hold-state leaks.
 *
 * @param {number} atMs — the clock time at which the timer fires
 */
function _fireBirdNest(atMs) {
  _nestHandle = null; // already fired; no cancel needed

  const nestDurationMs = _getRng().int(BIRDS_NEST_MIN_MS, BIRDS_NEST_MAX_MS);
  const prevPhase      = _phase;

  // Engage the physical input lockout (D-015, D-030).
  inputAdapter.lock('BIRDS_NEST', nestDurationMs);

  bus.emit('CAST_BIRDS_NEST', {
    nestDurationMs,
    phase: prevPhase,
    atMs,
  });

  _resetToIdle();
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

/**
 * Dispatch CAST_PHASE_CHANGED to stateStore and emit the matching bus event.
 * Keeps the two in sync so UI and audio receive consistent state.
 *
 * @param {{ phase: string, [key:string]: * } | null} castObj — null when IDLE
 */
function _dispatchPhase(castObj) {
  stateStore.dispatch({
    type:    'CAST_PHASE_CHANGED',
    payload: { cast: castObj },
  });
  bus.emit('CAST_PHASE_CHANGED', {
    cast:  castObj,
    atMs:  clock.nowMs(),
  });
}

/**
 * Reset FSM state to IDLE and dispatch CAST_PHASE_CHANGED + SCAN_UNLOCKED.
 * Called after a successful cast AND after a Bird's Nest penalty.
 *
 * Safe to call from IDLE (no-op on the scan unlock if never locked).
 */
function _resetToIdle() {
  const wasActive = _phase !== 'IDLE';

  _phase            = 'IDLE';
  _target           = null;
  _windAtCast       = null;
  _tap1AtMs         = null;
  _tap2AtMs         = null;
  _tap3AtMs         = null;
  _tap4AtMs         = null;
  _scatterRadius    = 0;
  _mitigationFactor = 0;

  _dispatchPhase(null);

  // Only unlock the scan if this reset is coming from a non-IDLE state
  // (i.e., we actually locked it in the first place).
  if (wasActive) {
    stateStore.dispatch({ type: 'SCAN_UNLOCKED' });
  }
}

// ---------------------------------------------------------------------------
// Scatter & Mitigation math
// ---------------------------------------------------------------------------

/**
 * Compute the scatter radius in tiles based on Tap1→Tap3 backswing timing
 * quality and the optional D-052 lure-weight mismatch penalty.
 *
 * @returns {number} scatter radius in tiles, ≥ MIN_SCATTER_TILES
 */
function _computeScatterRadius() {
  const elapsed   = _tap3AtMs - _tap1AtMs;
  const deviation = Math.abs(elapsed - IDEAL_BACKSWING_MS);
  const quality   = Math.max(0, 1 - deviation / SCATTER_QUALITY_WINDOW);

  // Lerp: quality=1 → MIN_SCATTER, quality=0 → MAX_SCATTER
  let scatter = MIN_SCATTER_TILES + (1 - quality) * (MAX_SCATTER_TILES - MIN_SCATTER_TILES);

  // D-052: mismatched lure weight doubles the scatter circle.
  // No distance penalty, no forced Bird's Nest (D-052 is accuracy-only).
  if (_isLureWeightMismatched()) {
    scatter = Math.min(MAX_SCATTER_TILES, scatter * MISMATCH_SCATTER_MULTIPLIER);
  }

  return scatter;
}

/**
 * Compute the wind-mitigation factor based on how well the player matched the
 * Tap2→Tap4 window duration to the Tap1→Tap3 backswing duration.
 *
 * D-014: "duration match vs Tap1→Tap3 sets mitigation 0..1, perfect = 80% wind reduction"
 *
 * @returns {number} mitigation factor in [0, 1]
 */
function _computeMitigationFactor() {
  const reference = _tap3AtMs - _tap1AtMs;  // backswing window
  const window    = _tap4AtMs - _tap2AtMs;  // player's mitigation window
  const deviation = Math.abs(window - reference);

  return Math.max(0, 1 - deviation / MITIGATION_MATCH_WINDOW_MS);
}

/**
 * Returns true if the first lure in the active loadout is outside the rated
 * weight range of the first rod in the active loadout (D-052).
 *
 * Falls back to false on any error (missing data, catalog miss) so a missing
 * loadout entry never crashes the cast.
 *
 * @returns {boolean}
 */
function _isLureWeightMismatched() {
  try {
    const state        = stateStore.getState();
    const activeTackle = state.tournament?.activeTackle ?? state.hub?.activeTackle;
    if (!activeTackle) return false;

    const rodEntry  = activeTackle.rods?.[0];
    const lureEntry = activeTackle.lures?.[0];
    if (!rodEntry || !lureEntry) return false;

    const rodDef  = equipment.getRod(rodEntry.id);
    const lureDef = equipment.getLure(lureEntry.id);
    const w       = lureDef.weightOz;
    const range   = rodDef.lureWeightRangeOz;

    return w < range.min || w > range.max;
  } catch {
    return false;
  }
}

/**
 * Determine the splash kind from the current scatter accuracy (D-014, D-038).
 *
 * accuracy = 1 − clamp(scatterRadius / MAX_SCATTER_TILES, 0, 1)
 * SILENT (accuracy > 0.75) → spook +0
 * NORMAL (accuracy ≥ 0.35) → spook +1
 * LOUD   (accuracy < 0.35) → spook +3
 *
 * @returns {'SILENT'|'NORMAL'|'LOUD'}
 */
function _determineSplashKind() {
  const accuracy = 1 - Math.min(1, _scatterRadius / MAX_SCATTER_TILES);
  if (accuracy > SPLASH_SILENT_THRESHOLD) return 'SILENT';
  if (accuracy >= SPLASH_NORMAL_THRESHOLD) return 'NORMAL';
  return 'LOUD';
}

// ---------------------------------------------------------------------------
// Landing offset computation (D-011, D-012, D-016)
// ---------------------------------------------------------------------------

/**
 * Compute the final landing offset in POI-frame coordinates.
 *
 * D-011: Target offset anchored at TARGET_LOCKED; boat drift during flight
 *        does NOT shift the landing target. Wind does (D-012).
 * D-012: Wind vector was sampled at TARGET_LOCKED and held constant.
 * D-016: If the computed landing exceeds frameRadius, it is clamped to the
 *        boundary (the lure drops straight down at the spool wall).
 *
 * @param {number} frameRadius — the active POI's frameRadius in tiles
 * @returns {{ dx: number, dy: number }} landing offset in POI frame
 */
function _computeLanding(frameRadius) {
  const rngStream = _getRng();

  // ── Wind drift ────────────────────────────────────────────────────────────
  // windReduction = mitigationFactor × 0.80 (D-014: perfect = 80%, not 100%)
  const windStrength  = (_windAtCast.intensityMs ?? 0) * WIND_DRIFT_SCALE;
  const windReduction = _mitigationFactor * 0.80;
  const effectiveWind = windStrength * (1 - windReduction);

  const windDrift = {
    dx: (_windAtCast.dx ?? 0) * effectiveWind,
    dy: (_windAtCast.dy ?? 0) * effectiveWind,
  };

  // ── Random scatter within scatter circle ──────────────────────────────────
  const scatterAngle = rngStream.next() * 2 * Math.PI;
  const scatterMag   = rngStream.next() * _scatterRadius;

  const scatter = {
    dx: Math.cos(scatterAngle) * scatterMag,
    dy: Math.sin(scatterAngle) * scatterMag,
  };

  // ── Raw landing = target + wind drift + scatter ───────────────────────────
  const landing = {
    dx: (_target.offset.dx ?? 0) + windDrift.dx + scatter.dx,
    dy: (_target.offset.dy ?? 0) + windDrift.dy + scatter.dy,
  };

  // ── D-016 Spool Wall — clamp to frameRadius ───────────────────────────────
  const dist = Math.hypot(landing.dx, landing.dy);
  if (dist > frameRadius) {
    const scale = frameRadius / dist;
    landing.dx *= scale;
    landing.dy *= scale;
  }

  return landing;
}

/**
 * Resolve the active POI's frameRadius from the POI graph.
 * Falls back to 10 if the POI is unknown (defensive default).
 *
 * @returns {number}
 */
function _getFrameRadius() {
  try {
    const poiId = stateStore.getState().session?.player?.currentPoiId ?? _target?.poiId;
    if (!poiId) return 10;
    const poi = poiGraph.getPoi(poiId);
    return poi?.frameRadius ?? 10;
  } catch {
    return 10;
  }
}

/**
 * Resolve the center coordinate of the active POI.
 * Returns null if unavailable.
 *
 * @returns {{ x: number, y: number } | null}
 */
function _getPoiCenter() {
  try {
    const poiId = stateStore.getState().session?.player?.currentPoiId ?? _target?.poiId;
    if (!poiId) return null;
    const poi = poiGraph.getPoi(poiId);
    return poi?.centerCoord ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

/**
 * TARGET_LOCKED handler (emitted by targetSelector after player confirms).
 *
 * D-011: anchors the cast target in POI-frame coordinates.
 * D-012: samples and holds the wind vector for the entire cast flight.
 * D-043: sets state.tournament.scanLocked so fishFinder blocks new scans.
 *
 * Transitions FSM from IDLE → BACKSWING.
 * Starts the Bird's Nest inter-tap timer.
 *
 * @param {{ poiId:string, offset:{dx:number,dy:number}, candidateId:string,
 *           lockedAtMs:number, finderTier:string }} evt
 */
function _onTargetLocked(evt) {
  if (_phase !== 'IDLE') {
    // Already mid-cast: a second TARGET_LOCKED is ignored.
    // (Should not normally occur — scanLocked blocks new scans while casting.)
    console.warn('[castPipeline] TARGET_LOCKED received mid-cast; ignoring.');
    return;
  }

  const atMs = evt.lockedAtMs ?? clock.nowMs();

  // D-011: anchor target coordinates.
  _target = {
    poiId:       evt.poiId,
    offset:      { dx: evt.offset?.dx ?? 0, dy: evt.offset?.dy ?? 0 },
    candidateId: evt.candidateId,
    finderTier:  evt.finderTier,
  };

  // D-012: sample wind vector at this exact moment; hold for full flight.
  const windSample = wind.sample(atMs);
  _windAtCast = {
    dx:          windSample.dx,
    dy:          windSample.dy,
    intensityMs: windSample.intensityMs,
  };

  // D-043: lock out scanning while cast is in progress.
  stateStore.dispatch({ type: 'SCAN_LOCKED' });

  // Transition to BACKSWING and announce to state/audio.
  _phase = 'BACKSWING';
  _dispatchPhase({ phase: 'BACKSWING', target: _target, atMs });

  // Start inter-tap timer (Bird's Nest if Tap 1 doesn't arrive in time).
  _scheduleBirdNest();
}

/**
 * Arrow tap handler (Taps 1, 3, 5 in the D-014 sequence).
 * Accepts any arrow direction: ARROW_UP, ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT.
 *
 * @param {{ atMs?: number }} evt
 */
function _onArrow(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  switch (_phase) {

    // ── Tap 1: Backswing ───────────────────────────────────────────────────
    case 'BACKSWING': {
      _cancelBirdNest();
      _tap1AtMs = atMs;
      _phase    = 'POWER';
      _dispatchPhase({ phase: 'POWER', tap1AtMs: _tap1AtMs, atMs });
      _scheduleBirdNest();
      break;
    }

    // ── Tap 3: Apex — sets scatter circle radius ───────────────────────────
    case 'APEX': {
      _cancelBirdNest();
      _tap3AtMs      = atMs;
      _scatterRadius = _computeScatterRadius();
      _phase         = 'RELEASE';
      _dispatchPhase({
        phase:         'RELEASE',
        tap3AtMs:      _tap3AtMs,
        scatterRadius: _scatterRadius,
        atMs,
      });
      _scheduleBirdNest();
      break;
    }

    // ── Tap 5: Splashdown — compute and apply landing ──────────────────────
    case 'SPLASHDOWN': {
      _cancelBirdNest();

      const frameRadius = _getFrameRadius();
      const landing     = _computeLanding(frameRadius);
      const splashKind  = _determineSplashKind();

      // Apply spook to the landing tile (H-003: sole write path through castSpookModel).
      const poiCenter = _getPoiCenter();
      if (poiCenter) {
        const tileCoord = {
          x: poiCenter.x + Math.round(landing.dx),
          y: poiCenter.y + Math.round(landing.dy),
        };
        castSpookModel.applySplash(tileCoord, splashKind, atMs);
      }

      // Emit CAST_LANDED for downstream consumers (fishBehavior Phase 6, pressureModel).
      bus.emit('CAST_LANDED', {
        poiId:            _target.poiId,
        candidateId:      _target.candidateId,
        finderTier:       _target.finderTier,
        landing,
        target:           { ..._target.offset },
        splashKind,
        scatterRadius:    _scatterRadius,
        mitigationFactor: _mitigationFactor,
        atMs,
      });

      _resetToIdle();
      break;
    }

    default:
      // Not in an arrow-expecting phase — ignore (no-op).
      break;
  }
}

/**
 * Spacebar tap handler (Taps 2 and 4 in the D-014 sequence).
 *
 * @param {{ atMs?: number }} evt
 */
function _onSpacebar(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  switch (_phase) {

    // ── Tap 2: Open Wind Mitigation timer ─────────────────────────────────
    case 'POWER': {
      _cancelBirdNest();
      _tap2AtMs = atMs;
      _phase    = 'APEX';
      _dispatchPhase({ phase: 'APEX', tap2AtMs: _tap2AtMs, atMs });
      _scheduleBirdNest();
      break;
    }

    // ── Tap 4: Close Wind Mitigation timer — compute mitigation ───────────
    case 'RELEASE': {
      _cancelBirdNest();
      _tap4AtMs         = atMs;
      _mitigationFactor = _computeMitigationFactor();
      _phase            = 'SPLASHDOWN';
      _dispatchPhase({
        phase:            'SPLASHDOWN',
        tap4AtMs:         _tap4AtMs,
        mitigationFactor: _mitigationFactor,
        atMs,
      });
      _scheduleBirdNest();
      break;
    }

    default:
      // Not in a spacebar-expecting phase — ignore (no-op).
      break;
  }
}

// ---------------------------------------------------------------------------
// Mount manifest (H-005)
// ---------------------------------------------------------------------------

modeRouter.registerMountManifest({
  id:    'castPipeline',
  modes: ['TOURNAMENT_ACTIVE'],

  /**
   * Acquire bus subscriptions and reset state when entering TOURNAMENT_ACTIVE.
   *
   * The _castRng stream is intentionally NOT reset here — it persists across
   * multiple casts within a tournament for RNG continuity (§5d). The global
   * seed is set once by engine.boot() before any cast can occur.
   */
  onMount(_nextMode, _prevMode) {
    // Ensure clean slate on entry (defensive: covers re-entry after TOURNAMENT_RESULTS).
    _phase            = 'IDLE';
    _target           = null;
    _windAtCast       = null;
    _tap1AtMs         = null;
    _tap2AtMs         = null;
    _tap3AtMs         = null;
    _tap4AtMs         = null;
    _scatterRadius    = 0;
    _mitigationFactor = 0;
    _nestHandle       = null;

    _unsubs = [
      // TARGET_LOCKED from targetSelector — the Tap-1 anchor trigger (D-041).
      bus.on('TARGET_LOCKED',      _onTargetLocked),

      // Arrow taps: Tap 1 (Backswing), Tap 3 (Apex), Tap 5 (Splashdown).
      bus.on('INPUT_ARROW_UP',     _onArrow),
      bus.on('INPUT_ARROW_DOWN',   _onArrow),
      bus.on('INPUT_ARROW_LEFT',   _onArrow),
      bus.on('INPUT_ARROW_RIGHT',  _onArrow),

      // Spacebar taps: Tap 2 (open Wind Mitigation), Tap 4 (close Wind Mitigation).
      bus.on('INPUT_SPACEBAR',     _onSpacebar),
    ];
  },

  /**
   * Release all bus subscriptions and clock handles when leaving TOURNAMENT_ACTIVE.
   *
   * H-005: every handle acquired in onMount is cancelled here.
   * D-043: if we are mid-cast when unmounted, SCAN_UNLOCKED is dispatched
   *        so the scan lock does not persist into the next mode.
   */
  onUnmount(_prevMode, _nextMode) {
    // Cancel Bird's Nest timer first (before _resetToIdle clears _nestHandle).
    _cancelBirdNest();

    // Release bus subscriptions.
    for (const unsub of _unsubs) unsub();
    _unsubs = [];

    // Reset state and unlock scan if mid-cast.
    _resetToIdle();
  },
});
