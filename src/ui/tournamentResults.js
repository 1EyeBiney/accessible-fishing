/**
 * AFish Tournament Results UI — src/ui/tournamentResults.js
 *
 * Mount manifest for TOURNAMENT_RESULTS mode.
 *
 * This screen is shown after the tournament clock expires (or after the
 * tournament is otherwise ended). Its responsibilities are:
 *
 *   1. Read the final leaderboard from scoring.getLeaderboard().
 *   2. Determine the player's rank, the winner's name, and the winning
 *      metric (weight or fish count depending on winCondition).
 *   3. Emit UI_ANNOUNCE with a concise final results summary.
 *   4. Wait for INPUT_SPACEBAR, INPUT_ENTER, or INPUT_ESCAPE and return the
 *      player to MODES.HUB.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Announcement format
 * ───────────────────────────────────────────────────────────────────────────
 *
 * "Tournament over.
 *  [Winner] wins with [N fish | X.XX kg].
 *  You finished in [rank] place out of [total] anglers.
 *  [Optional: personal fish summary]
 *  Press Space or Enter to return to the hub."
 *
 * If the PLAYER is the winner the opening is replaced with:
 *   "Tournament over. Congratulations — you won!"
 *
 * ───────────────────────────────────────────────────────────────────────────
 * H-005 compliance
 * ───────────────────────────────────────────────────────────────────────────
 *   onUnmount drains _unsubs. Zero stray listeners after unmount.
 */

import * as bus        from '../core/eventBus.js';
import * as stateStore from '../core/stateStore.js';
import * as scoring    from '../tournament/scoring.js';
import { MODES, transitionTo } from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Convert ordinal rank number to English spoken ordinal.
 * E.g. 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th" …
 *
 * @param {number} rank
 * @returns {string}
 */
function _ordinal(rank) {
  const s   = ['th', 'st', 'nd', 'rd'];
  const v   = rank % 100;
  const suf = s[(v - 20) % 10] ?? s[v] ?? s[0];
  return `${rank}${suf}`;
}

/**
 * Format a weight in kg to a concise spoken string.
 *
 * @param {number} kg
 * @returns {string}
 */
function _fmtWeight(kg) {
  if (typeof kg !== 'number' || isNaN(kg)) return 'unknown weight';
  return `${kg.toFixed(2)} kg`;
}

/**
 * Build a spoken winning metric string from the winner's standing and the
 * active win condition.
 *
 * @param {import('../tournament/scoring.js').AnglerStanding} winner
 * @param {string}                                            winCondition
 * @returns {string}
 */
function _fmtWinningMetric(winner, winCondition) {
  switch (winCondition) {
    case 'HEAVIEST_BAG':
      return `${_fmtWeight(winner.totalWeight)} bag weight`;
    case 'BIGGEST_FISH':
      return `${_fmtWeight(winner.totalWeight)} biggest fish`;
    case 'TOTAL_CATCH_COUNT':
      return `${winner.catchCount} fish`;
    default:
      return winner.totalWeight > 0
        ? _fmtWeight(winner.totalWeight)
        : `${winner.catchCount} fish`;
  }
}

/**
 * Build a personal catch summary for the player entry, if they scored.
 *
 * @param {import('../tournament/scoring.js').AnglerStanding|undefined} playerStanding
 * @param {string}                                                       winCondition
 * @returns {string}
 */
function _fmtPlayerSummary(playerStanding, winCondition) {
  if (!playerStanding) return '';

  const count = playerStanding.catchCount;
  if (count === 0) return 'You were skunked — no fish landed.';

  const fishNoun = count === 1 ? 'fish' : 'fish';  // English: "fish" is same plural
  const countText = `You landed ${count} ${fishNoun}`;

  switch (winCondition) {
    case 'HEAVIEST_BAG':
      return `${countText} with a bag weight of ${_fmtWeight(playerStanding.totalWeight)}.`;
    case 'BIGGEST_FISH':
      return `${countText}. Best fish: ${_fmtWeight(playerStanding.totalWeight)}.`;
    case 'TOTAL_CATCH_COUNT':
      return `${countText}.`;
    default:
      return `${countText}.`;
  }
}

/**
 * Assemble the full results announcement.
 *
 * @returns {string}
 */
function _buildResultsText() {
  const spec         = stateStore.getState().tournament?.spec ?? null;
  const winCondition = spec?.winCondition ?? 'HEAVIEST_BAG';

  const leaderboard = scoring.getLeaderboard();
  const total       = leaderboard.length;

  if (total === 0) {
    return (
      'Tournament over. No scores were recorded. ' +
      'Press Space or Enter to return to the hub.'
    );
  }

  const winner        = leaderboard[0];
  const playerStanding = leaderboard.find((s) => s.anglerId === 'PLAYER');
  const playerRank    = playerStanding?.rank ?? total;

  const isPlayerWinner = playerStanding?.rank === 1;

  let openingLine;
  if (isPlayerWinner) {
    openingLine = 'Tournament over. Congratulations — you won!';
  } else {
    const winnerName   = winner.displayName ?? 'An unknown angler';
    const winnerMetric = _fmtWinningMetric(winner, winCondition);
    openingLine = `Tournament over. ${winnerName} wins with ${winnerMetric}.`;
  }

  const rankLine = total > 1
    ? `You finished in ${_ordinal(playerRank)} place out of ${total} anglers.`
    : 'You were the only angler.';

  const personalSummary = _fmtPlayerSummary(playerStanding, winCondition);

  const parts = [openingLine, rankLine];
  if (personalSummary) parts.push(personalSummary);
  parts.push('Press Space or Enter to return to the hub.');

  return parts.join(' ');
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
  transitionTo(MODES.HUB);
}

// ---------------------------------------------------------------------------
// Mount manifest
// ---------------------------------------------------------------------------

/**
 * @type {import('../core/modeRouter.js').MountManifest}
 */
export const tournamentResultsManifest = {
  id:    'ui:tournament-results',
  modes: [MODES.TOURNAMENT_RESULTS],

  /**
   * @param {string} _nextMode - always TOURNAMENT_RESULTS
   * @param {string} _prevMode - typically TOURNAMENT_ACTIVE
   */
  onMount(_nextMode, _prevMode) {
    const text = _buildResultsText();

    _unsubs = [
      bus.on('INPUT_SPACEBAR', _onConfirm),
      bus.on('INPUT_ENTER',    _onConfirm),
      bus.on('INPUT_ESCAPE',   _onConfirm),
    ];

    bus.emit('UI_ANNOUNCE', { text });

    if (typeof process !== 'undefined' && process.stdout) {
      console.log(`[tournamentResults] ${text}`);
    }
  },

  /**
   * @param {string} _prevMode - always TOURNAMENT_RESULTS
   * @param {string} _nextMode - typically HUB
   */
  onUnmount(_prevMode, _nextMode) {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
  },
};
