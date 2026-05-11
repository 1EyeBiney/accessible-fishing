/**
 * AFish Browser Adapter — src/browserAdapter.js
 *
 * The platform bridge between the DOM and the AFish engine for browser play.
 *
 * Responsibilities:
 *   1. Browser keyboard → inputAdapter (D-010: all input flows through inputAdapter).
 *   2. User-gesture gate: AudioContext can only be created inside a user event.
 *      The "Start Game / Enable Audio" button click is that event.
 *   3. Boot sequence: audioEngine.init() then engine.boot(), both on first click.
 *   4. ARIA routing: UI_ANNOUNCE bus events → #announcer live region.
 *   5. Status display: MODE_CHANGED + ENGINE_BOOTED → #status-display polite region.
 *
 * Architecture boundaries:
 *   • This file is the ONLY place that wires DOM event listeners to inputAdapter.
 *   • audioEngine.init() is called HERE (inside the user gesture), satisfying both
 *     the Web Audio API autoplay policy and D-021 (single boot-time audio wiring).
 *     engine.boot() internally calls audioEngine.init() — but only in the Node.js
 *     CLI path. In the browser, we call audioEngine.init() explicitly here first
 *     (idempotent; audioEngine.init() is guarded against double-init), then boot().
 *   • No game logic lives here. This file maps platform events to typed calls.
 *
 * Key code → inputAdapter type mapping (mirrors the CLI key map in engine.js):
 *   'ArrowUp'    → ARROW_UP       'Numpad8' → NUMPAD_8
 *   'ArrowDown'  → ARROW_DOWN     'Numpad2' → NUMPAD_2
 *   'ArrowLeft'  → ARROW_LEFT     'Numpad4' → NUMPAD_4
 *   'ArrowRight' → ARROW_RIGHT    'Numpad6' → NUMPAD_6
 *   'Space'      → SPACEBAR       'Numpad5' → NUMPAD_5
 *   'Enter'      → ENTER
 *   'Escape'     → ESCAPE
 *   'Backspace'  → BACKSPACE
 *
 * UI_ANNOUNCE contract:
 *   Any engine subsystem may emit:  bus.emit('UI_ANNOUNCE', { text: '...' })
 *   This adapter writes payload.text to #announcer, triggering the ARIA assertive
 *   live region so the screen reader interrupts and speaks the update immediately.
 */

import * as bus          from './core/eventBus.js';
import * as inputAdapter from './core/inputAdapter.js';
import * as audioEngine  from './audio/audioEngine.js';
import { boot }          from './engine.js';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

/** @type {HTMLButtonElement} */
const _startBtn = document.getElementById('start-btn');

/**
 * ARIA assertive live region — screen reader speaks updates immediately.
 * @type {HTMLElement}
 */
const _announcer = document.getElementById('announcer');

/**
 * ARIA polite status region — used for non-urgent state readouts.
 * @type {HTMLElement}
 */
const _statusDisplay = document.getElementById('status-display');

/**
 * Error panel — revealed on fatal boot failure.
 * @type {HTMLElement}
 */
const _errorPanel = document.getElementById('error-panel');

// ---------------------------------------------------------------------------
// Keyboard → inputAdapter mapping
// ---------------------------------------------------------------------------

/**
 * Maps browser event.code values to the normalised inputAdapter type strings
 * defined in D-010.  event.code is layout-independent (physical key position),
 * which is correct for game controls — a player remapping their OS keyboard
 * layout should still have arrow keys on the arrow-key positions.
 *
 * @type {Map<string, string>}
 */
const _KEY_MAP = new Map([
  // Arrow keys
  ['ArrowUp',    'ARROW_UP'],
  ['ArrowDown',  'ARROW_DOWN'],
  ['ArrowLeft',  'ARROW_LEFT'],
  ['ArrowRight', 'ARROW_RIGHT'],

  // Numpad accessibility alternatives
  ['Numpad8',    'NUMPAD_8'],
  ['Numpad2',    'NUMPAD_2'],
  ['Numpad4',    'NUMPAD_4'],
  ['Numpad6',    'NUMPAD_6'],
  ['Numpad5',    'NUMPAD_5'],

  // Action keys
  ['Space',      'SPACEBAR'],
  ['Enter',      'ENTER'],
  ['NumpadEnter','ENTER'],
  ['Escape',     'ESCAPE'],
  ['Backspace',  'BACKSPACE'],
]);

// ---------------------------------------------------------------------------
// Keyboard adapter — wired unconditionally (before boot)
// ---------------------------------------------------------------------------
// Input is registered immediately so that keyboard users can navigate the
// start-button area without waiting for boot.  All events before boot() are
// queued normally inside inputAdapter; the game loop starts consuming them
// once mode manifests are mounted.

/**
 * Whether the game has been booted.  Guards the keyboard adapter from
 * routing keys before the engine is ready; events are silently dropped
 * until boot completes so that pre-boot key presses don't corrupt state.
 */
let _engineReady = false;

window.addEventListener('keydown', (event) => {
  if (!_engineReady) return;

  const inputType = _KEY_MAP.get(event.code);
  if (!inputType) return;

  // Prevent the browser's default action for mapped keys (e.g. scrolling
  // on Space/Arrow, form submission on Enter).
  event.preventDefault();

  inputAdapter.keyDown(inputType, null, 'browser-keyboard');
}, { passive: false });

window.addEventListener('keyup', (event) => {
  if (!_engineReady) return;

  const inputType = _KEY_MAP.get(event.code);
  if (!inputType) return;

  event.preventDefault();

  inputAdapter.keyUp(inputType, null, 'browser-keyboard');
}, { passive: false });

// ---------------------------------------------------------------------------
// ARIA routing — UI_ANNOUNCE
// ---------------------------------------------------------------------------

/**
 * Clear-then-set technique for ARIA live regions.
 *
 * Simply assigning the same text to innerText twice in a row may not re-trigger
 * the screen reader (some SR implementations only announce mutations). We clear
 * the region first in a microtask, then set the new text in a second microtask
 * so the SR sees two distinct DOM mutations: empty → populated.
 *
 * @param {string} text - The message to announce.
 */
function _announce(text) {
  if (!_announcer) return;
  // Clear in one microtask …
  _announcer.innerText = '';
  // … then populate in the next microtask so the SR sees a real mutation.
  requestAnimationFrame(() => {
    _announcer.innerText = String(text ?? '');
  });
}

bus.on('UI_ANNOUNCE', (payload) => {
  if (payload && typeof payload.text === 'string') {
    _announce(payload.text);
  }
});

// ---------------------------------------------------------------------------
// Status display routing — ENGINE_BOOTED + MODE_CHANGED
// ---------------------------------------------------------------------------

bus.on('ENGINE_BOOTED', (payload) => {
  if (_statusDisplay) {
    _statusDisplay.textContent =
      `Engine booted. Profile: ${payload?.profileId ?? 'unknown'}. ` +
      `Mode: ${payload?.mode ?? 'unknown'}.`;
  }
});

bus.on('MODE_CHANGED', (payload) => {
  if (_statusDisplay) {
    _statusDisplay.textContent = `Mode: ${payload?.to ?? 'unknown'}`;
  }
  // Also announce mode transitions through the assertive region so screen
  // readers are notified even when visual focus hasn't moved.
  if (payload?.to) {
    _announce(`Game mode: ${_formatModeName(payload.to)}`);
  }
});

/**
 * Convert a SCREAMING_SNAKE_CASE mode name to a human-readable label.
 * e.g. 'TOURNAMENT_ACTIVE' → 'Tournament Active'
 *
 * @param {string} mode
 * @returns {string}
 */
function _formatModeName(mode) {
  return mode
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Start button — user-gesture gate
// ---------------------------------------------------------------------------

/**
 * Whether a boot attempt is currently in progress.
 * Prevents double-boot if the user clicks the button rapidly.
 */
let _booting = false;

/**
 * Handle the "Start Game / Enable Audio" button click.
 *
 * This handler is the required Web Audio API user gesture.  AudioContext
 * creation is only permitted inside (or triggered by) a user interaction
 * event; calling audioEngine.init() here satisfies that requirement.
 *
 * Sequence:
 *   1. Disable the button immediately (prevent double-click).
 *   2. Update status display.
 *   3. Call audioEngine.init() — creates AudioContext inside the gesture.
 *   4. Call boot() — performs profile load, RNG seed, mode transition.
 *      boot() will call audioEngine.init() again internally; that second call
 *      is a no-op because audioEngine.init() is idempotent.
 *   5. Mark engine ready, enable keyboard routing.
 *   6. Focus the page title so screen readers announce the game has started.
 */
async function _handleStartClick() {
  if (_booting) return;
  _booting = true;

  // Disable button to prevent double-activation.
  _startBtn.disabled = true;
  _startBtn.textContent = 'Starting…';

  if (_statusDisplay) {
    _statusDisplay.textContent = 'Initialising audio and loading profile…';
  }

  try {
    // ── Step 1: Initialise audio inside the user gesture ─────────────────
    // audioEngine.init() creates (or resumes) the Web Audio AudioContext.
    // This MUST happen synchronously within the click event dispatch, or
    // the browser will block it under its autoplay policy.
    // volume: 0.3 — default master volume; adjustable later via setVolume().
    audioEngine.init({ volume: 0.3 });

    // ── Step 2: Boot the engine ───────────────────────────────────────────
    // boot() is async (profile I/O).  It will call audioEngine.init() a
    // second time; that call is a safe no-op (idempotent guard in audioEngine).
    await boot({ silent: false });

    // ── Step 3: Enable keyboard routing ───────────────────────────────────
    _engineReady = true;

    // ── Step 4: Update UI ─────────────────────────────────────────────────
    _startBtn.textContent = 'Game Running';
    _startBtn.setAttribute('aria-pressed', 'true');

    // Announce successful boot to screen readers via the assertive region.
    _announce('Game started. Use arrow keys or numpad to navigate.');

    // Move focus to the page heading so the SR reads the title in context,
    // giving the player a clean orientation landmark.
    const heading = document.querySelector('h1');
    if (heading) heading.focus();

  } catch (err) {
    // ── Boot failure path ─────────────────────────────────────────────────
    console.error('[browserAdapter] Fatal boot error:', err);

    _startBtn.disabled = false;
    _startBtn.textContent = 'Start Game / Enable Audio';

    if (_statusDisplay) {
      _statusDisplay.textContent = 'Boot failed. See error details below.';
    }

    if (_errorPanel) {
      _errorPanel.textContent =
        `Boot error: ${err?.message ?? String(err)}\n\n${err?.stack ?? ''}`;
      _errorPanel.dataset.visible = '';
      _errorPanel.focus();
    }

    _booting = false;
  }
}

_startBtn.addEventListener('click', _handleStartClick);
