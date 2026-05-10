/**
 * AFish RNG — src/core/rng.js
 *
 * Public API Contract: seed(value) / rngStream(name)
 *
 * Single randomness authority for the entire engine (§5d, D-009).
 * No subsystem may call Math.random() — all randomness flows through named sub-streams.
 *
 * Design notes:
 *  - PRNG algorithm: Mulberry32 — fast, small, well-distributed for games, fully
 *    reproducible given the same seed. Produces floats in [0, 1).
 *  - Stream seed derivation: FNV-1a 32-bit hash of the stream name, XOR'd with the
 *    global seed, gives each (globalSeed, streamName) pair a unique, independent PRNG
 *    state. Sub-streams do NOT share state; advancing one does not affect others.
 *  - AI bots MUST use rngStream('aiBrain:' + botId) for movement/POI/lure decisions
 *    and rngStream('aiCatch:' + botId) for P_catch rolls and weight sampling (H-015).
 *  - rngStream() creates a new independent PRNG object on every call for the same name.
 *    Callers should store the returned stream object, not call rngStream() repeatedly.
 *  - seed() may be called multiple times (e.g. on profile load), resetting derivation.
 *    All previously created stream objects remain valid but continue their old sequence.
 *    New streams created after seed() use the new global seed.
 */

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _globalSeed = 42; // default for dev/harness convenience; overwritten by engine.boot()
let _seeded     = false;

// ---------------------------------------------------------------------------
// PRNG: Mulberry32
// ---------------------------------------------------------------------------

/**
 * Creates a Mulberry32 PRNG closure seeded with the given 32-bit unsigned integer.
 * Each call to the returned function advances the state and returns a float in [0, 1).
 *
 * @param {number} seed - 32-bit unsigned integer
 * @returns {() => number}
 */
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function _next() {
    s  = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Stream seed derivation: FNV-1a 32-bit
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Produces a deterministic 32-bit unsigned integer from a string.
 * Used to derive stream-specific seeds from (globalSeed ⊕ streamName).
 *
 * @param {string} str
 * @param {number} [basis=2166136261] - FNV offset basis
 * @returns {number} unsigned 32-bit integer
 */
function _fnv1a32(str, basis = 2166136261) {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h  = (h ^ str.charCodeAt(i)) >>> 0;
    h  = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the global game seed. Must be called once by engine.boot() after loading a profile.
 * The global seed is XOR'd with each stream name to derive independent stream seeds (H-015).
 *
 * @param {number} value - any safe integer; converted to 32-bit unsigned internally
 * @throws {TypeError} if value is not an integer
 */
function seed(value) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`rng.seed: value must be an integer (got ${typeof value})`);
  }
  _globalSeed = value >>> 0;
  _seeded     = true;
}

/**
 * Create a named, deterministic, independent RNG sub-stream.
 *
 * Each (globalSeed, name) pair always produces the same sequence of values.
 * Sub-streams are fully independent — calls on one stream do not affect any other.
 *
 * Every call to rngStream(name) creates a NEW stream object starting from the
 * beginning of its sequence. Callers should cache the returned object.
 *
 * Required stream name conventions (H-015):
 *   - AI movement / lure rotation:  rngStream('aiBrain:' + botId)
 *   - AI catch rolls / weights:     rngStream('aiCatch:' + botId)
 *   - Fish bite timers:             rngStream('fish')
 *   - Cast scatter:                 rngStream('cast')
 *   - World generation:             rngStream('world')
 *
 * @param {string} name - unique, non-empty stream identifier
 * @returns {{
 *   next():                              number,
 *   int(min: number, max: number):       number,
 *   pick(arr: Array):                    *,
 *   bool(p?: number):                    boolean,
 *   weightedPick(arr: Array, w: number[]): *,
 *   lognormal(mu: number, sigma: number): number,
 * }}
 * @throws {TypeError} if name is not a non-empty string
 */
function rngStream(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('rng.rngStream: name must be a non-empty string');
  }

  if (!_seeded) {
    // Auto-seed with default so the harness works without an explicit engine boot.
    // In production, engine.boot() calls rng.seed(profile.globalSeed) before any
    // stream is created.
    _seeded = true;
  }

  // Derive an independent 32-bit seed for this stream.
  // XOR the global seed into the FNV basis so changing the global seed changes
  // every stream's sequence without collisions between stream names.
  const streamSeed = _fnv1a32(name, _globalSeed ^ 0xDEADBEEF);
  const _next      = _mulberry32(streamSeed);

  return {

    /**
     * Next float in [0, 1) from this stream.
     * @returns {number}
     */
    next() {
      return _next();
    },

    /**
     * Random integer in [min, max] inclusive.
     * @param {number} min
     * @param {number} max
     * @returns {number}
     * @throws {RangeError} if min > max
     */
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        throw new TypeError('rngStream.int: min and max must be integers');
      }
      if (min > max) {
        throw new RangeError(`rngStream.int: min (${min}) must be ≤ max (${max})`);
      }
      return Math.floor(_next() * (max - min + 1)) + min;
    },

    /**
     * Random pick from a non-empty array (uniform distribution).
     * @param {Array} arr
     * @returns {*}
     * @throws {TypeError} if arr is not a non-empty array
     */
    pick(arr) {
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new TypeError('rngStream.pick: arr must be a non-empty array');
      }
      return arr[Math.floor(_next() * arr.length)];
    },

    /**
     * Random boolean. Returns true with probability p.
     * @param {number} [p=0.5] - probability of true, in [0, 1]
     * @returns {boolean}
     */
    bool(p = 0.5) {
      return _next() < p;
    },

    /**
     * Weighted random pick. arr and weights must be the same length; weights sum must be > 0.
     * Used by AI bot slot fill (D-064) and lure selection.
     *
     * @param {Array}    arr
     * @param {number[]} weights - non-negative weights parallel to arr
     * @returns {*}
     * @throws {TypeError}  if lengths differ
     * @throws {RangeError} if weights sum to 0
     */
    weightedPick(arr, weights) {
      if (!Array.isArray(arr) || !Array.isArray(weights)) {
        throw new TypeError('rngStream.weightedPick: arr and weights must be arrays');
      }
      if (arr.length !== weights.length) {
        throw new TypeError(
          `rngStream.weightedPick: arr.length (${arr.length}) ≠ weights.length (${weights.length})`
        );
      }
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) {
        throw new RangeError('rngStream.weightedPick: weights must sum to > 0');
      }
      let r = _next() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= weights[i];
        if (r <= 0) return arr[i];
      }
      // Floating-point rounding fallback
      return arr[arr.length - 1];
    },

    /**
     * Sample from a log-normal distribution using Box-Muller transform.
     * Used for fish weight sampling in the headless success equation (D-059).
     *
     * Returns a value whose natural log is normally distributed with mean mu and
     * standard deviation sigma.
     *
     * @param {number} mu    - mean of the underlying normal distribution
     * @param {number} sigma - std dev of the underlying normal distribution (must be > 0)
     * @returns {number} positive float
     * @throws {RangeError} if sigma ≤ 0
     */
    lognormal(mu, sigma) {
      if (sigma <= 0) {
        throw new RangeError(`rngStream.lognormal: sigma must be > 0 (got ${sigma})`);
      }
      // Box-Muller: requires two uniform samples from THIS stream to preserve
      // determinism (H-004). Do not use Math.random().
      const u1 = Math.max(_next(), 1e-10); // guard against log(0)
      const u2 = _next();
      const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.exp(mu + sigma * z);
    },

  };
}

export { seed, rngStream };
