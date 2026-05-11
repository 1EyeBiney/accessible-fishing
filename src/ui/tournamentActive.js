/**
 * AFish Tournament Active UI — src/ui/tournamentActive.js
 *
 * Mount manifest for TOURNAMENT_ACTIVE mode.
 *
 * This module is a PURE ANNOUNCER. It contains zero game logic. Its only job
 * is to subscribe to game events on the bus, translate their payloads into
 * clear, concise, screen-reader-friendly strings, and emit UI_ANNOUNCE so
 * the browser's ARIA assertive live region reads them aloud.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Events handled → announcement text
 * ───────────────────────────────────────────────────────────────────────────
 *
 * TARGET_LOCKED       → "Target locked: [POI name or coordinates]."
 * FISH_FINDER_RESULTS → "Fish finder: [N] candidate(s) in range. [detail]"
 * CAST_LANDED         → "Cast landed. Splash: [silent|normal|loud]."
 * CAST_BIRDS_NEST     → "Bird's nest! Reel tangled. [N] seconds locked out."
 * BITE_NIBBLE         → "Nibble detected — get ready!"
 * BITE_THUD           → "Hookset! Press Up Arrow now!"
 * HOOKSET_MISSED      → "Missed the hookset. Fish got away."
 * FISH_HOOKED         → "Fish on! [species if known]."
 * FIGHT_TENSION       → (silent — audio engine covers this with synthesis)
 * FIGHT_PHASE_CHANGED → "Fight phase: [phase label]."
 * FIGHT_THRESHOLD_CROSSED → "Warning: line [near snapping | going slack]!"
 * FIGHT_RESOLVED      → outcome-specific: landed / snapped / shaken
 * AI_FISH_LANDED      → "[Bot name] landed a [species], [weight] kg."
 *                       + leaderboard impact if rank changed
 * SIMULATED_TOURNAMENT_SKUNK → "[Bot name] was skunked!"
 * CLOCK_STARTED       → "Tournament clock started."
 * CLOCK_PAUSED        → (silent — clock pause mid-fight would be disorienting)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Design principles
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   • Urgency priority: fight events > cast events > AI events > scores.
 *     When two events fire in rapid succession the ARIA region updates; the
 *     last write wins. The audio engine (Phase 8) fills the gaps with
 *     synthesised audio — this module handles the spoken word layer only.
 *
 *   • FIGHT_TENSION is intentionally NOT announced. The audio engine
 *     continuously maps tension to oscillator frequency — the player hears
 *     the line tension in real time. Speaking a number every 60 ms would
 *     drown out all other audio.
 *
 *   • FISH_FINDER_RESULTS omits exact fish counts (D-041 / D-042 — the
 *     finder never returns exact counts). The announced text matches the
 *     tier-appropriate fidelity.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * H-005 compliance
 * ───────────────────────────────────────────────────────────────────────────
 *   onUnmount empties _unsubs. Zero stray listeners after unmount.
 */

import * as bus from '../core/eventBus.js';
import { MODES } from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Convert a weight in kilograms to a readable string.
 * Values < 1 kg are shown in grams; ≥ 1 kg to two decimal places.
 *
 * @param {number} kg
 * @returns {string}
 */
function _fmtWeight(kg) {
  if (typeof kg !== 'number' || isNaN(kg)) return 'unknown weight';
  if (kg < 1) return `${Math.round(kg * 1000)} g`;
  return `${kg.toFixed(2)} kg`;
}

/**
 * Convert a SCREAMING_SNAKE_CASE string to Title Case with spaces.
 * @param {string} str
 * @returns {string}
 */
function _titleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Convert a fight phase identifier to a short spoken label.
 * Falls back to _titleCase for unrecognised phase names.
 *
 * @param {string} phase
 * @returns {string}
 */
function _fmtPhase(phase) {
  const PHASE_LABELS = {
    SLACK:     'Slack — fish near the boat',
    RUNNING:   'Running — fish pulling hard',
    FIGHTING:  'Fighting — tension building',
    NEAR_LAND: 'Near landing — keep the pressure on',
  };
  return PHASE_LABELS[phase] ?? _titleCase(phase);
}

/**
 * Format the FISH_FINDER_RESULTS candidates array into a spoken summary.
 * D-041/D-042: never reveals exact fish counts; uses presence hint wording.
 *
 * @param {Array<object>} candidates
 * @param {string}        tier - finder tier name (INTUITION through ELITE)
 * @returns {string}
 */
function _fmtFinderResults(candidates, tier) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return 'Fish finder: no activity detected in range.';
  }

  const count = candidates.length;
  const noun  = count === 1 ? 'location' : 'locations';

  // If any candidate has a presenceHint, use the highest one for the summary.
  const PRESENCE_RANK = { NONE: 0, TRACE: 1, SCATTERED: 2, SCHOOLED: 3 };
  let   bestPresence  = 'NONE';
  for (const c of candidates) {
    if (c.presenceHint && (PRESENCE_RANK[c.presenceHint] ?? 0) > (PRESENCE_RANK[bestPresence] ?? 0)) {
      bestPresence = c.presenceHint;
    }
  }

  const presenceText = {
    NONE:      'low activity',
    TRACE:     'faint trace activity',
    SCATTERED: 'scattered activity',
    SCHOOLED:  'schooled — strong activity',
  }[bestPresence] ?? 'activity detected';

  // At ELITE tier, include species band if available.
  let speciesText = '';
  if (tier === 'ELITE') {
    const bands = [...new Set(
      candidates
        .map(c => c.speciesBand)
        .filter(Boolean)
    )];
    if (bands.length > 0) {
      speciesText = ` Species band: ${bands.join(', ')}.`;
    }
  }

  return `Fish finder: ${count} ${noun} with ${presenceText}.${speciesText}`;
}

/**
 * Format a FIGHT_THRESHOLD_CROSSED payload into an urgent spoken warning.
 *
 * @param {object} payload
 * @param {string} payload.threshold
 * @returns {string}
 */
function _fmtThreshold(payload) {
  const THRESHOLD_TEXT = {
    SNAP_DANGER:  'Warning — line is near snapping! Ease up on the reel!',
    SLACK_DANGER: 'Warning — line going slack! Keep reeling!',
    LINE_SNAPPED: 'Line snapped! Fish lost.',
    SLACK_LOST:   'Fish shook the hook — slack too long.',
  };
  return THRESHOLD_TEXT[payload?.threshold]
    ?? `Line warning: ${_titleCase(payload?.threshold ?? 'unknown')}.`;
}

/**
 * Format a FIGHT_RESOLVED payload.
 *
 * @param {object} payload
 * @param {string} payload.outcome      - FISH_LANDED | LINE_SNAPPED | HOOK_SHAKEN
 * @param {object} payload.fishInstance - has .speciesId, .weightKg, .isTrophy
 * @returns {string}
 */
function _fmtFightResolved(payload) {
  const { outcome, fishInstance } = payload ?? {};
  const species = fishInstance?.speciesId
    ? _titleCase(fishInstance.speciesId)
    : 'Fish';
  const weight = fishInstance?.weightKg != null
    ? ` — ${_fmtWeight(fishInstance.weightKg)}`
    : '';
  const trophy = fishInstance?.isTrophy ? ' Trophy!' : '';

  switch (outcome) {
    case 'FISH_LANDED':
      return `Fish landed! ${species}${weight}.${trophy} Well done!`;
    case 'LINE_SNAPPED':
      return `Line snapped! You lost the ${species}. Re-rig and try again.`;
    case 'HOOK_SHAKEN':
      return `The ${species} shook the hook. Better luck next cast.`;
    default:
      return `Fight ended: ${_titleCase(outcome ?? 'unknown')}.`;
  }
}

/**
 * Format an AI_FISH_LANDED payload into a competitive update.
 * D-061: lureId is intentionally absent from the payload.
 *
 * @param {object} payload
 * @returns {string}
 */
function _fmtAiCatch(payload) {
  const {
    botDisplayName,
    speciesDisplayName,
    weightKg,
    isTrophy,
    leaderboardImpact,
  } = payload ?? {};

  const name    = botDisplayName        ?? 'A competitor';
  const species = speciesDisplayName
    ? speciesDisplayName
    : (payload?.speciesId ? _titleCase(payload.speciesId) : 'a fish');
  const weight  = weightKg != null ? ` — ${_fmtWeight(weightKg)}` : '';
  const trophyS = isTrophy ? ' Trophy fish!' : '';

  let text = `${name} landed ${species}${weight}.${trophyS}`;

  // Announce rank change if the bot took the lead (D-062 TTS priority ladder).
  if (leaderboardImpact?.tookTheLead) {
    text += ` ${name} is now in first place!`;
  } else if (
    leaderboardImpact?.newRank != null &&
    leaderboardImpact?.previousRank != null &&
    leaderboardImpact.newRank < leaderboardImpact.previousRank
  ) {
    text += ` They move up to rank ${leaderboardImpact.newRank}.`;
  }

  return text;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Array<() => void>} */
let _unsubs = [];

// ---------------------------------------------------------------------------
// Individual event handlers
// Each calls _announce() with a formatted string.
// ---------------------------------------------------------------------------

/**
 * Emit a UI_ANNOUNCE event and optionally log to stdout (Node.js only).
 * All handlers funnel through here for consistency.
 *
 * @param {string} text
 */
function _announce(text) {
  bus.emit('UI_ANNOUNCE', { text });
  if (typeof process !== 'undefined' && process.stdout) {
    console.log(`[tournamentActive] ${text}`);
  }
}

function _onTargetLocked(payload) {
  const poiId = payload?.poiId ?? payload?.targetId ?? 'unknown location';
  _announce(`Target locked: ${_titleCase(String(poiId))}.`);
}

function _onFinderResults(payload) {
  _announce(_fmtFinderResults(payload?.candidates, payload?.tier));
}

function _onCastLanded(payload) {
  const splash = _titleCase(payload?.splashKind ?? 'normal');
  _announce(`Cast landed. Splash: ${splash}.`);
}

function _onBirdsNest(payload) {
  const nestMs      = payload?.nestDurationMs ?? 0;
  const nestSeconds = Math.round(nestMs / 1000);
  const timeText    = nestSeconds > 0
    ? `${nestSeconds} second${nestSeconds !== 1 ? 's' : ''} locked out.`
    : 'Reel locked out.';
  _announce(`Bird's nest! Reel tangled. ${timeText}`);
}

function _onBiteNibble() {
  _announce("Nibble detected — get ready!");
}

function _onBiteThud() {
  _announce("Hookset! Press Up Arrow now!");
}

function _onHooksetMissed() {
  _announce("Missed the hookset. Fish got away.");
}

function _onFishHooked(payload) {
  const species = payload?.fishInstance?.speciesId
    ? _titleCase(payload.fishInstance.speciesId)
    : '';
  _announce(`Fish on!${species ? ' ' + species + '.' : ''}`);
}

function _onFightPhaseChanged(payload) {
  const phase = _fmtPhase(payload?.phase ?? '');
  _announce(`Fight phase: ${phase}.`);
}

function _onFightThresholdCrossed(payload) {
  _announce(_fmtThreshold(payload));
}

function _onFightResolved(payload) {
  _announce(_fmtFightResolved(payload));
}

function _onAiFishLanded(payload) {
  _announce(_fmtAiCatch(payload));
}

function _onSimulatedSkunk(payload) {
  const name = payload?.botDisplayName ?? 'A competitor';
  // Optionally include the bot's custom skunk phrase if present (D-061).
  const phrase = payload?.skunkPhrase ? ` "${payload.skunkPhrase}"` : '';
  _announce(`${name} finished with zero fish.${phrase}`);
}

function _onClockStarted() {
  _announce('Tournament clock started. Good luck!');
}

// ---------------------------------------------------------------------------
// Mount manifest
// ---------------------------------------------------------------------------

/**
 * @type {import('../core/modeRouter.js').MountManifest}
 */
export const tournamentActiveManifest = {
  id:    'ui:tournament-active',
  modes: [MODES.TOURNAMENT_ACTIVE],

  /**
   * @param {string} _nextMode - always TOURNAMENT_ACTIVE
   * @param {string} _prevMode - typically TOURNAMENT_BRIEFING
   */
  onMount(_nextMode, _prevMode) {
    _unsubs = [
      // ── Targeting / casting ──────────────────────────────────────────────
      bus.on('TARGET_LOCKED',          _onTargetLocked),
      bus.on('FISH_FINDER_RESULTS',    _onFinderResults),
      bus.on('CAST_LANDED',            _onCastLanded),
      bus.on('CAST_BIRDS_NEST',        _onBirdsNest),

      // ── Bite sequence ────────────────────────────────────────────────────
      bus.on('BITE_NIBBLE',            _onBiteNibble),
      bus.on('BITE_THUD',              _onBiteThud),
      bus.on('HOOKSET_MISSED',         _onHooksetMissed),
      bus.on('FISH_HOOKED',            _onFishHooked),

      // ── Fight progression ─────────────────────────────────────────────────
      // FIGHT_TENSION intentionally omitted — audio engine covers this.
      bus.on('FIGHT_PHASE_CHANGED',    _onFightPhaseChanged),
      bus.on('FIGHT_THRESHOLD_CROSSED',_onFightThresholdCrossed),
      bus.on('FIGHT_RESOLVED',         _onFightResolved),

      // ── AI / leaderboard ──────────────────────────────────────────────────
      bus.on('AI_FISH_LANDED',         _onAiFishLanded),
      bus.on('SIMULATED_TOURNAMENT_SKUNK', _onSimulatedSkunk),

      // ── Clock ─────────────────────────────────────────────────────────────
      bus.on('CLOCK_STARTED',          _onClockStarted),
    ];

    // Announce game start so the player knows the tournament is live.
    _announce('Tournament started. Use the fish finder, then cast.');
  },

  /**
   * @param {string} _prevMode - always TOURNAMENT_ACTIVE
   * @param {string} _nextMode - typically TOURNAMENT_RESULTS
   */
  onUnmount(_prevMode, _nextMode) {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
  },
};
