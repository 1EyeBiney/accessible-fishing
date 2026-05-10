/**
 * AFish Engine — src/engine.js
 *
 * Public API Contract: boot(opts?) / assertNoLeaks()
 *
 * The composition root for the entire AFish engine.
 * Contains ZERO game logic — only wiring, boot sequencing, and the H-005 leak test.
 *
 * boot() sequence:
 *   1. Load the player profile via profileStore.load() (adapter boundary — D-024).
 *      profileStore.load() dispatches 'PROFILE_LOADED', updating state.profile.
 *   2. Seed the global RNG from state.profile.globalSeed (§5d).
 *      rng.seed() MUST be called AFTER PROFILE_LOADED and BEFORE any rngStream() calls.
 *   3. Transition to FOCUS_TRAP mode (D-023) — the first user-facing screen.
 *      modeRouter.transitionTo() handles clock rules (D-018) and inputAdapter.releaseAll()
 *      (H-010) as part of its transition sequence.
 *
 * Audio wiring note (D-021):
 *   "The engine never imports audio modules outside the single boot call."
 *   audioBus.js will be imported and subscribed here in Phase 8, as the sole
 *   entry point for all audio subscriptions. See the marked TODO below.
 *
 * H-005 Boot Leak Test (assertNoLeaks()):
 *   Verifies that every subsystem registered via registerMountManifest() correctly
 *   cancels its clock handles and bus subscriptions in onUnmount().
 *   Protocol: force a full HUB↔TOURNAMENT round-trip, then assert that
 *   bus.totalListenerCount() === 0 and clock.pendingCount() === 0.
 *   This is a TEST-ONLY export — calling it in production corrupts game state.
 */

import * as bus          from './core/eventBus.js';
import * as clock        from './core/clock.js';
import * as rng          from './core/rng.js';
import * as stateStore   from './core/stateStore.js';     // eslint-disable-line no-unused-vars
import * as inputAdapter from './core/inputAdapter.js';   // eslint-disable-line no-unused-vars
import {
  MODES,
  transitionTo,
  currentMode,
} from './core/modeRouter.js';
import * as profileStore from './profile/profileStore.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Prevents boot() from being called more than once per process lifetime. */
let _booted = false;

// ---------------------------------------------------------------------------
// Public API — boot sequence
// ---------------------------------------------------------------------------

/**
 * Boot the AFish engine. Must be called exactly once per process lifetime.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.profilePath]  - override the default profile file path
 *                                        (useful for tests using isolated profiles)
 * @returns {Promise<void>}
 */
async function boot(opts = {}) {
  if (_booted) {
    console.warn('[engine] boot() called more than once — ignoring');
    return;
  }

  // ── Step 1: Load Profile ─────────────────────────────────────────────────
  // profileStore.load() handles first-boot creation, JSON migration, and dispatches
  // 'PROFILE_LOADED' to stateStore before returning. state.profile is authoritative
  // from this point forward.
  const profile = await profileStore.load(opts.profilePath);

  // ── Step 2: Seed the Global RNG ──────────────────────────────────────────
  // All game randomness must flow through the seeded RNG (§5d). Seeding happens
  // here, after the profile is loaded, so every session with the same profile
  // produces the same sequence of random results (deterministic replay, H-004).
  rng.seed(profile.globalSeed);

  // ── Step 3 (Phase 8): Wire Audio Bus ─────────────────────────────────────
  // D-021: "The engine never imports audio modules outside the single boot call."
  // audioBus.js will be imported and initialised here in Phase 8.
  // No other file may import audio modules for wiring purposes.
  //
  //   TODO (Phase 8):
  //   const { subscribe: subscribeAudio } = await import('./audio/audioBus.js');
  //   subscribeAudio();

  // ── Step 4: Transition to FOCUS_TRAP ─────────────────────────────────────
  // D-023: First user-facing mode after BOOT is FOCUS_TRAP, which holds
  // screen-reader focus until the player issues a confirmed input.
  // transitionTo() from BOOT → FOCUS_TRAP:
  //   - runs onUnmount for BOOT-mode manifests (none in Phase 1)
  //   - calls inputAdapter.releaseAll() (H-010)
  //   - applies clock rules: no clock mutation for FOCUS_TRAP (D-018)
  //   - dispatches MODE_CHANGED to stateStore
  //   - emits MODE_CHANGED on the bus
  //   - runs onMount for FOCUS_TRAP-mode manifests (none in Phase 1)
  transitionTo(MODES.FOCUS_TRAP);

  _booted = true;

  bus.emit('ENGINE_BOOTED', {
    atMs:      clock.nowMs(),
    profileId: profile.id,
    mode:      currentMode(),
  });
}

// ---------------------------------------------------------------------------
// Public API — H-005 Boot Leak Test
// ---------------------------------------------------------------------------

/**
 * H-005 Boot Leak Assertion.
 *
 * Forces a complete HUB↔TOURNAMENT round-trip and asserts that all subsystem
 * mount manifests correctly clean up their clock handles and bus subscriptions
 * in their onUnmount() callbacks.
 *
 * Protocol:
 *   CURRENT_MODE → HUB → TOURNAMENT_BRIEFING → TOURNAMENT_ACTIVE
 *   (clock paused immediately) → TOURNAMENT_RESULTS → HUB
 *   Assert: bus.totalListenerCount() === 0 && clock.pendingCount() === 0
 *
 * Returns a result object:
 *   { passed: boolean, listenerLeaks: number, clockLeaks: number, details: string }
 *
 * FOR TESTING ONLY. Calling this in a live game session will:
 *   - Unmount all currently active subsystems.
 *   - Reset the tournament clock.
 *   - Leave the game in HUB mode with no subsystems mounted.
 * Only call this from tests/harness.js or Phase 9 integration tests.
 *
 * @returns {{ passed: boolean, listenerLeaks: number, clockLeaks: number, details: string }}
 */
function assertNoLeaks() {
  // Drive a full HUB↔TOURNAMENT round-trip to exercise all onMount/onUnmount paths.
  //
  // Transition order mirrors the real game flow (D-017):
  //   HUB → TOURNAMENT_BRIEFING → TOURNAMENT_ACTIVE → TOURNAMENT_RESULTS → HUB

  // Ensure we start from a known state — any mode other than TOURNAMENT_ACTIVE
  // is safe to transition away from directly.
  if (currentMode() === MODES.BOOT) {
    // Boot hasn't run yet; transition out of BOOT to allow HUB entry.
    transitionTo(MODES.FOCUS_TRAP);
  }

  transitionTo(MODES.HUB);
  transitionTo(MODES.TOURNAMENT_BRIEFING);
  transitionTo(MODES.TOURNAMENT_ACTIVE);

  // modeRouter just called clock.reset() + clock.start({ mode: 'realtime' }).
  // Pause immediately so the setInterval does not fire during the test assertion.
  // Subsystem onMount() calls for TOURNAMENT_ACTIVE have already run synchronously,
  // so any handles they registered are now visible to clock.pendingCount().
  clock.pause();

  transitionTo(MODES.TOURNAMENT_RESULTS);
  transitionTo(MODES.HUB);

  // ── Assert ────────────────────────────────────────────────────────────────
  const listenerLeaks = bus.totalListenerCount();
  const clockLeaks    = clock.pendingCount();
  const passed        = listenerLeaks === 0 && clockLeaks === 0;

  let details = passed
    ? 'H-005 PASS: no stray bus listeners or clock handles.'
    : 'H-005 FAIL:';

  if (listenerLeaks > 0) {
    const snapshot = bus.debugSnapshot();
    details += `\n  ${listenerLeaks} stray bus listener(s): ${JSON.stringify(snapshot)}`;
  }
  if (clockLeaks > 0) {
    details += `\n  ${clockLeaks} stray clock handle(s) still pending.`;
  }

  if (!passed) {
    console.error(`[engine] ${details}`);
  }

  return { passed, listenerLeaks, clockLeaks, details };
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Reset the booted flag.
 * FOR TESTING ONLY — allows the harness to call boot() more than once in a single
 * test run (e.g. to test different profile paths in sequence).
 * Must be called AFTER resetting stateStore._reset(), clock, and modeRouter._resetManifests()
 * if a clean slate is required.
 */
function _resetBootedFlag() {
  _booted = false;
}

export { boot, assertNoLeaks, _resetBootedFlag };
