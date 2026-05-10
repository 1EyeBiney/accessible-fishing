/**
 * AFish Profile Store — src/profile/profileStore.js
 *
 * Public API Contract: load(filePath?) / save(filePath?)
 *
 * Adapter behind a single interface (D-024). The concrete storage backend
 * (Node.js fs JSON for headless v0.1, browser localStorage for future web builds)
 * is an internal implementation detail. No subsystem outside this file may touch
 * storage directly.
 *
 * On load():
 *   1. Attempts to read and parse the profile JSON file (or in-memory store).
 *   2. Merges the file data with the current default shape to fill any missing fields
 *      added in future versions (forward-compatible schema migration).
 *   3. Dispatches { type: 'PROFILE_LOADED', payload: { profile } } so stateStore
 *      reflects the loaded profile before engine.boot() seeds the RNG.
 *   4. Returns the merged profile object.
 *
 * On save():
 *   Reads state.profile from stateStore and serialises it to the backing store.
 *   Called by economy.js auto-save triggers (D-020) after Hub mutations.
 *   Never called mid-tournament — D-020 forbids mid-tournament saves.
 *
 * Backend selection:
 *   The module attempts to import 'node:fs/promises' at load time.
 *   If that import fails (browser / non-Node environment), it falls back to an
 *   in-memory Map<filePath, string>. The in-memory backend is session-scoped and
 *   does not persist across process restarts — suitable for tests and WASM builds.
 *
 * Security note (H-006):
 *   Profile JSON on disk is a known save-edit target. Checksum/signature verification
 *   is deferred to v1.0 per H-006. The merge-with-defaults approach means tampered
 *   fields survive but unknown fields beyond the schema are simply ignored.
 */

import * as stateStore from '../core/stateStore.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default file path used when no explicit path is passed to load() / save(). */
export const DEFAULT_PROFILE_PATH = './afish-profile.json';

/** File encoding for JSON persistence. */
const ENCODING = 'utf8';

// ---------------------------------------------------------------------------
// Backend detection — attempt Node.js fs, fall back to in-memory
// ---------------------------------------------------------------------------

/**
 * Resolved fs/promises module, or null if running in a non-Node environment.
 * Populated once on first use by _getFs().
 * @type {object|null|undefined} undefined = not yet resolved
 */
let _fs = undefined;

/**
 * Lazily resolves the Node.js fs/promises module.
 * Returns null if unavailable (browser / WASM).
 *
 * @returns {Promise<object|null>}
 */
async function _getFs() {
  if (_fs !== undefined) return _fs;
  try {
    _fs = await import('node:fs/promises');
  } catch {
    _fs = null;
  }
  return _fs;
}

/**
 * In-memory fallback store. Maps file-path string → serialised JSON string.
 * Only used when Node.js fs is unavailable.
 * @type {Map<string, string>}
 */
const _inMemory = new Map();

// ---------------------------------------------------------------------------
// Default profile factory
// ---------------------------------------------------------------------------

/**
 * Returns a fresh default profile for a brand-new player.
 *
 * `globalSeed` is generated from `Date.now()` here — this is the only permitted
 * use of wall-clock entropy in the engine. Once stored, all subsequent randomness
 * flows through rng.seed(profile.globalSeed) per §5d. The wall-clock call here is
 * an intentional system-boundary bootstrap, not game randomness.
 *
 * @returns {object}
 */
function _defaultProfile() {
  return {
    id:          `profile_${Date.now()}_${Math.floor(Math.random() * 0xFFFF).toString(16)}`,
    displayName: 'Angler',
    settings: {
      ttsRate: 1.0,
      volume:  1.0,
    },
    // Derive an initial seed from wall-clock entropy (bootstrap boundary — §5d).
    // Masked to a safe 31-bit positive integer to satisfy rng.seed()'s integer check.
    globalSeed: Date.now() & 0x7FFFFFFF,
    createdAt:  Date.now(),
  };
}

/**
 * Merges a loaded (possibly partial/stale) profile object with the current default
 * shape. Fields present in the file win; missing fields are filled from the defaults.
 * Nested objects (settings) are merged shallowly one level deep.
 *
 * This forward-compatible merge allows older profile files to load cleanly when new
 * fields are added to the schema in future versions.
 *
 * @param {object} loaded - raw parsed JSON from disk
 * @returns {object} merged profile matching the current schema
 */
function _mergeWithDefaults(loaded) {
  const defaults = _defaultProfile();
  return {
    ...defaults,
    ...loaded,
    settings: {
      ...defaults.settings,
      ...(loaded.settings ?? {}),
    },
    // Preserve the loaded id and seed — never regenerate them on merge
    id:         loaded.id         ?? defaults.id,
    globalSeed: loaded.globalSeed ?? defaults.globalSeed,
    createdAt:  loaded.createdAt  ?? defaults.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Backend read / write helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to read raw JSON string from the backing store.
 *
 * @param {string} filePath
 * @returns {Promise<string|null>} raw JSON string, or null if the file does not exist
 * @throws if the file exists but cannot be read (e.g. permission error)
 */
async function _readRaw(filePath) {
  const fs = await _getFs();

  if (fs !== null) {
    // Node.js path
    try {
      return await fs.readFile(filePath, { encoding: ENCODING });
    } catch (err) {
      // ENOENT → file does not exist → caller will create a new profile
      if (err.code === 'ENOENT') return null;
      throw err; // Re-throw genuine read errors
    }
  } else {
    // In-memory fallback
    return _inMemory.has(filePath) ? _inMemory.get(filePath) : null;
  }
}

/**
 * Write raw JSON string to the backing store.
 *
 * @param {string} filePath
 * @param {string} json
 * @returns {Promise<void>}
 */
async function _writeRaw(filePath, json) {
  const fs = await _getFs();

  if (fs !== null) {
    // Ensure the parent directory exists before writing (e.g. first boot in a new
    // project checkout where ./data/ doesn't exist yet).
    const path = await import('node:path');
    const dir  = path.dirname(filePath);
    if (dir && dir !== '.') {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(filePath, json, { encoding: ENCODING });
  } else {
    // In-memory fallback
    _inMemory.set(filePath, json);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the player profile from the backing store.
 *
 * Procedure:
 *  1. Read the JSON file at `filePath` (default: DEFAULT_PROFILE_PATH).
 *  2. If the file does not exist, create a new default profile and persist it.
 *  3. If the file exists but is malformed JSON, log a warning and use defaults.
 *  4. Merge the loaded data with the current default shape (forward-compatible migration).
 *  5. Dispatch 'PROFILE_LOADED' to stateStore so state.profile is current before
 *     engine.boot() calls rng.seed().
 *  6. Return the merged profile object.
 *
 * @param {string} [filePath=DEFAULT_PROFILE_PATH]
 * @returns {Promise<object>} the loaded and merged profile object
 */
async function load(filePath = DEFAULT_PROFILE_PATH) {
  let profile;
  let raw;

  try {
    raw = await _readRaw(filePath);
  } catch (err) {
    console.error(`[profileStore] Failed to read "${filePath}":`, err.message);
    console.warn('[profileStore] Falling back to default profile (data not persisted this session).');
    profile = _defaultProfile();
    _dispatch(profile);
    return profile;
  }

  if (raw === null) {
    // No file found — first boot, create and persist a fresh profile
    console.info(`[profileStore] No profile found at "${filePath}". Creating default profile.`);
    profile = _defaultProfile();
    try {
      await _writeRaw(filePath, JSON.stringify(profile, null, 2));
    } catch (writeErr) {
      console.warn(`[profileStore] Could not persist new profile: ${writeErr.message}`);
    }
  } else {
    // File found — parse with merge
    let parsed;
    try {
      parsed  = JSON.parse(raw);
      profile = _mergeWithDefaults(parsed);
    } catch (parseErr) {
      console.error(`[profileStore] Malformed profile JSON at "${filePath}": ${parseErr.message}`);
      console.warn('[profileStore] Falling back to default profile. Previous data preserved on disk.');
      profile = _defaultProfile();
    }
  }

  _dispatch(profile);
  return profile;
}

/**
 * Save the current state.profile to the backing store.
 *
 * Reads the authoritative profile from stateStore (single source of truth).
 * Called by economy.js / hubMenu.js after D-020 auto-save triggers.
 * NEVER called during TOURNAMENT_ACTIVE (D-020 forbids mid-tournament saves).
 *
 * @param {string} [filePath=DEFAULT_PROFILE_PATH]
 * @returns {Promise<void>}
 */
async function save(filePath = DEFAULT_PROFILE_PATH) {
  const profile = stateStore.getState().profile;

  let json;
  try {
    json = JSON.stringify(profile, null, 2);
  } catch (err) {
    console.error('[profileStore] Failed to serialise profile:', err.message);
    return;
  }

  try {
    await _writeRaw(filePath, json);
  } catch (err) {
    console.error(`[profileStore] Failed to save profile to "${filePath}":`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Dispatch PROFILE_LOADED to stateStore.
 * Separated into its own function so both the success and fallback paths use it.
 *
 * @param {object} profile
 */
function _dispatch(profile) {
  stateStore.dispatch({ type: 'PROFILE_LOADED', payload: { profile } });
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Seed the in-memory store with a profile JSON string for a given path.
 * FOR TESTING ONLY — allows the harness to inject a known profile without touching disk.
 *
 * @param {string} filePath
 * @param {object} profile
 */
function _seedInMemory(filePath, profile) {
  _inMemory.set(filePath, JSON.stringify(profile, null, 2));
}

/**
 * Clear the in-memory store.
 * FOR TESTING ONLY.
 */
function _clearInMemory() {
  _inMemory.clear();
}

export { load, save, DEFAULT_PROFILE_PATH, _seedInMemory, _clearInMemory };
