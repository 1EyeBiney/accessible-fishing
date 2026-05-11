/**
 * AFish Fish Behavior — src/fish/fishBehavior.js
 *
 * Public API Contract (§9 — FISH):
 *   evaluateStrike(castSpec)                        → { hit, speciesId?, fishInstance? }
 *   scheduleBite(fishInstance, castSpec)            → { cancel() }
 *   cancelBite(handle)                              → void
 *   advanceFight(fightState, inputs, dt)            → { stamina, phase, pullForce }
 *   readPressure(coord, atMs)                       → number  [0..MAX_PRESSURE]
 *   applyPressureEvent(coord, kind, atMs)           → void
 *   recordLureRejection(coord, lureId, atMs)        → void
 *   SPECIES_CATALOG                                  — frozen species definitions
 *   MAX_PRESSURE                                     — locked constant (D-039)
 *   PRESSURE_DECAY_MS_PER_LEVEL                      — locked constant (D-039)
 *   PRESSURE_STRIKE_PENALTY                          — locked constant (D-039)
 *
 * Decisions implemented:
 *   D-032 — Dynamic nibble count per species intelligence + mood + environment.
 *   D-033 — Hookset Trap: NIBBLE_WINDOW blocks input; BITE_THUD opens HOOKSET_WINDOW.
 *            Window width computed here; fightLoop handles input detection.
 *   D-039 — Pressure / Fished-Out (LOCKED math): compute-on-read.
 *            MAX_PRESSURE=5, PRESSURE_DECAY_MS_PER_LEVEL=90000.
 *            CAST+1, HOOKSET+1, CATCH+1.
 *   D-044 — Fish Species schema (all fields). Seven day-one species.
 *   D-047 — All 5 fight styles: BULLDOG, RUNNER, JUMPER, DIVER, THRASHER.
 *   D-048 — Presentation preferences hand-curated per species (NOT matrix-derived).
 *   D-049 — Lure memory time-decay: rejected lures forgotten after 60 in-game seconds.
 *   D-050 — Hookset window floor: 300ms hard floor (LOCKED).
 *   D-053 — Diurnal multipliers hand-tuned per species (DAWN/DAY/DUSK/NIGHT).
 *
 * H-013 compliance:
 *   Pressure and Spook are ORTHOGONAL — separate state fields, separate decay rates,
 *   separate exports. They are NEVER merged into a single counter.
 *
 * Lifecycle:
 *   Mounted in TOURNAMENT_ACTIVE via modeRouter mount manifest.
 *   onMount:   create RNG stream, populate tile occupancy, subscribe to CAST_LANDED.
 *   onUnmount: cancel pending bite clock handles, cancel bus subscriptions.
 *
 * Events emitted:
 *   BITE_NIBBLE       { fishId, speciesId, nibbleIndex, totalNibbles, poiId, atMs }
 *   BITE_THUD         { fishInstance, hooksetWindowMs, castSpec, atMs }
 *   BITE_CANCELLED    { reason, speciesId, poiId, lureId, atMs }
 *   PRESSURE_APPLIED  { coord, kind, increment, storedLevel, atMs }
 *
 * Events consumed:
 *   CAST_LANDED — triggers evaluateStrike → scheduleBite pipeline
 */

import * as bus            from '../core/eventBus.js';
import * as clock          from '../core/clock.js';
import * as rng            from '../core/rng.js';
import * as stateStore     from '../core/stateStore.js';
import * as modeRouter     from '../core/modeRouter.js';
import * as worldMap       from '../world/worldMap.js';
import * as poiGraph       from '../world/poiGraph.js';
import * as structureIndex from '../world/structureIndex.js';
import * as equipment      from '../equipment/equipment.js';
import * as castSpookModel from '../casting/castSpookModel.js';

// ===========================================================================
// Constants — Pressure Model (D-039, LOCKED)
// ===========================================================================

/** Maximum storable pressure level (D-039, LOCKED). */
export const MAX_PRESSURE = 5;

/** In-game milliseconds required for one stored pressure level to decay (D-039, LOCKED). */
export const PRESSURE_DECAY_MS_PER_LEVEL = 90_000;

/**
 * Maximum fraction of strike probability removed at full pressure (D-039, LOCKED).
 * Leaves a "stubborn fish" floor — never reduces P to zero.
 */
export const PRESSURE_STRIKE_PENALTY = 0.6;

/**
 * Pressure increments per event kind (D-039, LOCKED).
 * CAST+1 on every splashdown, HOOKSET+1 on every hookset attempt, CATCH+1 on land.
 * Full success cycle (cast → hookset → catch) = +3 total.
 * @readonly
 */
const PRESSURE_INCREMENTS = Object.freeze({
  CAST:    1,
  HOOKSET: 1,
  CATCH:   1,
});

// ===========================================================================
// Constants — Bite / Hookset (D-032, D-033, D-050)
// ===========================================================================

/** Baseline hookset window in ms before intelligence shrinkage (D-033). */
const HOOKSET_WINDOW_BASELINE_MS = 750;

/** Hard floor for hookset window width (D-050, LOCKED). */
const HOOKSET_WINDOW_FLOOR_MS = 300;

/** Rejected lure is forgotten after this many in-game ms (D-049, LOCKED). */
const LURE_MEMORY_DECAY_MS = 60_000;

/**
 * Strike-probability multiplier applied when a lure has been recently rejected
 * at the same tile. Near-zero to strongly discourage the same lure. (D-049)
 */
const LURE_REJECTION_PENALTY = 0.05;

/** Minimum delay between nibbles / before the thud, in ms. */
const NIBBLE_INTERVAL_MIN_MS = 700;

/** Maximum delay between nibbles / before the thud, in ms. */
const NIBBLE_INTERVAL_MAX_MS = 2_000;

// ===========================================================================
// Constants — Diurnal Period Boundaries
// Tournament clock t=0 corresponds to first light (dawn).
// One full in-game day = 86 400 000 ms.
// ===========================================================================

const DAY_MS      = 86_400_000;
const DAWN_END_MS = 10_800_000;  // 0 h – 3 h
const DAY_END_MS  = 54_000_000;  // 3 h – 15 h
const DUSK_END_MS = 64_800_000;  // 15 h – 18 h
// NIGHT          : 18 h – 24 h

// ===========================================================================
// Species Catalog (D-044, D-047, D-048, D-053)
// ===========================================================================
//
// Schema per species entry (D-044):
//   id, speciesBand, preySizeBand,
//   wariness          [0,1] — baseline resistance to approaching a lure
//   intelligence      [0,1] — affects nibble count, hookset window width, lure memory
//   moodVolatility    [0,1] — RNG range of the per-bite mood roll
//   nibbleBand        { min, max } — base nibble count range before intelligence bonus
//   habitat           { depthAffinityM, bottomAffinity[], coverAffinity[], tagAffinity[] }
//   presentationPreferences { preferred[], tolerated[], rejected[] }
//   diurnal           { DAWN, DAY, DUSK, NIGHT } — strike multipliers (D-053)
//   stamina           [0,1] — initial fight stamina
//   fightStyle        'BULLDOG'|'RUNNER'|'JUMPER'|'DIVER'|'THRASHER' (D-047)
//   pullForceCurve    8-element array: pull force at exhaustion 0%→100%
//   tensionMultipliers { running, jumping, diving }
//   mouthHardness     [0,1] — harder = less hookset feedback, bigger window shrink
//   hookRetention     [0,1] — higher = fish stays on hook better during fight
//   weight            { mu, sigma } — lognormal parameters (kg)
//   audio             { hookToken, fightToken, landedToken }
//
// All entries are deeply frozen post-construction.

/** @type {Readonly<Record<string, Readonly<object>>>} */
export const SPECIES_CATALOG = Object.freeze({

  // ─── LARGEMOUTH BASS ────────────────────────────────────────────────────────
  // The flagship target. Aggressive, cover-oriented, explosive short-range fighter.
  // Prefers warm, shallow, weedy water. Highly volatile mood — will commit suddenly.
  LARGEMOUTH_BASS: Object.freeze({
    id:             'LARGEMOUTH_BASS',
    speciesBand:    'BASS',
    preySizeBand:   'MEDIUM',
    wariness:       0.55,
    intelligence:   0.60,
    moodVolatility: 0.75,
    nibbleBand:     Object.freeze({ min: 1, max: 3 }),
    habitat: Object.freeze({
      depthAffinityM: 2.0,
      bottomAffinity: Object.freeze(['MUD', 'GRAVEL']),
      coverAffinity:  Object.freeze(['WEEDBED', 'BRUSHPILE', 'TIMBER', 'DOCK', 'LILYPADS']),
      tagAffinity:    Object.freeze(['AMBUSH_POINT', 'WEEDBED_EDGE', 'TIMBER_EDGE', 'SHADED_DAY']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['CRANKBAIT', 'JIG', 'WORM', 'SPINNERBAIT']),
      tolerated: Object.freeze(['TOPWATER', 'SWIMBAIT', 'JERKBAIT', 'LIVE_BAIT']),
      rejected:  Object.freeze([]),
    }),
    // Diurnal: excellent at dawn and dusk, slower midday (D-053, hand-tuned).
    diurnal: Object.freeze({ DAWN: 1.30, DAY: 0.75, DUSK: 1.45, NIGHT: 1.05 }),
    stamina:    0.80,
    fightStyle: 'BULLDOG',
    // pullForceCurve: 8 values at exhaustion 0%→87.5% (last bucket = near-zero).
    pullForceCurve: Object.freeze([0.95, 0.90, 0.85, 0.75, 0.58, 0.40, 0.22, 0.10]),
    tensionMultipliers: Object.freeze({ running: 0.90, jumping: 1.80, diving: 1.20 }),
    mouthHardness:  0.50,
    hookRetention:  0.78,
    weight: Object.freeze({ mu: 0.85, sigma: 0.55 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_HARD',
      fightToken:  'FISH_FIGHT_BASS_BULLDOG',
      landedToken: 'FISH_LANDED_BASS',
    }),
  }),

  // ─── SMALLMOUTH BASS ────────────────────────────────────────────────────────
  // Technical finesse target. Cold, clear, rocky water specialist.
  // Explosive runner — tires quickly, then may surge again. Rejects live bait.
  SMALLMOUTH_BASS: Object.freeze({
    id:             'SMALLMOUTH_BASS',
    speciesBand:    'BASS',
    preySizeBand:   'SMALL',
    wariness:       0.70,
    intelligence:   0.72,
    moodVolatility: 0.80,
    nibbleBand:     Object.freeze({ min: 1, max: 2 }),
    habitat: Object.freeze({
      depthAffinityM: 3.5,
      bottomAffinity: Object.freeze(['GRAVEL', 'ROCK']),
      coverAffinity:  Object.freeze(['ROCKPILE', 'TIMBER', 'BRUSHPILE', 'OVERHANG']),
      tagAffinity:    Object.freeze(['DROP_OFF_EDGE', 'POINT', 'TRANSITION']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['JIG', 'SWIMBAIT', 'JERKBAIT', 'SPOON']),
      tolerated: Object.freeze(['CRANKBAIT', 'SPINNERBAIT', 'WORM']),
      rejected:  Object.freeze(['LIVE_BAIT']),
    }),
    diurnal: Object.freeze({ DAWN: 1.20, DAY: 1.10, DUSK: 1.35, NIGHT: 0.65 }),
    stamina:    0.90,
    fightStyle: 'RUNNER',
    pullForceCurve: Object.freeze([1.00, 0.95, 0.90, 0.85, 0.75, 0.60, 0.40, 0.15]),
    tensionMultipliers: Object.freeze({ running: 1.50, jumping: 1.40, diving: 0.80 }),
    mouthHardness:  0.60,
    hookRetention:  0.82,
    weight: Object.freeze({ mu: 0.65, sigma: 0.45 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_HARD',
      fightToken:  'FISH_FIGHT_BASS_RUNNER',
      landedToken: 'FISH_LANDED_BASS',
    }),
  }),

  // ─── SPOTTED BASS ───────────────────────────────────────────────────────────
  // Between LM and SM in character. Rocky-ledge specialist, unpredictable mood swings.
  SPOTTED_BASS: Object.freeze({
    id:             'SPOTTED_BASS',
    speciesBand:    'BASS',
    preySizeBand:   'SMALL',
    wariness:       0.60,
    intelligence:   0.65,
    moodVolatility: 0.70,
    nibbleBand:     Object.freeze({ min: 1, max: 3 }),
    habitat: Object.freeze({
      depthAffinityM: 2.5,
      bottomAffinity: Object.freeze(['GRAVEL', 'ROCK', 'SAND']),
      coverAffinity:  Object.freeze(['TIMBER', 'ROCKPILE', 'WEEDBED', 'BRUSHPILE']),
      tagAffinity:    Object.freeze(['POINT', 'DROP_OFF_EDGE', 'AMBUSH_POINT', 'TRANSITION']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['JIG', 'CRANKBAIT', 'JERKBAIT']),
      tolerated: Object.freeze(['WORM', 'SPINNERBAIT', 'SWIMBAIT', 'TOPWATER']),
      rejected:  Object.freeze([]),
    }),
    diurnal: Object.freeze({ DAWN: 1.25, DAY: 0.85, DUSK: 1.35, NIGHT: 0.90 }),
    stamina:    0.85,
    fightStyle: 'RUNNER',
    pullForceCurve: Object.freeze([0.90, 0.88, 0.84, 0.78, 0.65, 0.45, 0.28, 0.12]),
    tensionMultipliers: Object.freeze({ running: 1.30, jumping: 1.50, diving: 1.00 }),
    mouthHardness:  0.55,
    hookRetention:  0.80,
    weight: Object.freeze({ mu: 0.55, sigma: 0.40 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_MEDIUM',
      fightToken:  'FISH_FIGHT_BASS_RUNNER',
      landedToken: 'FISH_LANDED_BASS',
    }),
  }),

  // ─── BLUEGILL ───────────────────────────────────────────────────────────────
  // Abundant, forgiving panfish. Many nibbles. Strong daylight feeder.
  // Great for beginners; gives audio-feedback-rich bites.
  BLUEGILL: Object.freeze({
    id:             'BLUEGILL',
    speciesBand:    'PANFISH',
    preySizeBand:   'TINY',
    wariness:       0.25,
    intelligence:   0.30,
    moodVolatility: 0.60,
    nibbleBand:     Object.freeze({ min: 2, max: 5 }),
    habitat: Object.freeze({
      depthAffinityM: 1.0,
      bottomAffinity: Object.freeze(['MUD', 'SAND']),
      coverAffinity:  Object.freeze(['WEEDBED', 'LILYPADS', 'DOCK', 'BRUSHPILE']),
      tagAffinity:    Object.freeze(['WEEDBED_INNER', 'WEEDBED_EDGE', 'SHADED_DAY']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['WORM', 'LIVE_BAIT', 'JIG']),
      tolerated: Object.freeze(['SPOON', 'TOPWATER']),
      rejected:  Object.freeze(['CRANKBAIT', 'SWIMBAIT', 'SPINNERBAIT']),
    }),
    diurnal: Object.freeze({ DAWN: 1.10, DAY: 1.20, DUSK: 1.15, NIGHT: 0.50 }),
    stamina:    0.50,
    fightStyle: 'THRASHER',
    pullForceCurve: Object.freeze([0.50, 0.45, 0.40, 0.32, 0.24, 0.16, 0.08, 0.03]),
    tensionMultipliers: Object.freeze({ running: 0.60, jumping: 0.50, diving: 0.40 }),
    mouthHardness:  0.25,
    hookRetention:  0.65,
    weight: Object.freeze({ mu: -1.20, sigma: 0.30 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_SOFT',
      fightToken:  'FISH_FIGHT_PANFISH',
      landedToken: 'FISH_LANDED_SMALL',
    }),
  }),

  // ─── RAINBOW TROUT ──────────────────────────────────────────────────────────
  // Technical, clear-water, cold-water specialist. Spectacular aerial fighter.
  // Extremely wary. Dawn/dusk peak only. Rejects topwater and warm-water plastics.
  RAINBOW_TROUT: Object.freeze({
    id:             'RAINBOW_TROUT',
    speciesBand:    'TROUT',
    preySizeBand:   'SMALL',
    wariness:       0.82,
    intelligence:   0.78,
    moodVolatility: 0.55,
    nibbleBand:     Object.freeze({ min: 1, max: 2 }),
    habitat: Object.freeze({
      depthAffinityM: 4.0,
      bottomAffinity: Object.freeze(['ROCK', 'GRAVEL']),
      coverAffinity:  Object.freeze(['OVERHANG', 'TIMBER', 'ROCKPILE']),
      tagAffinity:    Object.freeze(['SHADED_DAY', 'DROP_OFF_EDGE', 'TRANSITION']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['SPOON', 'JERKBAIT', 'SPINNERBAIT', 'LIVE_BAIT']),
      tolerated: Object.freeze(['JIG', 'SWIMBAIT']),
      rejected:  Object.freeze(['TOPWATER', 'WORM', 'CRANKBAIT']),
    }),
    diurnal: Object.freeze({ DAWN: 1.55, DAY: 0.55, DUSK: 1.50, NIGHT: 0.40 }),
    stamina:    0.88,
    fightStyle: 'JUMPER',
    pullForceCurve: Object.freeze([0.85, 0.82, 0.78, 0.72, 0.62, 0.48, 0.28, 0.10]),
    tensionMultipliers: Object.freeze({ running: 1.10, jumping: 2.20, diving: 0.90 }),
    mouthHardness:  0.35,
    hookRetention:  0.70,
    weight: Object.freeze({ mu: 0.75, sigma: 0.50 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_MEDIUM',
      fightToken:  'FISH_FIGHT_TROUT_JUMPER',
      landedToken: 'FISH_LANDED_TROUT',
    }),
  }),

  // ─── CATFISH ────────────────────────────────────────────────────────────────
  // Nocturnal bottom-feeder. Slow, relentless bulldogger. Night trophy potential.
  // Not wary at all — but almost never active in daylight.
  CATFISH: Object.freeze({
    id:             'CATFISH',
    speciesBand:    'CATFISH',
    preySizeBand:   'LARGE',
    wariness:       0.30,
    intelligence:   0.40,
    moodVolatility: 0.45,
    nibbleBand:     Object.freeze({ min: 1, max: 2 }),
    habitat: Object.freeze({
      depthAffinityM: 5.0,
      bottomAffinity: Object.freeze(['MUD', 'SAND']),
      coverAffinity:  Object.freeze(['BRUSHPILE', 'TIMBER', 'NONE']),
      tagAffinity:    Object.freeze(['DROP_OFF_EDGE', 'TIMBER_INNER', 'OPEN_FLAT']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['LIVE_BAIT', 'WORM', 'JIG']),
      tolerated: Object.freeze(['SPINNERBAIT']),
      rejected:  Object.freeze(['TOPWATER', 'CRANKBAIT', 'JERKBAIT', 'SPOON']),
    }),
    diurnal: Object.freeze({ DAWN: 0.80, DAY: 0.30, DUSK: 0.90, NIGHT: 1.60 }),
    stamina:    0.95,
    fightStyle: 'BULLDOG',
    pullForceCurve: Object.freeze([1.00, 0.98, 0.95, 0.90, 0.82, 0.70, 0.55, 0.35]),
    tensionMultipliers: Object.freeze({ running: 0.70, jumping: 0.20, diving: 1.60 }),
    mouthHardness:  0.75,
    hookRetention:  0.88,
    weight: Object.freeze({ mu: 1.20, sigma: 0.65 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_HARD',
      fightToken:  'FISH_FIGHT_CATFISH_BULLDOG',
      landedToken: 'FISH_LANDED_LARGE',
    }),
  }),

  // ─── CRAPPIE ────────────────────────────────────────────────────────────────
  // Schooling panfish. Finesse presentations; dock and timber specialist.
  // Multiple nibbles, light mouth — easy to pull the hook on. Great for volume fishing.
  CRAPPIE: Object.freeze({
    id:             'CRAPPIE',
    speciesBand:    'PANFISH',
    preySizeBand:   'TINY',
    wariness:       0.55,
    intelligence:   0.50,
    moodVolatility: 0.65,
    nibbleBand:     Object.freeze({ min: 2, max: 4 }),
    habitat: Object.freeze({
      depthAffinityM: 2.0,
      bottomAffinity: Object.freeze(['MUD', 'SAND', 'GRAVEL']),
      coverAffinity:  Object.freeze(['BRUSHPILE', 'TIMBER', 'DOCK', 'WEEDBED']),
      tagAffinity:    Object.freeze(['TIMBER_EDGE', 'TIMBER_INNER', 'SHADED_DAY', 'AMBUSH_POINT']),
    }),
    presentationPreferences: Object.freeze({
      preferred: Object.freeze(['JIG', 'SPOON', 'LIVE_BAIT']),
      tolerated: Object.freeze(['CRANKBAIT', 'SWIMBAIT', 'TOPWATER', 'WORM']),
      rejected:  Object.freeze([]),
    }),
    diurnal: Object.freeze({ DAWN: 1.20, DAY: 0.90, DUSK: 1.25, NIGHT: 0.80 }),
    stamina:    0.60,
    fightStyle: 'THRASHER',
    pullForceCurve: Object.freeze([0.60, 0.55, 0.50, 0.40, 0.30, 0.20, 0.10, 0.05]),
    tensionMultipliers: Object.freeze({ running: 0.70, jumping: 0.80, diving: 0.60 }),
    mouthHardness:  0.30,
    hookRetention:  0.68,
    weight: Object.freeze({ mu: -0.40, sigma: 0.30 }),
    audio: Object.freeze({
      hookToken:   'FISH_HOOK_THUD_SOFT',
      fightToken:  'FISH_FIGHT_PANFISH',
      landedToken: 'FISH_LANDED_SMALL',
    }),
  }),
});

// ===========================================================================
// Module state
// ===========================================================================

/**
 * Named RNG stream, created fresh on each TOURNAMENT_ACTIVE mount (H-015).
 * @type {{ next():number, int(min,max):number, lognormal(mu,sigma):number, bool(p):boolean }|null}
 */
let _fishStream = null;

/** Bus unsubscribe handles, cleared in onUnmount. @type {Function[]} */
const _unsubs = [];

/**
 * Active bite sequences keyed by fishInstance.id.
 * @type {Map<string, { cancel(): void }>}
 */
const _activeBites = new Map();

/**
 * Per-tile lure rejection memory (D-049).
 * Map<coordKey, Array<{ lureId: string, rejectedAtMs: number }>>
 * @type {Map<string, Array<{lureId:string, rejectedAtMs:number}>>}
 */
const _lureMemory = new Map();

/** Monotonically increasing counter for fish instance IDs. */
let _fishIdCounter = 1;

// ===========================================================================
// Pressure Model (D-039, LOCKED)
// ===========================================================================

/**
 * Compute-on-read: current effective pressure at a tile for the given time.
 *
 * Formula (D-039, LOCKED):
 *   currentPressure = max(0, storedLevel − floor((atMs − updatedAtMs) / 90 000))
 *
 * Returns 0 for unknown tiles or tiles with no pressure state.
 *
 * @param {{ x: number, y: number } | string} coord
 * @param {number} atMs
 * @returns {number} integer in [0, MAX_PRESSURE]
 */
export function readPressure(coord, atMs) {
  const tile = worldMap.getTile(coord);
  if (!tile) return 0;
  const p = tile.state?.pressure;
  if (!p || typeof p.level !== 'number') return 0;
  const decayed = Math.floor((atMs - p.updatedAtMs) / PRESSURE_DECAY_MS_PER_LEVEL);
  return Math.max(0, p.level - decayed);
}

/**
 * Apply a pressure event to a tile. Writes tile.state.pressure. Emits PRESSURE_APPLIED.
 *
 * @param {{ x: number, y: number } | string} coord
 * @param {'CAST'|'HOOKSET'|'CATCH'} kind
 * @param {number} atMs
 */
export function applyPressureEvent(coord, kind, atMs) {
  const tile = worldMap.getTile(coord);
  if (!tile) return;

  const increment = PRESSURE_INCREMENTS[kind];
  if (increment === undefined) {
    console.warn(`[fishBehavior] applyPressureEvent: unknown kind "${kind}"`);
    return;
  }

  const currentLevel = readPressure(coord, atMs);
  const newLevel     = Math.min(MAX_PRESSURE, currentLevel + increment);

  worldMap.mutateTileState(coord, state => ({
    ...state,
    pressure: {
      level:         newLevel,
      updatedAtMs:   atMs,
      lastCastAtMs:  kind === 'CAST'  ? atMs : (state.pressure?.lastCastAtMs  ?? 0),
      lastCatchAtMs: kind === 'CATCH' ? atMs : (state.pressure?.lastCatchAtMs ?? 0),
    },
  }));

  bus.emit('PRESSURE_APPLIED', { coord, kind, increment, storedLevel: newLevel, atMs });
}

// ===========================================================================
// Population Model — tile occupancy
// ===========================================================================

/**
 * Return the diurnal period for a given tournament-clock time.
 *
 * @param {number} atMs
 * @returns {'DAWN'|'DAY'|'DUSK'|'NIGHT'}
 */
function _diurnalPeriod(atMs) {
  const t = atMs % DAY_MS;
  if (t < DAWN_END_MS) return 'DAWN';
  if (t < DAY_END_MS)  return 'DAY';
  if (t < DUSK_END_MS) return 'DUSK';
  return 'NIGHT';
}

/**
 * Return the diurnal activity multiplier for a species at the given time (D-053).
 *
 * @param {object} species
 * @param {number} atMs
 * @returns {number}
 */
function _diurnalMultiplier(species, atMs) {
  return species.diurnal[_diurnalPeriod(atMs)];
}

/**
 * Compute habitat suitability [0,1] for a species on a given tile.
 * Uses only immutable tile traits — never reads live state (H-014 boundary safe).
 *
 * Component weights:
 *   depth    30%  — decays linearly over ±3m from preferred depth
 *   bottom   20%  — full points if primary bottom matches
 *   cover    30%  — full points if cover type matches
 *   tags     20%  — 10% per matching tag, up to 2 matching tags
 *
 * @param {object} species
 * @param {object} tile
 * @returns {number}
 */
function _habitatSuitability(species, tile) {
  let score = 0;

  const depthDiff = Math.abs(tile.traits.depth.minM - species.habitat.depthAffinityM);
  score += Math.max(0, 1 - depthDiff / 3.0) * 0.30;

  if (species.habitat.bottomAffinity.includes(tile.traits.bottom.primary)) {
    score += 0.20;
  }

  if (species.habitat.coverAffinity.includes(tile.traits.cover.type)) {
    score += 0.30;
  }

  const matchingTags = tile.traits.tags.filter(t =>
    species.habitat.tagAffinity.includes(t)
  );
  score += Math.min(0.20, matchingTags.length * 0.10);

  return Math.min(1.0, score);
}

/**
 * Populate tile.state.occupancy for every tile in every built POI zone.
 * Called once from onMount at the start of TOURNAMENT_ACTIVE.
 *
 * fishCount reflects total cross-species suitability scaled by structureScore.
 * The exact count is stochastic so different seeded runs produce different populations.
 *
 * @param {number} atMs - current tournament clock time
 */
function _populateAllPois(atMs) {
  const poiIds = worldMap.allPoiIds();
  for (const poiId of poiIds) {
    if (!structureIndex.isBuilt(poiId)) continue;
    const candidates = structureIndex.candidatesForPoi(poiId);
    for (const candidate of candidates) {
      const tile = worldMap.getTile(candidate.coord);
      if (!tile) continue;

      let totalSuitability = 0;
      for (const species of Object.values(SPECIES_CATALOG)) {
        totalSuitability += _habitatSuitability(species, tile);
      }

      // totalSuitability ∈ [0, 7] (7 species at max).
      // Scale by structureScore and a uniform RNG roll → fishCount range ≈ 0–8.
      const roll      = _fishStream.next();
      const fishCount = Math.round(
        totalSuitability * candidate.structureScore * 3.5 * (0.5 + roll)
      );

      worldMap.mutateTileState(candidate.coord, state => ({
        ...state,
        occupancy: {
          fishCount:          Math.max(0, fishCount),
          fishCountStaleAtMs: atMs,
        },
      }));
    }
  }
}

// ===========================================================================
// Lure Memory (D-049)
// ===========================================================================

/**
 * Record a lure rejection at the given tile coord.
 * Called by fightLoop when a hookset is missed or BITE_CANCELLED fires.
 *
 * @param {{ x: number, y: number } | string} coord
 * @param {string} lureId
 * @param {number} atMs
 */
export function recordLureRejection(coord, lureId, atMs) {
  const tile = worldMap.getTile(coord);
  if (!tile) return;
  const key = `${tile.coord.x},${tile.coord.y}`;

  let memory = _lureMemory.get(key);
  if (!memory) {
    memory = [];
    _lureMemory.set(key, memory);
  }
  memory.push({ lureId, rejectedAtMs: atMs });

  // Prune stale entries to bound memory growth.
  const cutoff = atMs - LURE_MEMORY_DECAY_MS;
  _lureMemory.set(key, memory.filter(m => m.rejectedAtMs >= cutoff));
}

/**
 * Return the lure-memory penalty factor for casting the given lure at the given tile.
 * Returns LURE_REJECTION_PENALTY if the lure was recently rejected, 1.0 otherwise.
 *
 * @param {string} coordKey - "x,y" string
 * @param {string} lureId
 * @param {number} atMs
 * @returns {number}
 */
function _lureMemoryPenalty(coordKey, lureId, atMs) {
  const memory = _lureMemory.get(coordKey);
  if (!memory) return 1.0;
  const cutoff = atMs - LURE_MEMORY_DECAY_MS;
  const recentRejection = memory.some(
    m => m.lureId === lureId && m.rejectedAtMs >= cutoff
  );
  return recentRejection ? LURE_REJECTION_PENALTY : 1.0;
}

// ===========================================================================
// Strike Model (D-032)
// ===========================================================================

/**
 * Compute the presentation match score between a lure and a species.
 * preferred → 1.0 | tolerated → 0.50 | rejected → 0.05 | unspecified → 0.40
 *
 * @param {object} lureSpec
 * @param {object} species
 * @returns {number}
 */
function _presentationMatch(lureSpec, species) {
  const { preferred, tolerated, rejected } = species.presentationPreferences;
  if (preferred.includes(lureSpec.category)) return 1.00;
  if (tolerated.includes(lureSpec.category)) return 0.50;
  if (rejected.includes(lureSpec.category))  return 0.05;
  return 0.40;
}

/**
 * Depth match score [0,1]: how well the lure's run depth matches the species'
 * depth affinity. Score decays to 0 at ±4m deviation.
 *
 * @param {number} lureDepthM
 * @param {number} speciesDepthM
 * @returns {number}
 */
function _depthMatch(lureDepthM, speciesDepthM) {
  return Math.max(0, 1 - Math.abs(lureDepthM - speciesDepthM) / 4.0);
}

/**
 * Resolve the absolute tile coordinate from a POI + landing offset.
 * Returns null if the POI does not exist.
 *
 * @param {string} poiId
 * @param {{ dx: number, dy: number }} landingOffset
 * @returns {{ x: number, y: number }|null}
 */
function _landingCoord(poiId, landingOffset) {
  const poi = poiGraph.getPoi(poiId);
  if (!poi) return null;
  return {
    x: Math.round(poi.centerCoord.x + landingOffset.dx),
    y: Math.round(poi.centerCoord.y + landingOffset.dy),
  };
}

/** Generate a unique fish instance ID. */
function _nextFishId() {
  return `fish_${_fishIdCounter++}`;
}

/**
 * Build a live fish instance from species data and cast context.
 *
 * @param {string} speciesId
 * @param {object} species
 * @param {{ x: number, y: number }} coord
 * @param {object} castSpec - CAST_LANDED payload
 * @param {string} lureId
 * @returns {object}
 */
function _createFishInstance(speciesId, species, coord, castSpec, lureId) {
  const weightKg = Math.max(
    0.05,
    _fishStream.lognormal(species.weight.mu, species.weight.sigma)
  );
  return {
    id:        _nextFishId(),
    speciesId,
    weightKg:  Math.round(weightKg * 1000) / 1000,
    stamina:   species.stamina,
    phase:     'RUNNING',
    coord,
    poiId:     castSpec.poiId,
    lureId,
  };
}

/**
 * Evaluate whether a cast splashdown produces a strike.
 *
 * Pipeline (D-032):
 *   1. Apply CAST pressure to landing tile.
 *   2. Confirm tile exists and has fish occupancy.
 *   3. For each species: compute combined bite probability from habitat suitability,
 *      lure affinity (D-048), depth match, presentation match, diurnal multiplier (D-053),
 *      mood roll, lure memory penalty (D-049), spook factor (D-038), pressure factor (D-039).
 *   4. Sort candidates by probability descending; first RNG hit wins.
 *
 * @param {object} castSpec - CAST_LANDED event payload
 * @param {string} castSpec.poiId
 * @param {string} castSpec.candidateId
 * @param {string} castSpec.finderTier
 * @param {{ dx: number, dy: number }} castSpec.landing
 * @param {string} castSpec.splashKind
 * @param {number} castSpec.scatterRadius
 * @param {number} castSpec.mitigationFactor
 * @param {number} castSpec.atMs
 * @returns {{ hit: boolean, speciesId?: string, fishInstance?: object }}
 */
export function evaluateStrike(castSpec) {
  const { poiId, landing, atMs } = castSpec;

  const absCoord = _landingCoord(poiId, landing);
  if (!absCoord) return { hit: false };

  // Apply CAST pressure (D-039, CAST +1).
  applyPressureEvent(absCoord, 'CAST', atMs);

  const tile = worldMap.getTile(absCoord);
  if (!tile) return { hit: false };
  if (!tile.state.occupancy || tile.state.occupancy.fishCount === 0) return { hit: false };

  // Environmental modifiers shared across all species.
  const spookLevel    = castSpookModel.readSpook(absCoord, atMs);
  const pressureLevel = readPressure(absCoord, atMs);
  // Spook: full level 5 → 5% probability floor (fish there but spooked off lure).
  const spookFactor    = Math.max(0.05, 1 - spookLevel / castSpookModel.MAX_SPOOK);
  // Pressure: max PRESSURE_STRIKE_PENALTY=0.6 cut at full pressure. Floor always > 0.
  const pressureFactor = 1 - PRESSURE_STRIKE_PENALTY * (pressureLevel / MAX_PRESSURE);

  // Resolve active lure from tournament state.
  const state        = stateStore.getState();
  const activeTackle = state.tournament?.activeTackle ?? { rods: [], lures: [], bait: [] };
  const activeLure   = activeTackle.lures?.[0];
  if (!activeLure) return { hit: false };

  let lureSpec;
  try { lureSpec = equipment.getLure(activeLure.id); }
  catch { return { hit: false }; }

  const coordKey = `${absCoord.x},${absCoord.y}`;

  // Build per-species candidates.
  const candidates = [];
  for (const [speciesId, species] of Object.entries(SPECIES_CATALOG)) {
    const habitatScore = _habitatSuitability(species, tile);
    if (habitatScore < 0.12) continue; // species cannot meaningfully inhabit this tile

    const lureAffinity  = lureSpec.speciesAffinity?.[speciesId] ?? 0.50;
    const depthScore    = _depthMatch(
      lureSpec.presentation.runDepthM,
      species.habitat.depthAffinityM
    );
    const presentScore  = _presentationMatch(lureSpec, species);
    const diurnalMult   = _diurnalMultiplier(species, atMs);
    // Mood roll: centre at 0.5, range proportional to moodVolatility (D-032).
    const moodRoll      = 0.5 + (_fishStream.next() - 0.5) * species.moodVolatility;
    const memPenalty    = _lureMemoryPenalty(coordKey, activeLure.id, atMs);

    const baseP = habitatScore * lureAffinity * depthScore * presentScore
                * diurnalMult * Math.max(0.05, moodRoll) * memPenalty;
    const finalP = baseP * spookFactor * pressureFactor;

    if (finalP > 0.001) {
      candidates.push({ speciesId, species, finalP });
    }
  }

  if (candidates.length === 0) return { hit: false };

  // Roll in descending probability order; first hit wins.
  candidates.sort((a, b) => b.finalP - a.finalP);
  for (const c of candidates) {
    if (_fishStream.next() < c.finalP) {
      const fishInstance = _createFishInstance(
        c.speciesId, c.species, absCoord, castSpec, activeLure.id
      );
      return { hit: true, speciesId: c.speciesId, fishInstance };
    }
  }

  return { hit: false };
}

// ===========================================================================
// Bite Timer — scheduleBite (D-032, D-033)
// ===========================================================================

/**
 * Compute the hookset window width for a species (D-033, D-050).
 * Baseline 750ms minus intelligence shrinkage (max 400ms), floored at 300ms.
 *
 * @param {object} species
 * @returns {number} window duration in ms
 */
function _hooksetWindowMs(species) {
  const shrink = species.intelligence * 400;
  return Math.max(HOOKSET_WINDOW_FLOOR_MS, Math.round(HOOKSET_WINDOW_BASELINE_MS - shrink));
}

/**
 * Compute dynamic nibble count (D-032).
 * Base range from species nibbleBand; intelligence bonus adds 0–2 extra nibbles;
 * active diurnal period subtracts 1 (a committed fish nibbles less, bites sooner).
 *
 * @param {object} species
 * @param {number} atMs
 * @returns {number} total nibble count, minimum 1
 */
function _computeNibbleCount(species, atMs) {
  const base            = _fishStream.int(species.nibbleBand.min, species.nibbleBand.max);
  const intelligenceBonus = Math.floor(species.intelligence * 2 * _fishStream.next()); // 0–2
  const diurnalReduction = _diurnalMultiplier(species, atMs) > 1.2 ? 1 : 0;
  return Math.max(1, base + intelligenceBonus - diurnalReduction);
}

/**
 * Schedule the full bite sequence (N nibbles then BITE_THUD) for a fish that has
 * committed to the lure. Returns a { cancel() } handle.
 *
 * fightLoop subscribes to BITE_NIBBLE to open the nibble-trap window.
 * fightLoop subscribes to BITE_THUD to handle the hookset trigger.
 *
 * @param {object} fishInstance
 * @param {object} castSpec
 * @returns {{ cancel(): void }}
 */
export function scheduleBite(fishInstance, castSpec) {
  const species      = SPECIES_CATALOG[fishInstance.speciesId];
  const nibbleCount  = _computeNibbleCount(species, castSpec.atMs);
  const windowMs     = _hooksetWindowMs(species);
  const clockHandles = [];
  let cancelled      = false;

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    for (const h of clockHandles) clock.cancel(h);
    clockHandles.length = 0;
    _activeBites.delete(fishInstance.id);
  }

  // Schedule N nibble events at stochastic intervals.
  let cumulativeMs = 0;
  for (let i = 0; i < nibbleCount; i++) {
    const intervalMs = _fishStream.int(NIBBLE_INTERVAL_MIN_MS, NIBBLE_INTERVAL_MAX_MS);
    cumulativeMs    += intervalMs;
    const nibbleIdx  = i;

    const h = clock.schedule(cumulativeMs, (atMs) => {
      if (cancelled) return;
      bus.emit('BITE_NIBBLE', {
        fishId:       fishInstance.id,
        speciesId:    fishInstance.speciesId,
        nibbleIndex:  nibbleIdx,
        totalNibbles: nibbleCount,
        poiId:        fishInstance.poiId,
        atMs,
      });
    });
    clockHandles.push(h);
  }

  // BITE_THUD fires after one final interval following the last nibble.
  const thudInterval = _fishStream.int(NIBBLE_INTERVAL_MIN_MS, NIBBLE_INTERVAL_MAX_MS);
  cumulativeMs      += thudInterval;

  const thudHandle = clock.schedule(cumulativeMs, (atMs) => {
    if (cancelled) return;
    bus.emit('BITE_THUD', {
      fishInstance,
      hooksetWindowMs: windowMs,
      castSpec,
      atMs,
    });
    _activeBites.delete(fishInstance.id);
  });
  clockHandles.push(thudHandle);

  const handle = { cancel };
  _activeBites.set(fishInstance.id, handle);
  return handle;
}

/**
 * Cancel an active bite sequence by its handle.
 *
 * @param {{ cancel(): void }|null} handle
 */
export function cancelBite(handle) {
  if (handle && typeof handle.cancel === 'function') handle.cancel();
}

// ===========================================================================
// Fish Fight State Machine — advanceFight (D-031, D-034)
// ===========================================================================

/**
 * Interpolate the species pull-force curve at the given exhaustion fraction.
 * The curve has 8 control points spanning exhaustion 0% → 100%.
 *
 * @param {readonly number[]} curve
 * @param {number} exhaustion - [0,1]
 * @returns {number}
 */
function _interpolatePullCurve(curve, exhaustion) {
  const clampedEx = Math.max(0, Math.min(1, exhaustion));
  const idx = clampedEx * (curve.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.min(curve.length - 1, lo + 1);
  const t   = idx - lo;
  return curve[lo] * (1 - t) + curve[hi] * t;
}

/**
 * Advance the fish fight state machine by one tick (D-031, D-034).
 * Called by fightLoop on every 60ms FIGHT_TICK.
 *
 * Stamina depletion / recovery is phase-dependent:
 *   RUNNING: stamina drains — faster when reeling (fish fights hard),
 *            slower when giving drag or idle.
 *   TIRED:   stamina recovers — slower when reeling (fish still resists),
 *            faster when giving drag or idle.
 *
 * Phase transitions (D-031):
 *   RUNNING → TIRED  when stamina < 15% of species.stamina
 *   TIRED   → RUNNING when stamina > 60% of species.stamina
 *
 * @param {{
 *   speciesId: string,
 *   stamina:   number,
 *   phase:     'RUNNING'|'TIRED',
 * }} fightState
 * @param {{
 *   reeling:    boolean,
 *   givingDrag: boolean,
 *   mutex:      boolean,
 * }} inputs - mutex means both reeling+drag are held simultaneously (D-031)
 * @param {number} dt - elapsed ms this tick (expected 60)
 * @returns {{ stamina: number, phase: 'RUNNING'|'TIRED', pullForce: number }}
 */
export function advanceFight(fightState, inputs, dt) {
  const species    = SPECIES_CATALOG[fightState.speciesId];
  if (!species) {
    // Unknown species — return safe defaults so fight can still resolve.
    return { stamina: 0, phase: 'TIRED', pullForce: 0.30 };
  }

  const { stamina, phase } = fightState;
  const tickFactor = dt / 60; // normalise to the reference 60ms tick

  // Current exhaustion fraction.
  const exhaustion = 1 - Math.max(0, stamina / species.stamina);
  const basePull   = _interpolatePullCurve(species.pullForceCurve, exhaustion);

  // Apply per-style pull variance (RNG-driven character). The variance is small
  // so the curve remains the dominant signal.
  let pullModifier;
  switch (species.fightStyle) {
    case 'BULLDOG':  pullModifier = 0.95 + _fishStream.next() * 0.10; break; // steady grind
    case 'RUNNER':   pullModifier = 0.70 + _fishStream.next() * 0.60; break; // variable bursts
    case 'JUMPER':   pullModifier = 0.75 + _fishStream.next() * 0.50; break; // moderate + aerial
    case 'DIVER':    pullModifier = 1.05 + _fishStream.next() * 0.20; break; // high sustained deep
    case 'THRASHER': pullModifier = 0.40 + _fishStream.next() * 0.80; break; // erratic thrash
    default:         pullModifier = 1.00;
  }

  const pullForce = Math.min(1.0, basePull * pullModifier);

  // Stamina delta.
  let staminaDelta;
  if (phase === 'RUNNING') {
    // Running fish drains stamina when reeled; idle drain when not.
    const drainRate = inputs.reeling ? 0.020 : 0.008;
    staminaDelta    = -drainRate * tickFactor;
  } else {
    // Tired fish recovers slower when still resisting the reel.
    const recoverRate = inputs.reeling ? 0.004 : 0.007;
    staminaDelta      = recoverRate * tickFactor;
  }

  const newStamina = Math.max(0, Math.min(species.stamina, stamina + staminaDelta));

  // Phase transition logic (D-031).
  let newPhase = phase;
  if (phase === 'RUNNING' && newStamina < 0.15 * species.stamina) {
    newPhase = 'TIRED';
  } else if (phase === 'TIRED' && newStamina > 0.60 * species.stamina) {
    newPhase = 'RUNNING';
  }

  return { stamina: newStamina, phase: newPhase, pullForce };
}

// ===========================================================================
// CAST_LANDED handler (internal)
// ===========================================================================

/**
 * Evaluate the strike on every CAST_LANDED event. If a strike occurs, schedule
 * the bite sequence. One active bite per simultaneous CAST_LANDED is expected
 * (scan lock prevents concurrent casts).
 *
 * @param {object} evt - CAST_LANDED payload
 */
function _onCastLanded(evt) {
  const result = evaluateStrike(evt);
  if (!result.hit) return;
  scheduleBite(result.fishInstance, evt);
}

// ===========================================================================
// Mount Manifest (H-005)
// ===========================================================================

modeRouter.registerMountManifest({
  id:    'fishBehavior',
  modes: ['TOURNAMENT_ACTIVE'],

  onMount(_nextMode, _prevMode) {
    // Fresh RNG stream for this tournament run (H-015: stream name 'fish').
    _fishStream = rng.rngStream('fish');

    // Reset per-tournament state.
    _lureMemory.clear();
    _activeBites.clear();
    _fishIdCounter = 1;

    // Populate tile occupancy for all built POI zones.
    _populateAllPois(clock.nowMs());

    // Drive the strike pipeline from cast events.
    _unsubs.push(bus.on('CAST_LANDED', _onCastLanded));
  },

  onUnmount(_prevMode, _nextMode) {
    // Cancel all pending bite clock handles.
    for (const handle of _activeBites.values()) handle.cancel();
    _activeBites.clear();

    // Release bus subscriptions.
    for (const unsub of _unsubs) unsub();
    _unsubs.length = 0;
  },
});
