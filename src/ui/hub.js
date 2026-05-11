/**
 * AFish Hub UI — src/ui/hub.js
 *
 * Mount manifest for HUB mode.
 *
 * The Hub is the game's main menu — the player arrives here after FOCUS_TRAP
 * and after returning from any tournament or sub-screen. It presents a vertical
 * list of top-level destinations. Arrow keys move the selection cursor; Space
 * or Enter activates the highlighted item.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Menu structure
 * ───────────────────────────────────────────────────────────────────────────
 *   0  Go Fishing            → TOURNAMENT_BRIEFING
 *   1  Tackle Box            → (Phase 12 — not yet implemented)
 *   2  Tournament Board      → (Phase 12 — not yet implemented)
 *   3  Settings              → (Phase 12 — not yet implemented)
 *
 * Items without a destination implemented yet announce a "coming soon" message
 * and stay in HUB rather than crashing. This keeps the menu navigable and
 * screen-reader-friendly before Phase 12.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Input handling (D-010 — all input through inputAdapter tap events, D-029)
 * ───────────────────────────────────────────────────────────────────────────
 *   INPUT_ARROW_UP   / INPUT_NUMPAD_8  → cursor up (wraps)
 *   INPUT_ARROW_DOWN / INPUT_NUMPAD_2  → cursor down (wraps)
 *   INPUT_SPACEBAR   / INPUT_NUMPAD_5  → activate selected item
 *   INPUT_ENTER                         → activate selected item
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ARIA contract
 * ───────────────────────────────────────────────────────────────────────────
 *   Every time the selection changes, or the Hub mounts, a UI_ANNOUNCE event
 *   is emitted with a human-readable label so the #announcer live region in
 *   the browser speaks the update. The announcement format is:
 *     "[item label]. Item [1-indexed position] of [total]."
 *   e.g. "Go Fishing. Item 1 of 4."
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Lifecycle (H-005)
 * ───────────────────────────────────────────────────────────────────────────
 *   onMount  — subscribe to all input tap events, announce current item.
 *   onUnmount — remove all bus subscriptions. Zero stray listeners after unmount.
 */

import * as bus       from '../core/eventBus.js';
import { MODES, transitionTo } from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MenuItem
 * @property {string}      label        - human-readable label (used in ARIA announcements)
 * @property {string|null} destination  - MODES.* to transition to, or null if not yet built
 * @property {string|null} comingSoon   - message to announce when destination is null
 */

/** @type {MenuItem[]} */
const MENU_ITEMS = [
  {
    label:       'Go Fishing',
    destination: MODES.TOURNAMENT_BRIEFING,
    comingSoon:  null,
  },
  {
    label:       'Tackle Box',
    destination: null,
    comingSoon:  'Tackle Box is coming in a future update.',
  },
  {
    label:       'Tournament Board',
    destination: null,
    comingSoon:  'Tournament Board is coming in a future update.',
  },
  {
    label:       'Settings',
    destination: null,
    comingSoon:  'Settings are coming in a future update.',
  },
];

const ITEM_COUNT = MENU_ITEMS.length;

// ---------------------------------------------------------------------------
// Internal state — live only while HUB is the active mode
// ---------------------------------------------------------------------------

/**
 * Index of the currently highlighted menu item.
 * Reset to 0 on every mount so returning to the Hub always lands on item 1.
 */
let _cursor = 0;

/**
 * Unsubscribe functions returned by bus.on().
 * Populated in onMount(), drained in onUnmount().
 *
 * @type {Array<() => void>}
 */
let _unsubs = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the ARIA announcement string for the current cursor position.
 * Format: "[label]. Item [n] of [total]."
 *
 * @returns {string}
 */
function _cursorAnnouncement() {
  const item = MENU_ITEMS[_cursor];
  return `${item.label}. Item ${_cursor + 1} of ${ITEM_COUNT}.`;
}

/**
 * Move the cursor up or down by `delta` steps, wrapping at the boundaries.
 * Emits UI_ANNOUNCE after moving so the screen reader speaks the new item.
 *
 * @param {number} delta - +1 for down, -1 for up
 */
function _moveCursor(delta) {
  _cursor = (_cursor + delta + ITEM_COUNT) % ITEM_COUNT;
  const text = _cursorAnnouncement();

  bus.emit('UI_ANNOUNCE', { text });

  if (typeof process !== 'undefined' && process.stdout) {
    console.log(`[hub] ${text}`);
  }
}

/**
 * Activate the currently highlighted menu item.
 *
 * If the item has a valid destination, transition to it.
 * If not yet implemented, announce the "coming soon" message and stay in HUB.
 */
function _activateItem() {
  const item = MENU_ITEMS[_cursor];

  if (item.destination !== null) {
    // modeRouter will call onUnmount() as part of the transition, cleaning up
    // all subscriptions before the next mode's onMount() runs.
    transitionTo(item.destination);
  } else {
    // Not yet implemented — announce and stay.
    const text = item.comingSoon ?? `${item.label} is not yet available.`;
    bus.emit('UI_ANNOUNCE', { text });

    if (typeof process !== 'undefined' && process.stdout) {
      console.log(`[hub] ${text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Input handlers (arrow up/down navigation, confirm)
// ---------------------------------------------------------------------------

function _onUp()      { _moveCursor(-1); }
function _onDown()    { _moveCursor(+1); }
function _onConfirm() { _activateItem(); }

// ---------------------------------------------------------------------------
// Mount manifest
// ---------------------------------------------------------------------------

/**
 * @type {import('../core/modeRouter.js').MountManifest}
 */
export const hubManifest = {
  id:    'ui:hub',
  modes: [MODES.HUB],

  /**
   * Called by modeRouter when entering HUB.
   *
   * @param {string} _nextMode - always HUB
   * @param {string} _prevMode - the mode we transitioned from
   */
  onMount(_nextMode, _prevMode) {
    // Always land on the first item when the Hub mounts so the player gets a
    // consistent starting position regardless of where they came from.
    _cursor = 0;

    // Subscribe to all relevant tap events.
    // Using tap events (INPUT_<TYPE>) rather than edge events (_DOWN / _UP)
    // keeps the Hub menu responsive to both short taps and held-then-released
    // inputs without special timing logic here (D-029).
    _unsubs = [
      // Navigation — arrow keys
      bus.on('INPUT_ARROW_UP',   _onUp),
      bus.on('INPUT_ARROW_DOWN', _onDown),

      // Navigation — numpad accessibility alternatives
      bus.on('INPUT_NUMPAD_8',   _onUp),
      bus.on('INPUT_NUMPAD_2',   _onDown),

      // Confirm — Space, Numpad 5, Enter
      bus.on('INPUT_SPACEBAR',   _onConfirm),
      bus.on('INPUT_NUMPAD_5',   _onConfirm),
      bus.on('INPUT_ENTER',      _onConfirm),
    ];

    // Announce the Hub and the first item so the screen reader orients the player.
    const intro = `Main menu. ${_cursorAnnouncement()} Use arrow keys to navigate, Space or Enter to select.`;
    bus.emit('UI_ANNOUNCE', { text: intro });

    if (typeof process !== 'undefined' && process.stdout) {
      console.log(`[hub] ${intro}`);
    }
  },

  /**
   * Called by modeRouter when leaving HUB.
   * MUST remove all subscriptions acquired in onMount() (H-005).
   *
   * @param {string} _prevMode - always HUB
   * @param {string} _nextMode - the mode we are transitioning into
   */
  onUnmount(_prevMode, _nextMode) {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
  },
};
