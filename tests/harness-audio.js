/**
 * AFish Audio Engine Headless Test Harness — tests/harness-audio.js
 *
 * Validates the event-routing and Node.js safety-wrapper logic of
 * src/audio/audioEngine.js in a fully headless environment (no browser,
 * no AudioContext).
 *
 * What can be tested headlessly:
 *   • That importing and initialising the engine throws no errors.
 *   • That the exported `setVolume` / `getVolume` API works.
 *   • That every bus event triggers its correct `_logAudio` branch
 *     (verified by spying on console.log).
 *   • That the `_fightActive` mutex correctly suppresses INPUT_* blips
 *     while a fight session is active.
 *
 * What CANNOT be tested headlessly:
 *   • Actual Web Audio API node creation, gain ramps, oscillator output.
 *   • AudioContext state machine (suspended / running / closed).
 *
 * Engineering notes:
 *   • The spy captures every console.log call and stores the formatted string.
 *   • Assertions use substring matching so they are resilient to minor log
 *     format changes that don't alter the routing identity.
 *   • The fight-active mutex (D-065 anti-fatigue gate, _fightActive flag)
 *     is exercised via FIGHT_TENSION (the real fight-start event) rather than
 *     a fictional FISH_HOOKED event. FIGHT_TENSION is the bus event emitted
 *     by fightLoop.js on the first 60 ms tick (D-034 / D-035).
 *   • CAST_LANDED uses `splashKind` (the payload field in audioEngine.js) not
 *     `splashMode`. The log token is `physics:splash_LOUD`.
 *
 * Sections:
 *   1  Headless Initialization
 *   2  Event Routing & State Mutex
 *
 * Run with:  node tests/harness-audio.js
 *        or: npm run harness-audio  (if configured in package.json)
 *
 * Exit code:
 *   0 — all assertions passed
 *   1 — one or more assertions failed
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as bus         from '../src/core/eventBus.js';
import * as audioEngine from '../src/audio/audioEngine.js';

// ---------------------------------------------------------------------------
// Harness bookkeeping
// ---------------------------------------------------------------------------

let _passed  = 0;
let _failed  = 0;
let _section = '';

function section(label) {
  _section = label;
  console.log(`\n=== ${label} ===`);
}

/**
 * Assert that `value` is truthy. Logs [PASS] or [FAIL] with a description.
 *
 * @param {boolean} value
 * @param {string}  description
 * @param {*}       [actual]  — printed alongside FAIL for diagnostics
 */
function assert(value, description, actual) {
  if (value) {
    console.log(`[PASS] ${description}`);
    _passed++;
  } else {
    const suffix = actual !== undefined ? `  (got: ${JSON.stringify(actual)})` : '';
    console.error(`[FAIL] ${description}${suffix}`);
    _failed++;
  }
}

/**
 * Assert strict equality.
 *
 * @param {*}      actual
 * @param {*}      expected
 * @param {string} description
 */
function assertEqual(actual, expected, description) {
  if (actual === expected) {
    console.log(`[PASS] ${description}`);
    _passed++;
  } else {
    console.error(`[FAIL] ${description}  (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
    _failed++;
  }
}

// ---------------------------------------------------------------------------
// console.log spy
// ---------------------------------------------------------------------------

/**
 * Captured log lines while the spy is active.
 * Only lines emitted by the real `console.log` path are captured; the
 * [PASS]/[FAIL] output uses the preserved original reference, so the test
 * results are always visible even when the spy is active.
 * @type {string[]}
 */
let _capturedLogs = [];

/** Preserved real console.log reference. */
const _realLog = console.log;

/** Replace console.log with a spy that stores every call and forwards it. */
function installSpy() {
  _capturedLogs = [];
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    _capturedLogs.push(line);
    // Forward to real logger so harness output is always visible.
    _realLog(...args);
  };
}

/** Restore real console.log and return the captured lines. */
function removeSpy() {
  console.log = _realLog;
  return _capturedLogs.slice();
}

/**
 * Return true if any captured log line contains `substring`.
 *
 * @param {string[]} logs
 * @param {string}   substring
 * @returns {boolean}
 */
function hasLog(logs, substring) {
  return logs.some(l => l.includes(substring));
}

// ---------------------------------------------------------------------------
// § 1 — Headless Initialization
// ---------------------------------------------------------------------------

section('1 — Headless Initialization');

// ── 1.1  typeof window must be undefined in a Node.js process ────────────
// This is the environment condition that activates the safety wrapper. If
// window were defined, the engine would attempt to create an AudioContext.
assert(
  typeof window === 'undefined',
  '1.1  typeof window === "undefined" in Node.js (safety-wrapper precondition)',
  typeof window
);

// ── 1.2  init() must complete without throwing ────────────────────────────
let initError = null;
try {
  audioEngine.init();
} catch (err) {
  initError = err;
}
assert(
  initError === null,
  '1.2  audioEngine.init() does not throw in headless mode',
  initError?.message
);

// ── 1.3  init() is idempotent (calling twice must not throw) ─────────────
let reinitError = null;
try {
  audioEngine.init();
} catch (err) {
  reinitError = err;
}
assert(
  reinitError === null,
  '1.3  audioEngine.init() is idempotent — second call does not throw',
  reinitError?.message
);

// ── 1.4  setVolume / getVolume round-trip ────────────────────────────────
// These are pure arithmetic operations — they must work identically in Node.js.
audioEngine.setVolume(0.75);
assertEqual(
  audioEngine.getVolume(),
  0.75,
  '1.4  setVolume(0.75) → getVolume() returns 0.75'
);

// ── 1.5  setVolume clamps values below 0 ─────────────────────────────────
audioEngine.setVolume(-1);
assertEqual(
  audioEngine.getVolume(),
  0,
  '1.5  setVolume(-1) is clamped to 0'
);

// ── 1.6  setVolume clamps values above 1 ─────────────────────────────────
audioEngine.setVolume(999);
assertEqual(
  audioEngine.getVolume(),
  1,
  '1.6  setVolume(999) is clamped to 1'
);

// Restore to a sensible default for the routing section.
audioEngine.setVolume(0.3);

// ── 1.7  Bus listeners are registered (engine emits [AUDIO] log on event) ─
// Verify the safety-wrapper path is live by emitting a known event and
// checking the [AUDIO] prefix appears. This also proves AudioContext was NOT
// constructed (no crash despite the subscription existing).
installSpy();
bus.emit('PLAYER_ARRIVED_AT_POI');
const initLogs = removeSpy();
assert(
  hasLog(initLogs, '[AUDIO]'),
  '1.7  Bus subscription active: PLAYER_ARRIVED_AT_POI emits [AUDIO] log (no AudioContext required)',
  initLogs
);

// ── 1.8  [AUDIO] log carries expected category and name tokens ────────────
assert(
  hasLog(initLogs, 'physics:motor_arrival'),
  '1.8  PLAYER_ARRIVED_AT_POI log token is "physics:motor_arrival"',
  initLogs
);

// ---------------------------------------------------------------------------
// § 2 — Event Routing & State Mutex
// ---------------------------------------------------------------------------

section('2 — Event Routing & State Mutex');

// ── 2.1  INPUT_ARROW_UP outside a fight → UI move blip is logged ─────────
installSpy();
bus.emit('INPUT_ARROW_UP');
const logsBeforeFight = removeSpy();

assert(
  hasLog(logsBeforeFight, 'ui:move'),
  '2.1  INPUT_ARROW_UP (pre-fight) → "ui:move" logged',
  logsBeforeFight
);

// ── 2.2  FIGHT_TENSION activates the fight mutex ─────────────────────────
// FIGHT_TENSION is the real bus event emitted by fightLoop.js on its first
// 60 ms clock tick (D-034 / D-035). It sets _fightActive = true as routing
// state in BOTH browser and Node.js, which is the precondition for the
// INPUT_* mute logic tested in 2.3 below.
installSpy();
bus.emit('FIGHT_TENSION', { tension: 0.42, trend: 'RISING', atMs: 1000 });
const fightStartLogs = removeSpy();

assert(
  hasLog(fightStartLogs, 'combat:tension'),
  '2.2a FIGHT_TENSION → "combat:tension" logged',
  fightStartLogs
);
assert(
  hasLog(fightStartLogs, '"t":"0.420"'),
  '2.2b FIGHT_TENSION log includes serialized tension value',
  fightStartLogs
);

// ── 2.3  INPUT_ARROW_UP DURING a fight → UI move blip is SUPPRESSED ──────
// The _fightActive flag (set by FIGHT_TENSION above) must mute directional
// input blips so they don't overlay combat audio or confuse the screen-reader
// with spurious menu-navigation announcements.
installSpy();
bus.emit('INPUT_ARROW_UP');
const logsDuringFight = removeSpy();

assert(
  !hasLog(logsDuringFight, 'ui:move'),
  '2.3  INPUT_ARROW_UP (during fight) → "ui:move" is SUPPRESSED by _fightActive mutex',
  logsDuringFight
);

// ── 2.4  INPUT_ARROW_DOWN is also suppressed during a fight ──────────────
installSpy();
bus.emit('INPUT_ARROW_DOWN');
const logsArrowDown = removeSpy();

assert(
  !hasLog(logsArrowDown, 'ui:move'),
  '2.4  INPUT_ARROW_DOWN (during fight) is also SUPPRESSED by _fightActive mutex',
  logsArrowDown
);

// ── 2.5  CAST_LANDED with splashKind LOUD → correct token logged ──────────
// CAST_LANDED is NOT gated by _fightActive (splashdowns can occur in fight).
installSpy();
bus.emit('CAST_LANDED', { splashKind: 'LOUD' });
const splashLogs = removeSpy();

assert(
  hasLog(splashLogs, 'physics:splash_LOUD'),
  '2.5  CAST_LANDED { splashKind: "LOUD" } → "physics:splash_LOUD" logged',
  splashLogs
);

// ── 2.6  CAST_LANDED with splashKind SILENT → correct token logged ────────
installSpy();
bus.emit('CAST_LANDED', { splashKind: 'SILENT' });
const silentSplashLogs = removeSpy();

assert(
  hasLog(silentSplashLogs, 'physics:splash_SILENT'),
  '2.6  CAST_LANDED { splashKind: "SILENT" } → "physics:splash_SILENT" logged',
  silentSplashLogs
);

// ── 2.7  CAST_LANDED with no splashKind → defaults to NORMAL ─────────────
installSpy();
bus.emit('CAST_LANDED', {});
const defaultSplashLogs = removeSpy();

assert(
  hasLog(defaultSplashLogs, 'physics:splash_NORMAL'),
  '2.7  CAST_LANDED {} (no splashKind) → defaults to "physics:splash_NORMAL"',
  defaultSplashLogs
);

// ── 2.8  FIGHT_RESOLVED clears the fight mutex ───────────────────────────
// After a FIGHT_RESOLVED, the _fightActive flag must be reset so that
// subsequent INPUT_* events are routed through as menu blips again.
installSpy();
bus.emit('FIGHT_RESOLVED', { outcome: 'FISH_LANDED' });
const resolvedLogs = removeSpy();

assert(
  hasLog(resolvedLogs, 'combat:resolved'),
  '2.8a FIGHT_RESOLVED → "combat:resolved" logged',
  resolvedLogs
);
assert(
  hasLog(resolvedLogs, '"outcome":"FISH_LANDED"'),
  '2.8b FIGHT_RESOLVED log includes outcome field',
  resolvedLogs
);

// ── 2.9  INPUT_ARROW_UP after fight resolves → move blip resumes ──────────
installSpy();
bus.emit('INPUT_ARROW_UP');
const logsAfterFight = removeSpy();

assert(
  hasLog(logsAfterFight, 'ui:move'),
  '2.9  INPUT_ARROW_UP (post-fight) → "ui:move" resumes after FIGHT_RESOLVED',
  logsAfterFight
);

// ── 2.10 TARGET_LOCKED → sonar locked token logged ───────────────────────
installSpy();
bus.emit('TARGET_LOCKED');
const targetLockedLogs = removeSpy();

assert(
  hasLog(targetLockedLogs, 'sonar:locked'),
  '2.10 TARGET_LOCKED → "sonar:locked" logged',
  targetLockedLogs
);

// ── 2.11 BITE_NIBBLE → combat nibble token logged ────────────────────────
installSpy();
bus.emit('BITE_NIBBLE');
const nibbleLogs = removeSpy();

assert(
  hasLog(nibbleLogs, 'combat:nibble'),
  '2.11 BITE_NIBBLE → "combat:nibble" logged',
  nibbleLogs
);

// ── 2.12 BITE_THUD → combat bite token logged ────────────────────────────
installSpy();
bus.emit('BITE_THUD');
const biteLogs = removeSpy();

assert(
  hasLog(biteLogs, 'combat:bite'),
  '2.12 BITE_THUD → "combat:bite" logged',
  biteLogs
);

// ── 2.13 FIGHT_THRESHOLD_CROSSED SNAP_DANGER → threshold token logged ─────
installSpy();
bus.emit('FIGHT_THRESHOLD_CROSSED', { threshold: 'SNAP_DANGER' });
const snapDangerLogs = removeSpy();

assert(
  hasLog(snapDangerLogs, 'combat:threshold'),
  '2.13 FIGHT_THRESHOLD_CROSSED { threshold: "SNAP_DANGER" } → "combat:threshold" logged',
  snapDangerLogs
);

// ── 2.14 AI_FISH_LANDED URGENT → ai catch token with URGENT priority ──────
installSpy();
bus.emit('AI_FISH_LANDED', { ttsPriority: 'URGENT', botId: 'bot_grinder' });
const urgentLogs = removeSpy();

assert(
  hasLog(urgentLogs, 'ai:catch'),
  '2.14 AI_FISH_LANDED { ttsPriority: "URGENT" } → "ai:catch" logged',
  urgentLogs
);
assert(
  hasLog(urgentLogs, '"URGENT"'),
  '2.14b ai:catch log includes URGENT priority',
  urgentLogs
);

// ── 2.15 MODE_CHANGED → ui transition token logged ───────────────────────
installSpy();
bus.emit('MODE_CHANGED', { prevMode: 'HUB', mode: 'TOURNAMENT_ACTIVE' });
const modeChangeLogs = removeSpy();

assert(
  hasLog(modeChangeLogs, 'ui:transition'),
  '2.15 MODE_CHANGED → "ui:transition" logged',
  modeChangeLogs
);

// ── 2.16 INPUT_SPACEBAR outside fight → ui select token logged ───────────
installSpy();
bus.emit('INPUT_SPACEBAR');
const selectLogs = removeSpy();

assert(
  hasLog(selectLogs, 'ui:select'),
  '2.16 INPUT_SPACEBAR (outside fight) → "ui:select" logged',
  selectLogs
);

// ── 2.17 INPUT_SPACEBAR_DOWN outside fight → NOT logged (suppressed) ──────
// INPUT_SPACEBAR_DOWN fires the reel click but only during a fight. Outside
// of a fight it must be a no-op so it does not conflict with menu selection.
installSpy();
bus.emit('INPUT_SPACEBAR_DOWN');
const spaceDownLogs = removeSpy();

assert(
  !hasLog(spaceDownLogs, 'combat:reel'),
  '2.17 INPUT_SPACEBAR_DOWN (outside fight) → "combat:reel" is SUPPRESSED',
  spaceDownLogs
);

// ── 2.18 SIMULATED_TOURNAMENT_SKUNK → ai skunk token logged ──────────────
installSpy();
bus.emit('SIMULATED_TOURNAMENT_SKUNK', { botId: 'bot_trophy', botDisplayName: 'Trophelia' });
const skunkLogs = removeSpy();

assert(
  hasLog(skunkLogs, 'ai:skunk'),
  '2.18 SIMULATED_TOURNAMENT_SKUNK → "ai:skunk" logged',
  skunkLogs
);

// ── 2.19 playFinderPing() public API does not throw in headless mode ──────
// playFinderPing is exported for direct calls from targetSelector.js (D-041
// menu-FSM ping-on-navigation). It must silently no-op in Node.js.
let finderPingError = null;
try {
  audioEngine.playFinderPing({ depthM: 5, pressure: 2, presenceHint: 'SCHOOLED', spook: 1 });
} catch (err) {
  finderPingError = err;
}
assert(
  finderPingError === null,
  '2.19 audioEngine.playFinderPing() does not throw in headless mode',
  finderPingError?.message
);

// ── 2.20 Full fight-cycle mutex: two fights in sequence both respect mutex ─
// Verifies that _fightActive resets correctly so a second fight after the
// first resolves also mutes directional inputs.
// — Start second fight
bus.emit('FIGHT_TENSION', { tension: 0.10, trend: 'RISING', atMs: 5000 });

installSpy();
bus.emit('INPUT_ARROW_LEFT');   // should be suppressed
const fight2MidLogs = removeSpy();

assert(
  !hasLog(fight2MidLogs, 'ui:move'),
  '2.20a Second fight: INPUT_ARROW_LEFT during fight is SUPPRESSED',
  fight2MidLogs
);

// — Resolve second fight
bus.emit('FIGHT_RESOLVED', { outcome: 'LINE_SNAPPED' });

installSpy();
bus.emit('INPUT_ARROW_RIGHT');  // should resume
const fight2AfterLogs = removeSpy();

assert(
  hasLog(fight2AfterLogs, 'ui:move'),
  '2.20b Second fight: INPUT_ARROW_RIGHT after FIGHT_RESOLVED resumes "ui:move"',
  fight2AfterLogs
);

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

const _total = _passed + _failed;
console.log(`\n─────────────────────────────────────────`);
console.log(`Audio Harness complete: ${_passed} / ${_total} passed`);
if (_failed > 0) {
  console.error(`${_failed} assertion(s) FAILED.`);
  process.exit(1);
}
