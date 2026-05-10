/**
 * AFish Wind Model — src/navigation/wind.js
 *
 * Public API Contract: sample(atMs)
 *
 * Pure, deterministic wind state sampler. Returns the wind vector at any point in
 * tournament time, computed from the global RNG seed and the clock timestamp.
 *
 * Design principles:
 *  - PURE / STATELESS: `sample(atMs)` never mutates any module-level variables.
 *    The same (globalSeed, atMs) pair always returns the identical wind vector.
 *    This makes D-012 (cast wind lock) trivially safe — the cast resolver caches
 *    the result of sample(tapOneAtMs) for the duration of flight.
 *  - DETERMINISTIC: Derives all randomness from `rngStream('wind')` seeded from
 *    the global seed (§5d). No wall-clock entropy, no Math.random().
 *  - BUS-FREE: wind.js emits nothing. Consumers call sample() directly. Audio
 *    subscribers that want "wind changed" events must schedule their own polling
 *    via clock.every() and compare successive samples (D-021 audio boundary).
 *
 * Wind model:
 *  - Turbulence is stratified across three sinusoidal layers at different periods
 *    (slow, medium, fast) to produce gradual but unpredictable shifts:
 *      Layer 1: Base drift   — period ~1200s (20 min), slow cardinal-direction shifts
 *      Layer 2: Gust pattern — period ~180s  (3 min),  medium fluctuations
 *      Layer 3: Micro-chop   — period ~30s   (30 sec),  short rapid texture
 *  - Each layer has a unique phase and amplitude derived from the seeded RNG so that
 *    no two sessions share the same wind "fingerprint" (D-057, lake-owned weather).
 *  - Direction and intensity are derived from separate layer sets to avoid coupling
 *    (strong gusts in one direction would be physically real, but this separation
 *    keeps the model accessible and predictable for audio design).
 *
 * Output schema:
 *  {
 *    directionDeg:  number,  // 0=N, 90=E, 180=S, 270=W. Compass degrees from which wind blows.
 *    intensityMs:   number,  // Wind speed in in-game metres per second [0, MAX_WIND_INTENSITY_MS]
 *    dx:            number,  // Unit vector component East (+) / West (-), derived from directionDeg
 *    dy:            number,  // Unit vector component South (+) / North (-), derived from directionDeg
 *    gustLevel:     number,  // Normalised [0, 1] — 0 = calm, 1 = severe gust. Used by cast mitigation.
 *    atMs:          number,  // The atMs passed in (for downstream traceability / caching)
 *  }
 *
 * Wind is expressed as the direction the wind is COMING FROM, matching meteorological
 * convention. The drift vector (where the wind pushes objects) is the OPPOSITE direction.
 * navigation.js applies the opposite to move the boat: pushDx = -dx, pushDy = -dy.
 *
 * Consumers:
 *  - navigation.js  driftStep()  — applies push vector each physics tick
 *  - castPipeline.js Tap 1       — locks sample(tapOneAtMs) for flight duration (D-012)
 *  - fishFinder.js               — reports gustLevel in finder tier display
 *  - audio/audioBus.js           — polls for wind shifts to crossfade ambient bed
 */

import { rngStream } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum wind intensity in in-game metres per second. Tuned for playability. */
export const MAX_WIND_INTENSITY_MS = 6.0;

/**
 * Period of the three turbulence layers in in-game milliseconds.
 * Values chosen to be mutually incommensurable (no common factor) so the combined
 * waveform's repeat period is astronomically long (well beyond any tournament).
 */
const LAYER_PERIOD_MS = Object.freeze({
  BASE:  1_200_000,  // 20 in-game minutes — slow cardinal shifts
  GUST:    180_000,  // 3 in-game minutes  — medium fluctuations
  CHOP:     30_000,  // 30 in-game seconds — rapid micro-texture
});

/**
 * Amplitude weights for each layer (sum to 1).
 * Base layer dominates; chop adds texture without overwhelming.
 */
const LAYER_AMPLITUDE = Object.freeze({
  BASE: 0.55,
  GUST: 0.30,
  CHOP: 0.15,
});

/** Separate amplitude weights for the direction model. */
const DIR_AMPLITUDE = Object.freeze({
  BASE: 0.65,
  GUST: 0.25,
  CHOP: 0.10,
});

// ---------------------------------------------------------------------------
// Seeded model parameters (computed once from rngStream('wind'))
// ---------------------------------------------------------------------------

/**
 * Per-session wind fingerprint derived from the global RNG seed.
 * Computed lazily on first call to _ensureModel(); cached thereafter.
 * If the global seed changes (new profile load), _modelDirty is set true.
 *
 * Using a lazily-populated model avoids any module-load-time side effects
 * while still keeping sample() O(1) per call.
 *
 * @type {object|null}
 */
let _model = null;

/**
 * Tracks the rng stream values that produced _model.
 * invalidateModel() must be called when the global seed changes (e.g., on profile load).
 */
export function invalidateModel() {
  _model = null;
}

/**
 * Build the session wind model from the seeded RNG.
 * Called once per tournament (on first sample() call after a seed change).
 *
 * The stream is consumed in a single burst here — this is intentional.
 * Downstream consumers never call rngStream('wind') directly; all wind
 * randomness is channeled through sample() which uses the pure-math model.
 */
function _ensureModel() {
  if (_model !== null) return;

  const stream = rngStream('wind');

  // Phase offsets for intensity layers (radians in [0, 2π))
  const baseIntensityPhase = stream.next() * Math.PI * 2;
  const gustIntensityPhase = stream.next() * Math.PI * 2;
  const chopIntensityPhase = stream.next() * Math.PI * 2;

  // Phase offsets for direction layers (radians in [0, 2π))
  const baseDirPhase = stream.next() * Math.PI * 2;
  const gustDirPhase = stream.next() * Math.PI * 2;
  const chopDirPhase = stream.next() * Math.PI * 2;

  // Cardinal bias for this session — the "prevailing" wind direction.
  // Expressed in full radians so all compass roses are equally likely.
  const prevailingDirRad = stream.next() * Math.PI * 2;

  // Base intensity scalar [0.2, 0.9] — determines how windy this lake session is overall.
  const baseIntensityScale = 0.2 + stream.next() * 0.7;

  _model = Object.freeze({
    baseIntensityPhase,
    gustIntensityPhase,
    chopIntensityPhase,
    baseDirPhase,
    gustDirPhase,
    chopDirPhase,
    prevailingDirRad,
    baseIntensityScale,
  });
}

// ---------------------------------------------------------------------------
// Internal math helpers
// ---------------------------------------------------------------------------

/**
 * Compute the layered intensity signal at time `atMs`.
 * Returns a normalised value in [0, 1].
 *
 * Three sinusoidal layers are combined with their respective amplitudes.
 * Each layer is phase-shifted by a session-unique offset derived from the RNG.
 *
 * @param {number} atMs
 * @param {object} m - the session model object
 * @returns {number} normalised intensity in [0, 1]
 */
function _computeIntensityNorm(atMs, m) {
  const t = atMs;

  // Each layer: (sin(2π·t/period + phase) + 1) / 2 → [0, 1]
  const base = (Math.sin((2 * Math.PI * t) / LAYER_PERIOD_MS.BASE + m.baseIntensityPhase) + 1) / 2;
  const gust = (Math.sin((2 * Math.PI * t) / LAYER_PERIOD_MS.GUST + m.gustIntensityPhase) + 1) / 2;
  const chop = (Math.sin((2 * Math.PI * t) / LAYER_PERIOD_MS.CHOP + m.chopIntensityPhase) + 1) / 2;

  const raw = LAYER_AMPLITUDE.BASE * base
            + LAYER_AMPLITUDE.GUST * gust
            + LAYER_AMPLITUDE.CHOP * chop;

  // Scale by the session's base intensity (how windy this lake is overall)
  return Math.min(1, raw * m.baseIntensityScale / (LAYER_AMPLITUDE.BASE + LAYER_AMPLITUDE.GUST + LAYER_AMPLITUDE.CHOP));
}

/**
 * Compute the wind direction in radians at time `atMs`.
 *
 * Direction drifts around the prevailing wind direction. The layered model
 * allows +/-90° of deviation at maximum layer amplitude, keeping the wind
 * physically plausible (it never reverses instantaneously).
 *
 * @param {number} atMs
 * @param {object} m - the session model object
 * @returns {number} direction in radians from which wind blows
 */
function _computeDirectionRad(atMs, m) {
  const t = atMs;

  // Each layer provides a signed deviation in [-1, 1]
  const base = Math.sin((2 * Math.PI * t) / LAYER_PERIOD_MS.BASE + m.baseDirPhase);
  const gust = Math.sin((2 * Math.PI * t) / LAYER_PERIOD_MS.GUST + m.gustDirPhase);
  const chop = Math.sin((2 * Math.PI * t) / LAYER_PERIOD_MS.CHOP + m.chopDirPhase);

  // Combined deviation in [-1, 1]
  const combinedDev = DIR_AMPLITUDE.BASE * base
                    + DIR_AMPLITUDE.GUST * gust
                    + DIR_AMPLITUDE.CHOP * chop;

  // Map combined deviation to ±90° (±π/2 radians) of directional swing
  const deviationRad = combinedDev * (Math.PI / 2);

  // Return prevailing direction plus deviation, normalised to [0, 2π)
  const raw = m.prevailingDirRad + deviationRad;
  return ((raw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sample the wind state at a given in-game timestamp.
 *
 * Deterministic: identical (globalSeed, atMs) inputs always produce identical output.
 * O(1): all computation is a handful of trig operations; no state is mutated.
 *
 * The returned vector (dx, dy) represents the compass direction FROM which wind blows.
 * navigation.js uses the OPPOSITE (pushDx = -dx, pushDy = -dy) as the drift force.
 * castPipeline.js applies wind in the same direction as the vector to model lure drift
 * in the direction the wind is blowing TO (the lure goes downwind — away from origin).
 *
 * @param {number} atMs - in-game clock milliseconds (from clock.nowMs())
 * @returns {{
 *   directionDeg: number,
 *   intensityMs:  number,
 *   dx:           number,
 *   dy:           number,
 *   gustLevel:    number,
 *   atMs:         number,
 * }}
 */
export function sample(atMs) {
  _ensureModel();
  const m = _model;

  // Compute intensity
  const intensityNorm  = _computeIntensityNorm(atMs, m);
  const intensityMs    = intensityNorm * MAX_WIND_INTENSITY_MS;

  // Compute gust level: the fast-layer (chop) contribution alone, normalised
  // to [0, 1]. Used by cast mitigation math (Tap 2–Tap 3 window, D-014).
  const chopOnly = (Math.sin((2 * Math.PI * atMs) / LAYER_PERIOD_MS.CHOP + m.chopIntensityPhase) + 1) / 2;
  const gustLevel = Math.min(1, chopOnly * m.baseIntensityScale);

  // Compute direction
  const directionRad = _computeDirectionRad(atMs, m);
  const directionDeg = (directionRad * 180) / Math.PI;

  // Unit vector in the FROM direction
  // Convention: 0° = N (from north → blows south), 90° = E (from east → blows west), etc.
  // dx = sin(directionRad), dy = -cos(directionRad) gives the unit vector pointing
  // FROM the wind source toward origin (i.e. INTO the compass rose).
  // The PUSH direction (what the boat / lure actually moves toward) is the opposite.
  const dx = Math.sin(directionRad);
  const dy = -Math.cos(directionRad);

  return {
    directionDeg: parseFloat(directionDeg.toFixed(2)),
    intensityMs:  parseFloat(intensityMs.toFixed(4)),
    dx:           parseFloat(dx.toFixed(6)),
    dy:           parseFloat(dy.toFixed(6)),
    gustLevel:    parseFloat(gustLevel.toFixed(4)),
    atMs,
  };
}

/**
 * Returns a human-readable compass rose label for a direction in degrees.
 * Used by TTS and hubMenu.js for wind direction announcements.
 *
 * @param {number} deg - direction in degrees (0–360)
 * @returns {string} e.g. "N", "NNE", "NE", "ENE", "E", ...
 */
export function compassLabel(deg) {
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[index];
}

/**
 * Returns a verbal description of wind intensity for TTS output.
 *
 * @param {number} intensityMs - wind speed in m/s (from sample().intensityMs)
 * @returns {string} e.g. "calm", "light breeze", "moderate wind", "strong gust"
 */
export function intensityLabel(intensityMs) {
  if (intensityMs < 0.5)  return 'calm';
  if (intensityMs < 1.5)  return 'light breeze';
  if (intensityMs < 3.0)  return 'moderate wind';
  if (intensityMs < 4.5)  return 'strong wind';
  return 'severe gust';
}
