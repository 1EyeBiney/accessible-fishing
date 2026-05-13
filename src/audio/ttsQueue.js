/**
 * AFish TTS Queue — src/audio/ttsQueue.js
 *
 * Manages platform TTS preemption (H-022) so that critical tactical audio
 * cues are never masked by long-form narrative announcements.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * H-022 Preemption Rule (LOCKED)
 * ═══════════════════════════════════════════════════════════════════════════
 *   On any of the following bus events, immediately cancel the platform's
 *   speech synthesis queue so the audio engine's short-form combat cues
 *   (bite thud, snap crack, nibble tap) can be heard without TTS masking them:
 *
 *     • BITE_NIBBLE             — pre-hookset nibble phase starts
 *     • BITE_THUD               — main hookset trigger (300 ms window)
 *     • FIGHT_THRESHOLD_CROSSED — snap-danger / slack-danger alarms
 *     • FIGHT_RESOLVED          — fight terminal event (landed/snapped/shaken)
 *
 *   Rationale: The TTS announcer (tournamentActive.js) may be mid-utterance
 *   on a long string (e.g. a fish-finder summary or AI catch update) when one
 *   of these high-priority events fires.  The player cannot hear the audio
 *   engine cue through speech synthesis audio.  Cancelling speech synthesis
 *   immediately clears the utterance queue so the procedural audio has the
 *   output device to itself for the tactically critical window.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * D-021 Architecture Boundary
 * ═══════════════════════════════════════════════════════════════════════════
 *   • This file imports ONLY from '../core/eventBus.js'.
 *   • It is imported ONLY by engine.js (D-021 single boot call rule).
 *   • It NEVER mutates stateStore. All TTS state is ephemeral.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Node.js Safety
 * ═══════════════════════════════════════════════════════════════════════════
 *   All window.speechSynthesis calls are gated by the _IS_BROWSER constant.
 *   In headless Node.js harnesses, every preemption is logged via console.log
 *   so that test output shows H-022 coverage without crashing.
 */

import * as bus from '../core/eventBus.js';

// ═══════════════════════════════════════════════════════════════════════════
// Node.js Guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * True when running inside a browser that exposes window.speechSynthesis.
 */
const _IS_BROWSER = (
  typeof window !== 'undefined' &&
  typeof window.speechSynthesis !== 'undefined'
);

// ═══════════════════════════════════════════════════════════════════════════
// Module State
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collected bus unsubscribe functions for a clean teardown path.
 * @type {Array<() => void>}
 */
const _unsubs = [];

// ═══════════════════════════════════════════════════════════════════════════
// H-022 Preemption
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cancel the platform speech synthesis queue immediately.
 *
 * In a browser: calls window.speechSynthesis.cancel(), which stops the
 * current utterance and empties the queue.  The assertive ARIA live region
 * in browserAdapter.js can then write new text without competing with a
 * previously queued utterance.
 *
 * In Node.js: logs the preemption event for test traceability.
 *
 * @param {string} reason  The bus event name that triggered the preemption.
 */
function _preempt(reason) {
  if (_IS_BROWSER) {
    window.speechSynthesis.cancel();
  } else {
    console.log(`[ttsQueue] H-022 preempt — ${reason}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the TTS queue manager.
 *
 * Must be called exactly once from engine.js (D-021 single boot call).
 * Safe to call in Node.js — exits after registering bus listeners whose
 * browser-side path is guarded by _IS_BROWSER.
 */
function init() {
  // H-022: Subscribe to all four preemption-trigger events.
  // Each handler unconditionally cancels speech synthesis so that the audio
  // engine's procedural cues are never masked by a long-form TTS utterance.

  _unsubs.push(bus.on('BITE_NIBBLE', () => {
    _preempt('BITE_NIBBLE');
  }));

  _unsubs.push(bus.on('BITE_THUD', () => {
    _preempt('BITE_THUD');
  }));

  _unsubs.push(bus.on('FIGHT_THRESHOLD_CROSSED', () => {
    _preempt('FIGHT_THRESHOLD_CROSSED');
  }));

  _unsubs.push(bus.on('FIGHT_RESOLVED', () => {
    _preempt('FIGHT_RESOLVED');
  }));
}

export { init };
