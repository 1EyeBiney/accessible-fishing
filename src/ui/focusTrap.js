/**
 * AFish Focus Trap UI — src/ui/focusTrap.js
 *
 * Mount manifest for FOCUS_TRAP mode (D-023).
 *
 * FOCUS_TRAP is the mandatory first user-facing mode after BOOT. Its purpose is
 * to hold screen-reader focus at a known ARIA live region so the player receives
 * the game's welcome announcement before any navigation is required. It acts as
 * a "ready gate" — nothing in the game advances until the player explicitly
 * confirms with Space or Enter.
 *
 * On mount:
 *   • Emits UI_ANNOUNCE with the welcome message so the ARIA assertive region
 *     in index.html speaks it immediately (or the CLI prints it in Node.js).
 *   • Subscribes to INPUT_SPACEBAR and INPUT_ENTER (tap events, D-029) to
 *     detect the "confirm" action.
 *
 * On confirm (Space or Enter tap):
 *   • Transitions to HUB mode via modeRouter.transitionTo().
 *   • Does NOT manually unsubscribe here — onUnmount() is called by modeRouter
 *     as part of the transition sequence and performs all cleanup.
 *
 * On unmount:
 *   • Removes the INPUT_SPACEBAR and INPUT_ENTER subscriptions to prevent leaks
 *     (H-005 invariant: zero stray bus listeners after HUB↔TOURNAMENT round-trip).
 */

import * as bus       from '../core/eventBus.js';
import { MODES, transitionTo } from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Welcome copy
// ---------------------------------------------------------------------------

/**
 * The message announced to the screen reader (and printed to the Node.js
 * terminal) when FOCUS_TRAP mounts.
 *
 * Kept short so screen readers reach the call-to-action quickly.
 * The second sentence names the confirm key so switch / keyboard users know
 * exactly what to do without consulting the legend.
 */
const WELCOME_TEXT =
  'Welcome to AFish — an accessible fishing game. ' +
  'Press Space or Enter to start.';

// ---------------------------------------------------------------------------
// Internal state — live only while FOCUS_TRAP is the active mode
// ---------------------------------------------------------------------------

/**
 * Unsubscribe functions returned by bus.on().
 * Stored so onUnmount() can remove them in O(1) without searching the bus.
 *
 * @type {Array<() => void>}
 */
let _unsubs = [];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle a confirm tap (Space or Enter).
 *
 * Called at most once — modeRouter unmounts FOCUS_TRAP as part of the
 * transitionTo(HUB) call, removing the subscriptions before any second
 * tap can fire. The guard inside transitionTo (no-op if already in target
 * mode) provides a second layer of safety.
 */
function _onConfirm() {
  transitionTo(MODES.HUB);
}

// ---------------------------------------------------------------------------
// Mount manifest
// ---------------------------------------------------------------------------

/**
 * @type {import('../core/modeRouter.js').MountManifest}
 */
export const focusTrapManifest = {
  id:    'ui:focus-trap',
  modes: [MODES.FOCUS_TRAP],

  /**
   * Called by modeRouter when entering FOCUS_TRAP.
   *
   * @param {string} _nextMode - always FOCUS_TRAP (unused, kept for signature)
   * @param {string} _prevMode - the mode we transitioned from (unused)
   */
  onMount(_nextMode, _prevMode) {
    // Subscribe to both tap events before announcing so the player can confirm
    // immediately after the TTS utterance ends without missing the window.
    _unsubs = [
      bus.on('INPUT_SPACEBAR', _onConfirm),
      bus.on('INPUT_ENTER',    _onConfirm),
    ];

    // Announce the welcome message. browserAdapter.js forwards UI_ANNOUNCE to
    // the #announcer aria-live="assertive" div so the screen reader speaks it.
    // In Node.js (no browser), audioEngine and browserAdapter are absent but
    // the bus event is still emitted — the CLI can subscribe if needed.
    bus.emit('UI_ANNOUNCE', { text: WELCOME_TEXT });

    // Also print to the Node.js terminal for headless / development runs.
    if (typeof process !== 'undefined' && process.stdout) {
      console.log(`[focusTrap] ${WELCOME_TEXT}`);
    }
  },

  /**
   * Called by modeRouter when leaving FOCUS_TRAP.
   * MUST remove all subscriptions acquired in onMount() (H-005).
   *
   * @param {string} _prevMode - always FOCUS_TRAP
   * @param {string} _nextMode - the mode we are transitioning into
   */
  onUnmount(_prevMode, _nextMode) {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
  },
};
