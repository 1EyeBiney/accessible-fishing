/**
 * AFish Mode Router — src/core/modeRouter.js
 *
 * Public API Contract: transitionTo(mode) / registerMountManifest(manifest) / currentMode() / MODES
 *
 * Sole owner of state.mode (D-017, §9).
 * Sole permitted caller of clock.pause() / clock.reset() / clock.start() for mode
 * transition reasons (D-018). All other subsystems call only clock.every/schedule/cancel.
 * Calls inputAdapter.releaseAll() on EVERY transition (H-010, D-030).
 *
 * Mount manifests (H-005):
 *   Every subsystem that has mode-scoped lifecycle (audioBus, fightLoop, aiBots, hub/*,
 *   etc.) registers a MountManifest declaring which modes it runs in, plus onMount()
 *   and onUnmount() callbacks. onUnmount() MUST cancel all clock handles and bus
 *   subscriptions acquired in onMount() — this is the primary mechanism for preventing
 *   the mode-leak hazard.
 *
 * The H-005 engine boot test verifies that bus.totalListenerCount() == 0 and
 * clock.pendingCount() == 0 after a full HUB↔TOURNAMENT round-trip.
 *
 * Transition sequence (per transitionTo call):
 *   1. Validate target mode.
 *   2. Unmount subsystems whose active-mode set no longer includes nextMode.
 *   3. inputAdapter.releaseAll() — emit synthetic UPs for held inputs (H-010).
 *   4. Apply clock rules (D-018).
 *   5. stateStore.dispatch('MODE_CHANGED') — state is updated before bus event.
 *   6. bus.emit('MODE_CHANGED') — downstream subscribers react.
 *   7. Mount subsystems whose active-mode set now includes nextMode.
 *
 * Clock rules (D-018):
 *   enter HUB              → clock.pause()
 *   enter TOURNAMENT_ACTIVE → clock.reset() then clock.start({ mode: 'realtime' })
 *   all other modes         → no clock mutation
 */

import * as bus          from './eventBus.js';
import * as clock        from './clock.js';
import * as inputAdapter from './inputAdapter.js';
import * as stateStore   from './stateStore.js';

// ---------------------------------------------------------------------------
// Mode Definitions (D-017)
// ---------------------------------------------------------------------------

/**
 * All valid game modes.
 * ONLY modeRouter may write state.mode via stateStore.dispatch('MODE_CHANGED').
 * @readonly
 * @enum {string}
 */
const MODES = Object.freeze({
  BOOT:                'BOOT',
  FOCUS_TRAP:          'FOCUS_TRAP',
  PROFILE_SELECT:      'PROFILE_SELECT',
  HUB:                 'HUB',
  TOURNAMENT_BRIEFING: 'TOURNAMENT_BRIEFING',
  TOURNAMENT_ACTIVE:   'TOURNAMENT_ACTIVE',
  TOURNAMENT_RESULTS:  'TOURNAMENT_RESULTS',
});

const _validModes = new Set(Object.values(MODES));

// ---------------------------------------------------------------------------
// Mount Manifests (H-005)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MountManifest
 * @property {string}   id      - unique subsystem identifier (for error messages)
 * @property {string[]} modes   - modes in which this subsystem is active
 * @property {Function} onMount   - called with (nextMode, prevMode) when entering a registered mode
 * @property {Function} onUnmount - called with (prevMode, nextMode) when leaving a registered mode;
 *                                  MUST cancel all clock handles and bus subscriptions
 */

/** @type {MountManifest[]} */
const _manifests = [];

/**
 * Register a subsystem lifecycle manifest.
 * onMount() fires when transitionTo() enters any mode listed in manifest.modes.
 * onUnmount() fires when transitionTo() leaves any mode listed in manifest.modes.
 *
 * Registration order determines call order (first registered, first mounted/unmounted).
 * Registering the same id twice replaces the previous entry.
 *
 * @param {MountManifest} manifest
 * @throws {TypeError}  if required fields are missing or wrong type
 * @throws {RangeError} if any listed mode is not a valid MODES value
 */
function registerMountManifest(manifest) {
  if (!manifest || typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new TypeError('registerMountManifest: manifest.id must be a non-empty string');
  }
  if (!Array.isArray(manifest.modes) || manifest.modes.length === 0) {
    throw new TypeError(`registerMountManifest [${manifest.id}]: manifest.modes must be a non-empty array`);
  }
  if (typeof manifest.onMount !== 'function') {
    throw new TypeError(`registerMountManifest [${manifest.id}]: manifest.onMount must be a function`);
  }
  if (typeof manifest.onUnmount !== 'function') {
    throw new TypeError(`registerMountManifest [${manifest.id}]: manifest.onUnmount must be a function`);
  }
  for (const mode of manifest.modes) {
    if (!_validModes.has(mode)) {
      throw new RangeError(
        `registerMountManifest [${manifest.id}]: unknown mode "${mode}". Valid: ${[..._validModes].join(', ')}`
      );
    }
  }

  // Replace if id already registered
  const existingIdx = _manifests.findIndex(m => m.id === manifest.id);
  if (existingIdx !== -1) {
    _manifests[existingIdx] = { ...manifest };
  } else {
    _manifests.push({ ...manifest });
  }
}

// ---------------------------------------------------------------------------
// Clock rules (D-018)
// ---------------------------------------------------------------------------

/**
 * Apply the clock mutation rules for the mode being entered.
 * ONLY this function is permitted to call clock.pause/reset/start (D-018).
 *
 * @param {string} nextMode
 */
function _applyClockRules(nextMode) {
  switch (nextMode) {
    case MODES.HUB:
      // Pause the tournament clock when returning to the Hub (D-018).
      // Safe to call if already paused (clock.pause() is idempotent).
      if (clock.isRunning()) clock.pause();
      break;

    case MODES.TOURNAMENT_ACTIVE:
      // Reset tournament clock to t=0, then start in realtime mode (D-018).
      // reset() also purges stale scheduled callbacks as a safety belt (H-005).
      // Subsystem onUnmount() should already have cancelled handles before this.
      clock.reset();
      clock.start({ mode: 'realtime' });
      break;

    // All other mode transitions leave the clock in its current state.
    // BOOT, FOCUS_TRAP, PROFILE_SELECT: clock not yet started.
    // TOURNAMENT_BRIEFING: clock is paused (hub was previous state).
    // TOURNAMENT_RESULTS: clock keeps running; no game-logic ticks remain (subsystems unmounted).
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

/**
 * Transition the game to a new mode.
 *
 * This is the ONLY function that may change state.mode.
 * No-op if nextMode === currentMode().
 *
 * @param {string} nextMode - must be one of MODES.*
 * @throws {RangeError} if nextMode is not a valid mode
 */
function transitionTo(nextMode) {
  if (!_validModes.has(nextMode)) {
    throw new RangeError(
      `modeRouter.transitionTo: unknown mode "${nextMode}". Valid: ${[..._validModes].join(', ')}`
    );
  }

  const prevMode = stateStore.getState().mode;
  if (prevMode === nextMode) return; // no-op

  // --- Step 1: Unmount subsystems leaving their active modes ---
  for (const manifest of _manifests) {
    const wasActive  = manifest.modes.includes(prevMode);
    const willActive = manifest.modes.includes(nextMode);
    if (wasActive && !willActive) {
      try {
        manifest.onUnmount(prevMode, nextMode);
      } catch (err) {
        console.error(`[modeRouter] onUnmount error in "${manifest.id}":`, err);
      }
    }
  }

  // --- Step 2: Release all held inputs (H-010, D-030) ---
  inputAdapter.releaseAll();

  // --- Step 3: Apply clock rules (D-018) ---
  _applyClockRules(nextMode);

  // --- Step 4: Commit mode to stateStore ---
  // Dispatching 'MODE_CHANGED' causes stateStore to emit STATE_CHANGED on the bus.
  // Internal stateStore subscribers see the new mode before any bus event fires.
  stateStore.dispatch({ type: 'MODE_CHANGED', payload: { mode: nextMode } });

  // --- Step 5: Emit dedicated MODE_CHANGED bus event ---
  // Provides a clean subscription point for audio, UI, and AI that don't need to
  // listen to all STATE_CHANGED events. Emitted after state is committed (step 4)
  // so all consumers read the correct state.mode from getState().
  bus.emit('MODE_CHANGED', {
    mode:     nextMode,
    prevMode,
    atMs:     clock.nowMs(),
  });

  // --- Step 6: Mount subsystems entering their declared modes ---
  // Mounts AFTER bus emit so newly mounted subscribers don't double-fire on the
  // current MODE_CHANGED event. onMount() should subscribe to bus events for the
  // new mode; those subscriptions will fire on the NEXT event, not this one.
  for (const manifest of _manifests) {
    const wasActive  = manifest.modes.includes(prevMode);
    const willActive = manifest.modes.includes(nextMode);
    if (!wasActive && willActive) {
      try {
        manifest.onMount(nextMode, prevMode);
      } catch (err) {
        console.error(`[modeRouter] onMount error in "${manifest.id}":`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the current game mode.
 * Reads from stateStore (single source of truth for mode — D-017).
 *
 * @returns {string} one of MODES.*
 */
function currentMode() {
  return stateStore.getState().mode;
}

/**
 * Returns an array of all registered manifest ids, in registration order.
 * Used by the H-005 boot test to verify all expected subsystems are registered.
 *
 * @returns {string[]}
 */
function registeredManifestIds() {
  return _manifests.map(m => m.id);
}

/**
 * Returns the full list of modes a given subsystem is registered for.
 * Returns null if no manifest with that id is registered.
 *
 * @param {string} id
 * @returns {string[] | null}
 */
function manifestModesFor(id) {
  const m = _manifests.find(m => m.id === id);
  return m ? [...m.modes] : null;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Clear all registered manifests.
 * FOR TESTING ONLY — allows harness to reset between test sections.
 */
function _resetManifests() {
  _manifests.length = 0;
}

export {
  MODES,
  transitionTo,
  registerMountManifest,
  currentMode,
  registeredManifestIds,
  manifestModesFor,
  _resetManifests,
};
