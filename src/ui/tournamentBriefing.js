/**
 * AFish Tournament Briefing UI — src/ui/tournamentBriefing.js
 *
 * Mount manifest for TOURNAMENT_BRIEFING mode.
 *
 * TOURNAMENT_BRIEFING is the interstitial between the Hub and the live
 * tournament. Its job is to read the tournament parameters aloud so the
 * player knows what they are getting into before committing to the run.
 *
 * On mount:
 *   • Reads the tournament spec from stateStore (tier, win condition,
 *     duration) and formats it into a concise ARIA-friendly summary.
 *   • Emits UI_ANNOUNCE with the briefing text so the screen reader speaks
 *     it immediately.
 *   • Subscribes to INPUT_SPACEBAR and INPUT_ENTER (tap events, D-029) to
 *     detect the "start tournament" confirm.
 *
 * On confirm:
 *   • Transitions to TOURNAMENT_ACTIVE via modeRouter.transitionTo().
 *   • modeRouter then calls onUnmount (cleanup) and onMount of every
 *     TOURNAMENT_ACTIVE manifest in registration order.
 *
 * On unmount:
 *   • Removes all bus subscriptions (H-005).
 *
 * Tournament spec fields read (state.tournament.spec):
 *   tier         {number}  1–5 — controls AI difficulty
 *   winCondition {string}  'HEAVIEST_BAG' | 'BIGGEST_FISH' | 'TOTAL_CATCH_COUNT'
 *   durationMs   {number}  tournament length in milliseconds
 *
 * If state.tournament.spec is null (e.g. testing without a spec), sensible
 * defaults are shown so the screen never silently fails.
 */

import * as bus        from '../core/eventBus.js';
import * as stateStore from '../core/stateStore.js';
import { MODES, transitionTo } from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable labels for the win-condition identifiers (D-063).
 * @type {Record<string, string>}
 */
const WIN_CONDITION_LABELS = {
  HEAVIEST_BAG:       'Heaviest Bag — top five fish by weight',
  BIGGEST_FISH:       'Biggest Fish — single heaviest catch wins',
  TOTAL_CATCH_COUNT:  'Total Catch Count — most fish landed wins',
};

/**
 * Convert a duration in milliseconds to a human-readable English string.
 * Examples: 3 600 000 → "1 hour", 900 000 → "15 minutes"
 *
 * @param {number} ms
 * @returns {string}
 */
function _formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes <= 0) return 'unlimited';
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes !== 1 ? 's' : ''}`;
  const hours   = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hLabel  = `${hours} hour${hours !== 1 ? 's' : ''}`;
  if (minutes === 0) return hLabel;
  const mLabel  = `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return `${hLabel} and ${mLabel}`;
}

/**
 * Convert a tier number to a label string.
 * @param {number} tier
 * @returns {string}
 */
function _formatTier(tier) {
  const labels = ['Beginner', 'Novice', 'Intermediate', 'Expert', 'Legend'];
  const label  = (tier >= 1 && tier <= 5) ? labels[tier - 1] : `Tier ${tier}`;
  return `${label} (Tier ${tier})`;
}

/**
 * Build the full briefing announcement text from the tournament spec.
 *
 * @param {object|null} spec - state.tournament.spec, or null if not set
 * @returns {string}
 */
function _buildBriefingText(spec) {
  const tier          = spec?.tier         ?? 1;
  const winCondition  = spec?.winCondition ?? 'HEAVIEST_BAG';
  const durationMs    = spec?.durationMs   ?? 3_600_000;

  const tierLabel      = _formatTier(tier);
  const winLabel       = WIN_CONDITION_LABELS[winCondition]
                         ?? winCondition.replace(/_/g, ' ').toLowerCase();
  const durationLabel  = _formatDuration(durationMs);

  return (
    `Tournament Briefing. ` +
    `Difficulty: ${tierLabel}. ` +
    `Scoring: ${winLabel}. ` +
    `Time limit: ${durationLabel}. ` +
    `Press Space or Enter to start the tournament, or Escape to return to the hub.`
  );
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Array<() => void>} */
let _unsubs = [];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function _onConfirm() {
  transitionTo(MODES.TOURNAMENT_ACTIVE);
}

function _onBack() {
  transitionTo(MODES.HUB);
}

// ---------------------------------------------------------------------------
// Mount manifest
// ---------------------------------------------------------------------------

/**
 * @type {import('../core/modeRouter.js').MountManifest}
 */
export const tournamentBriefingManifest = {
  id:    'ui:tournament-briefing',
  modes: [MODES.TOURNAMENT_BRIEFING],

  /**
   * @param {string} _nextMode - always TOURNAMENT_BRIEFING
   * @param {string} _prevMode - typically HUB
   */
  onMount(_nextMode, _prevMode) {
    const spec = stateStore.getState().tournament?.spec ?? null;
    const text = _buildBriefingText(spec);

    _unsubs = [
      bus.on('INPUT_SPACEBAR', _onConfirm),
      bus.on('INPUT_ENTER',    _onConfirm),
      bus.on('INPUT_ESCAPE',   _onBack),
    ];

    bus.emit('UI_ANNOUNCE', { text });

    if (typeof process !== 'undefined' && process.stdout) {
      console.log(`[tournamentBriefing] ${text}`);
    }
  },

  /**
   * @param {string} _prevMode - always TOURNAMENT_BRIEFING
   * @param {string} _nextMode - TOURNAMENT_ACTIVE or HUB
   */
  onUnmount(_prevMode, _nextMode) {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
  },
};
