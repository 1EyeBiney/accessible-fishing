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
 *   3. Wire the audio engine (D-021 single boot call).
 *      audioEngine.init() registers all bus subscriptions in one shot.
 *      No other file may import or initialise audio modules.
 *   4. Wire the CLI keyboard adapter (Node.js only).
 *      readline is loaded via dynamic import so the module is browser-safe.
 *      process.stdin.setRawMode(true) hijacks raw terminal input and routes it
 *      through inputAdapter so the game loop receives correctly typed INPUT_*
 *      events regardless of platform.
 *   5. Transition to FOCUS_TRAP mode (D-023) — the first user-facing screen.
 *      modeRouter.transitionTo() handles clock rules (D-018) and inputAdapter.releaseAll()
 *      (H-010) as part of its transition sequence.
 *
 * CLI Keyboard Map (Node.js terminal):
 *   Arrow Up    → ARROW_UP
 *   Arrow Down  → ARROW_DOWN
 *   Arrow Left  → ARROW_LEFT
 *   Arrow Right → ARROW_RIGHT
 *   Numpad 8    → NUMPAD_8  (accessibility alt for Arrow Up)
 *   Numpad 2    → NUMPAD_2  (accessibility alt for Arrow Down)
 *   Numpad 4    → NUMPAD_4  (accessibility alt for Arrow Left)
 *   Numpad 6    → NUMPAD_6  (accessibility alt for Arrow Right)
 *   Numpad 5    → NUMPAD_5  (confirm — alternate spacebar)
 *   Space       → SPACEBAR
 *   Enter       → ENTER
 *   Escape      → ESCAPE
 *   Backspace   → BACKSPACE
 *   Ctrl+C      → clean process.exit(0)
 *
 * Audio wiring note (D-021):
 *   "The engine never imports audio modules outside the single boot call."
 *   audioEngine.init() is called ONCE here. All audio subscriptions are
 *   registered inside that init() call. No other file wires audio.
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
import * as inputAdapter from './core/inputAdapter.js';
import {
  MODES,
  transitionTo,
  currentMode,
} from './core/modeRouter.js';
import * as profileStore from './profile/profileStore.js';
import * as audioEngine  from './audio/audioEngine.js';
import * as ttsQueue     from './audio/ttsQueue.js';
import * as diagnostics  from './dev/diagnostics.js';
import { registerUiManifests } from './ui/index.js';

// ---------------------------------------------------------------------------
// Gameplay system imports (side-effect — modules self-register via
// registerMountManifest at evaluation time, or expose API called during play)
// ---------------------------------------------------------------------------

// Equipment
import './equipment/fishFinder.js';        // scan() / cancel() API; consumed by tournamentActive

// Casting pipeline — targetSelector, castPipeline, and fightLoop each call
// modeRouter.registerMountManifest() at the top level, so a bare import is
// all that is required to wire them into the TOURNAMENT_ACTIVE mount slot.
import './casting/targetSelector.js';      // FISH_FINDER_RESULTS → TARGET_LOCKED menu FSM
import './casting/castPipeline.js';        // TARGET_LOCKED → 5-tap cast → CAST_LANDED

// Fish systems
import './fish/fightLoop.js';              // BITE_NIBBLE / BITE_THUD → fight physics
import './fish/fishBehavior.js';           // strike evaluation, bite scheduling, pressure

// Tournament AI
import './tournament/competitorAI.js';     // simulated bot AI; self-registers for TOURNAMENT_ACTIVE

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Prevents boot() from being called more than once per process lifetime. */
let _booted = false;

// ---------------------------------------------------------------------------
// CLI Keyboard Adapter (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Normalised key → inputAdapter type string.
 * Covers the full set defined in the brief's keyboard map plus numpad
 * accessibility alternatives.
 *
 * Keys not listed here are silently ignored (they do not produce INPUT events),
 * preventing garbage characters from leaking into the game bus.
 *
 * @type {ReadonlyMap<string, string>}
 */
const _KEY_MAP = new Map([
  // Arrow keys — standard navigation
  ['up',    'ARROW_UP'],
  ['down',  'ARROW_DOWN'],
  ['left',  'ARROW_LEFT'],
  ['right', 'ARROW_RIGHT'],

  // Numpad accessibility alternatives (D-010: all input flows through inputAdapter)
  ['8', 'NUMPAD_8'],  // alt: Arrow Up
  ['2', 'NUMPAD_2'],  // alt: Arrow Down
  ['4', 'NUMPAD_4'],  // alt: Arrow Left
  ['6', 'NUMPAD_6'],  // alt: Arrow Right
  ['5', 'NUMPAD_5'],  // alt: Spacebar confirm

  // Action keys
  [' ',  'SPACEBAR'],
  ['return',    'ENTER'],
  ['enter',     'ENTER'],
  ['escape',    'ESCAPE'],
  ['backspace', 'BACKSPACE'],
]);

/**
 * Whether the CLI keyboard adapter is currently installed.
 * Guards against double-installation if boot() is somehow called with
 * _resetBootedFlag() between calls in the same process.
 */
let _cliAdapterInstalled = false;

/**
 * Install the raw CLI keyboard adapter.
 *
 * Uses Node.js readline to emit keypress events on process.stdin, then
 * subscribes to them and routes each key through inputAdapter.keyDown() /
 * inputAdapter.keyUp(). The game loop receives standard INPUT_* bus events
 * regardless of whether it is running in a browser or a terminal.
 *
 * Safety guards:
 *   • Only installs in a real TTY (`process.stdin.isTTY`). CI / piped stdin
 *     will not have a TTY; setRawMode() would throw.
 *   • Browser-safe: the entire function is a no-op when `process` is undefined.
 *   • Idempotent — safe to call more than once (e.g. after _resetBootedFlag).
 *   • Ctrl+C is intercepted BEFORE mapping so the process always has a clean
 *     exit path even if the game loop hangs.
 *   • readline is loaded via dynamic import so this module is importable in a
 *     browser without triggering a Node.js built-in resolution error.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.silent=false]  Suppress the startup hint line.
 * @returns {Promise<void>}
 */
async function _installCliKeyboardAdapter(opts = {}) {
  if (_cliAdapterInstalled) return;

  // Browser guard: process is not defined in browser environments.
  // typeof check avoids a ReferenceError on bare `process` access.
  if (typeof process === 'undefined' || !process.stdin) return;

  // Only activate on real interactive terminals.
  if (!process.stdin.isTTY) {
    if (!opts.silent) {
      console.log('[engine] stdin is not a TTY — CLI keyboard adapter disabled.');
    }
    return;
  }

  // Dynamic import keeps 'node:readline' out of the browser module graph.
  // The browser never reaches this line (guarded above), so the import
  // will never be attempted in a browser context.
  const readline = await import('node:readline');

  // Enable keypress events on stdin.
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Track held keys so we can emit both _DOWN and _UP events.
  // Terminal key events only fire "press"; there is no native UP event from
  // readline. We synthesise UP 30 ms after the last DOWN for the same key.
  // 30 ms is below TAP_THRESHOLD_MS (150 ms), so every terminal keystroke
  // produces a tap event as well as an edge pair — matching D-029 semantics
  // and allowing both tap and hold detection (the held-detection path is
  // primarily used by touchscreen / gamepad adapters; terminal is tap-only).
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const _upTimers = new Map();
  const UP_DELAY_MS = 30;

  process.stdin.on('keypress', (_str, key) => {
    if (!key) return;

    // ── Ctrl+C: graceful exit ───────────────────────────────────────────
    // Checked first, before any mapping, so the process can always be stopped.
    if (key.ctrl && key.name === 'c') {
      console.log('\n[engine] Ctrl+C — exiting.');
      // Give the audio engine a moment to silence voices before exit.
      // 50 ms is imperceptible to the user but prevents a potential audio
      // context abort error in browser environments.
      setTimeout(() => process.exit(0), 50);
      return;
    }

    // ── Normalize key name ──────────────────────────────────────────────
    // readline gives key.name for named keys (arrows, space → ' ', etc.)
    // and key.sequence for raw characters. We normalise to lowercase.
    const rawName = key.name ?? _str ?? '';
    const keyName = rawName.toLowerCase();

    const inputType = _KEY_MAP.get(keyName);
    if (!inputType) return; // unmapped key — silently ignore

    // ── Synthesise DOWN ─────────────────────────────────────────────────
    // Cancel any pending UP timer for this key (key repeat: user held down
    // a key long enough for the terminal to fire multiple press events).
    if (_upTimers.has(inputType)) {
      clearTimeout(_upTimers.get(inputType));
      _upTimers.delete(inputType);
    } else {
      // First press for this key in this hold window — fire DOWN.
      inputAdapter.keyDown(inputType, null, 'cli-keyboard');
    }

    // ── Schedule UP ─────────────────────────────────────────────────────
    // UP fires UP_DELAY_MS after the last keypress event for this key.
    // This window collapses key-repeat sequences into a single logical hold.
    const upTimer = setTimeout(() => {
      _upTimers.delete(inputType);
      inputAdapter.keyUp(inputType, null, 'cli-keyboard');
    }, UP_DELAY_MS);
    _upTimers.set(inputType, upTimer);
  });

  _cliAdapterInstalled = true;

  if (!opts.silent) {
    console.log(
      '[engine] CLI keyboard adapter active. ' +
      'Arrows=navigate  Space/5=confirm  Enter=select  Esc=back  Ctrl+C=quit'
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — boot sequence
// ---------------------------------------------------------------------------

/**
 * Boot the AFish engine. Must be called exactly once per process lifetime.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.profilePath]  - override the default profile file path
 *                                        (useful for tests using isolated profiles)
 * @param {boolean} [opts.silent=false] - suppress startup console messages
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

  // ── Step 3: Wire Audio Bus (D-021 single boot call) ───────────────────────
  // "The engine never imports audio modules outside the single boot call."
  // audioEngine.init() registers ALL bus subscriptions in one synchronous call.
  // In Node.js, init() sets up the _logAudio fallback path (no AudioContext).
  // In a browser, init() creates the AudioContext singleton, pre-builds the
  // fight and finder voice graphs (H-009), and wires the master gain node.
  //
  // opts.volume (if provided) sets the initial master volume [0..1].
  audioEngine.init({ volume: opts.volume ?? 0.3, silent: opts.silent ?? false });

  // H-022: Wire TTS preemption (D-021 single boot call).
  // ttsQueue.init() registers bus subscriptions that cancel window.speechSynthesis
  // whenever a high-priority tactical audio cue fires (BITE_*, FIGHT_*).
  ttsQueue.init();

  // D-084: X-Ray Vision dev diagnostics — fully dormant unless opts.dev === true.
  diagnostics.init(opts?.dev === true);

  // ── Step 4: Install CLI Keyboard Adapter ─────────────────────────────────
  // Translate raw terminal keypress events from process.stdin into properly
  // typed inputAdapter.keyDown() / keyUp() calls. This is the platform adapter
  // layer for headless Node.js terminal play (D-010: all input flows through
  // inputAdapter; no subsystem reads raw keyboard input directly).
  //
  // In a browser environment, this call is a no-op because process.stdin will
  // not be a TTY. The browser-side platform adapter (keyboard event listeners
  // on window) is wired separately in the browser entry point.
  await _installCliKeyboardAdapter({ silent: opts.silent ?? false });

  // ── Step 4b: Register UI Mode Manifests ─────────────────────────────
  // All UI mount manifests (focusTrap, hub, etc.) must be registered with
  // modeRouter BEFORE the first transitionTo() call so their onMount()
  // callbacks fire correctly when FOCUS_TRAP is entered below.
  // registerUiManifests() is idempotent — safe to call more than once.
  registerUiManifests();

  // ── Step 5: Transition to FOCUS_TRAP (D-023) ──────────────────────────────
  // D-023: First user-facing mode after BOOT is FOCUS_TRAP, which holds
  // screen-reader focus until the player issues a confirmed input.
  // transitionTo() from BOOT → FOCUS_TRAP:
  //   - runs onUnmount for BOOT-mode manifests (none at this point)
  //   - calls inputAdapter.releaseAll() (H-010)
  //   - applies clock rules: no clock mutation for FOCUS_TRAP (D-018)
  //   - dispatches MODE_CHANGED to stateStore
  //   - emits MODE_CHANGED on the bus (audio engine will play the transition sound)
  //   - runs onMount for FOCUS_TRAP-mode manifests
  transitionTo(MODES.FOCUS_TRAP);

  _booted = true;

  bus.emit('ENGINE_BOOTED', {
    atMs:      clock.nowMs(),
    profileId: profile.id,
    mode:      currentMode(),
  });

  if (!opts.silent) {
    console.log(`[engine] Booted. Profile: ${profile.id}. Mode: ${currentMode()}.`);
  }
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
  _cliAdapterInstalled = false;
}

export { boot, assertNoLeaks, _resetBootedFlag };

// ---------------------------------------------------------------------------
// Ignition Switch
// ---------------------------------------------------------------------------
// When this file is run directly as the entry point (node src/engine.js),
// boot the game automatically. When imported by a test harness or another
// module, skip autoboot so tests can call boot() on their own terms.
//
// Detection: compare import.meta.url (a file:// URL) with the resolved URL of
// process.argv[1] (the script Node.js is executing). They match only when
// this file IS the entry point.
//
//   node src/engine.js                        → boots the game
//   node tests/harness.js                     → import; does NOT autoboot
//   import * as engine from './engine.js'     → does NOT autoboot
//
// This is the ESM equivalent of: if (require.main === module) { ... }
// ---------------------------------------------------------------------------

(async () => {
  // Browser guard: process is not defined in browser environments.
  // browserAdapter.js calls boot() explicitly after the user gesture.
  if (typeof process === 'undefined') return;

  // --eval / REPL invocation: no entry-point path on argv[1].
  if (!process.argv[1]) return;

  const { pathToFileURL } = await import('node:url');
  const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
  if (!isMain) return;

  try {
    await boot();
  } catch (err) {
    console.error('[engine] Fatal boot error:', err);
    process.exit(1);
  }
})();
