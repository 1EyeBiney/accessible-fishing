/**
 * AFish Competitor AI — src/tournament/competitorAI.js
 *
 * Public API Contract (§9 — AI / TOURNAMENT):
 *   mountForTournament(tournamentSpec) → void  (also called by mount manifest onMount)
 *   unmount()                          → void  (also called by mount manifest onUnmount)
 *
 * Decisions implemented:
 *   D-005 — AI runs in "brain mode" against a precomputed structure index (H-002); never
 *            scans raw grid cells per-tick. Bot fish-probability evaluated on scheduled
 *            cooldown callbacks only (D-013).
 *   D-006 — Distinct personality roster including Bill the Legend.
 *   D-054 — Arms Race AI Progression (LOCKED): tournament spec carries `aiGearTier` (1–5)
 *            that scales bot weights and G factor. Bots have no persistent inventory.
 *   D-058 — Bot Profile Schema (LOCKED): six archetypes + Bill the Legend data override.
 *            All stats normalised [0..1]. lureRotation hand-curated per bot.
 *   D-059 — Headless Success Equation (LOCKED):
 *              P_catch = base(tier) · S(skill) · G(gearTier) · W · M_lure↔species
 *                        · M_lure↔poi · R(pressure)
 *            Final clamped [0.05, 0.95]. NO desperation mode.
 *   D-060 — Bot Cooldown Cadence (LOCKED):
 *              botCooldownMs = baseTickMs(tier) * (1.5 − 0.5 * skill) * weatherTickMod
 *            Under-tier penalty: tierSkillCurve.underTier = 0.70.
 *   D-061 — AI_FISH_LANDED event schema (LOCKED; brief calls this SIMULATED_CATCH).
 *            `lureId` intentionally omitted from the emitted payload (D-061) so players
 *            cannot reverse-engineer bot tackle. It is used internally only.
 *            SIMULATED_TOURNAMENT_SKUNK emitted on tournament-end for zero-fish bots.
 *   D-062 — TTS Priority Ladder (LOCKED): URGENT / HIGH / NORMAL / LOW attached to each
 *            AI_FISH_LANDED payload. Consumed by audio/ttsQueue.js (D-021 boundary).
 *   D-063 — Win-Condition Objective Switch (LOCKED): bots read tournament.rules.winCondition
 *            on mount and apply mismatch penalty to S(skill) without mutating personality.
 *   D-064 — Bot Count Scaling (LOCKED): total field = [5,6,6,7,8] for tier 1..5.
 *            Slot-fill: low tiers weight toward GRINDER / RUN_AND_GUN; high tiers weight
 *            toward TROPHY_HUNTER / METHODICAL / legendary.
 *   H-015 — Sub-Stream Determinism: every bot uses rngStream('aiBrain:'+id) for lure
 *            rotation / POI selection and rngStream('aiCatch:'+id) for P_catch rolls and
 *            weight sampling. Streams are NEVER shared across bots or with world RNG.
 *   H-016 — Leaderboard-Before-Emit Ordering: computeImpact → commit → emit execute
 *            synchronously in one call-stack frame per catch event.
 *   H-018 — Same-Tick Bot Catch Ordering: each bot owns one clock.every handle; the
 *            clock fires them one at a time in insertion order. Each bot's full pipeline
 *            (computeImpact → commit → emit) completes before the next bot's callback
 *            runs. Batched same-tick processing is FORBIDDEN and cannot occur here.
 *   H-005 — All clock handles and bus subscriptions cancelled in onUnmount().
 *
 * Events emitted:
 *   AI_FISH_LANDED            { type, atMs, botId, botDisplayName, personalityArchetype,
 *                               speciesId, speciesDisplayName, weightKg, isTrophy,
 *                               isPersonalBest, poiId, leaderboardImpact, ttsPriority,
 *                               phraseToken, rngSeed }
 *   SIMULATED_TOURNAMENT_SKUNK { botId, botDisplayName, skunkPhrase, atMs }
 *
 * Events consumed: none. All logic is clock-driven (D-013).
 *
 * Note on event naming: the user-facing event for AI catches is 'AI_FISH_LANDED'.
 * The brief (D-061) calls this event 'SIMULATED_CATCH'. Both names refer to the same
 * concept. Downstream consumers (audio/ttsQueue, scoring.js) should subscribe to
 * 'AI_FISH_LANDED'. If the brief is amended, rename here and in scoring.js together.
 */

import * as bus            from '../core/eventBus.js';
import * as clock          from '../core/clock.js';
import * as rng            from '../core/rng.js';
import * as stateStore     from '../core/stateStore.js';
import * as poiGraph       from '../world/poiGraph.js';
import * as equipment      from '../equipment/equipment.js';
import { MODES, registerMountManifest } from '../core/modeRouter.js';
import {
  SPECIES_CATALOG,
  PRESSURE_STRIKE_PENALTY,
} from '../fish/fishBehavior.js';
import * as scoring from './scoring.js';

// ===========================================================================
// Constants — D-059, D-060 (LOCKED)
// ===========================================================================

/** D-059: base catch probability per event tier (1..5). Index = tier − 1. */
const BASE_P_BY_TIER = Object.freeze([0.45, 0.40, 0.35, 0.30, 0.25]);

/** D-060: base cooldown between catches (ms) per event tier. Index = tier − 1. */
const BASE_COOLDOWN_BY_TIER_MS = Object.freeze([180_000, 150_000, 120_000, 90_000, 60_000]);

/** D-059: weight scaling multiplier per AI gear tier. Index = aiGearTier − 1. */
const TIER_WEIGHT_CURVE = Object.freeze([0.85, 0.92, 1.00, 1.08, 1.18]);

/** D-060: clock-tick modifier by current lake weather quality. */
const WEATHER_TICK_MOD = Object.freeze({ optimal: 0.85, neutral: 1.00, harsh: 1.30 });

/** D-060: P_catch weather multiplier mapped from weather quality. */
const WEATHER_P_MOD = Object.freeze({ optimal: 1.0, neutral: 0.5, harsh: 0.0 });

/**
 * D-064: total competitor count (player + AI) per tier.
 * AI bot count = BOT_COUNT_BY_TIER[tierIdx] − 1 (subtract the player slot).
 */
const TOTAL_FIELD_BY_TIER = Object.freeze([5, 6, 6, 7, 8]);

/** D-062: cut-line fraction of the field that receives NORMAL TTS priority. */
const CUT_LINE_FRACTION = 0.50;

/** D-060: LOCKED under-tier penalty multiplier (also the floor of tierSkillCurve). */
const UNDER_TIER_PENALTY = 0.70;

// Species display names for event payloads.
const SPECIES_DISPLAY_NAMES = Object.freeze({
  LARGEMOUTH_BASS: 'Largemouth Bass',
  SMALLMOUTH_BASS: 'Smallmouth Bass',
  SPOTTED_BASS:    'Spotted Bass',
  BLUEGILL:        'Bluegill',
  RAINBOW_TROUT:   'Rainbow Trout',
  CATFISH:         'Channel Catfish',
  CRAPPIE:         'Crappie',
});

// ===========================================================================
// Bot Catalog — D-058, D-006 (8 bots; 6 archetypes + Bill the Legend)
// All stats normalised [0..1] except hand-curated rotations and audio tokens.
// lureRotation is hand-curated per bot (NOT auto-generated — D-058 LOCKED).
// targetPreference sums to 1.0 (VOLUME + BALANCED + TROPHY = 1.0).
// ===========================================================================

const BOT_CATALOG = Object.freeze([

  // ── Tier-1+ bots: GRINDER / RUN_AND_GUN / GAMBLER ────────────────────────

  Object.freeze({
    id:                   'benny_voss',
    displayName:          'Benny Voss',
    personalityArchetype: 'GRINDER',
    naturalTier:          1,
    patience:             0.38,
    targetPreference:     Object.freeze({ VOLUME: 0.70, BALANCED: 0.25, TROPHY: 0.05 }),
    adaptability:         0.50,
    skill:                0.42,
    poiSelectionBias:     0.30,        // prefers shallow, accessible structure
    weatherSensitivity:   0.55,
    lureRotation: Object.freeze([
      'LURE_WILLOW_SPINNER',
      'LURE_SHALLOW_CRANK',
      'LURE_PLASTIC_WORM_6IN',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.88 }),
    audio: Object.freeze({
      ttsVoiceId:      'BENNY_VOSS',
      catchPhrasePool: Object.freeze(['THATS_A_KEEPER', 'ANOTHER_ONE', 'NOT_BAD_NOT_BAD', 'STILL_GRINDING']),
      skunkPhrase:     'ROUGH_DAY_ON_THE_WATER',
    }),
  }),

  Object.freeze({
    id:                   'skip_harmon',
    displayName:          'Skip Harmon',
    personalityArchetype: 'GAMBLER',
    naturalTier:          1,
    patience:             0.20,
    targetPreference:     Object.freeze({ VOLUME: 0.30, BALANCED: 0.30, TROPHY: 0.40 }),
    adaptability:         0.88,
    skill:                0.50,
    poiSelectionBias:     0.65,        // aggressive deep-structure gambles
    weatherSensitivity:   0.40,
    lureRotation: Object.freeze([
      'LURE_PENCIL_POPPER',
      'LURE_WALKING_FROG',
      'LURE_DEEP_DIVER',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.82 }),
    audio: Object.freeze({
      ttsVoiceId:      'SKIP_HARMON',
      catchPhrasePool: Object.freeze(['KNEW_IT', 'GAMBLE_PAID_OFF', 'PAID_TO_BE_BOLD', 'TAKE_THE_RISK']),
      skunkPhrase:     'GAMBLE_LOST_TODAY',
    }),
  }),

  // ── Tier-2+ bots: GRINDER (skilled) / RUN_AND_GUN / OPPORTUNIST ──────────

  Object.freeze({
    id:                   'greta_snaggs',
    displayName:          'Greta Snaggs',
    personalityArchetype: 'GRINDER',
    naturalTier:          2,
    patience:             0.80,
    targetPreference:     Object.freeze({ VOLUME: 0.65, BALANCED: 0.30, TROPHY: 0.05 }),
    adaptability:         0.60,
    skill:                0.62,
    poiSelectionBias:     0.40,
    weatherSensitivity:   0.50,
    lureRotation: Object.freeze([
      'LURE_PLASTIC_WORM_6IN',
      'LURE_SWIM_JIG',
      'LURE_FOOTBALL_JIG',
      'LURE_COLORADO_SPINNER',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.88 }),
    audio: Object.freeze({
      ttsVoiceId:      'GRETA_SNAGGS',
      catchPhrasePool: Object.freeze(['CONSISTENCY_WINS', 'STEADY_AS_SHE_GOES', 'ANOTHER_IN_THE_WELL', 'KEEP_AT_IT']),
      skunkPhrase:     'NOT_MY_WATER_TODAY',
    }),
  }),

  Object.freeze({
    id:                   'ray_calloway',
    displayName:          'Ray Calloway',
    personalityArchetype: 'RUN_AND_GUN',
    naturalTier:          2,
    patience:             0.15,
    targetPreference:     Object.freeze({ VOLUME: 0.55, BALANCED: 0.35, TROPHY: 0.10 }),
    adaptability:         0.92,
    skill:                0.55,
    poiSelectionBias:     0.50,
    weatherSensitivity:   0.30,
    lureRotation: Object.freeze([
      'LURE_WILLOW_SPINNER',
      'LURE_SHALLOW_CRANK',
      'LURE_PADDLE_TAIL',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.85 }),
    audio: Object.freeze({
      ttsVoiceId:      'RAY_CALLOWAY',
      catchPhrasePool: Object.freeze(['ON_THE_MOVE', 'QUICK_LIMIT', 'COVER_WATER', 'KEEP_MOVING']),
      skunkPhrase:     'BURNED_TOO_FAST',
    }),
  }),

  Object.freeze({
    id:                   'mira_santos',
    displayName:          'Mira Santos',
    personalityArchetype: 'OPPORTUNIST',
    naturalTier:          2,
    patience:             0.55,
    targetPreference:     Object.freeze({ VOLUME: 0.40, BALANCED: 0.45, TROPHY: 0.15 }),
    adaptability:         0.90,
    skill:                0.60,
    poiSelectionBias:     0.55,
    weatherSensitivity:   0.25,        // nearly weather-immune — reads conditions well
    lureRotation: Object.freeze([
      'LURE_SWIM_JIG',
      'LURE_SUSPENDING_JERKBAIT',
      'LURE_COLORADO_SPINNER',
      'LURE_CASTING_SPOON',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.86 }),
    audio: Object.freeze({
      ttsVoiceId:      'MIRA_SANTOS',
      catchPhrasePool: Object.freeze(['READ_THE_WATER', 'CONDITIONS_MATCHED', 'ADAPTING_AND_SCORING', 'RIGHT_PLACE_RIGHT_TIME']),
      skunkPhrase:     'MISSED_THE_WINDOW',
    }),
  }),

  // ── Tier-3+ bots: TROPHY_HUNTER / METHODICAL ─────────────────────────────

  Object.freeze({
    id:                   'carl_tibbs',
    displayName:          'Carl Tibbs',
    personalityArchetype: 'TROPHY_HUNTER',
    naturalTier:          3,
    patience:             0.75,
    targetPreference:     Object.freeze({ VOLUME: 0.10, BALANCED: 0.20, TROPHY: 0.70 }),
    adaptability:         0.65,
    skill:                0.70,
    poiSelectionBias:     0.80,        // deep structure, ambush points
    weatherSensitivity:   0.35,
    lureRotation: Object.freeze([
      'LURE_FOOTBALL_JIG',
      'LURE_PLASTIC_WORM_6IN',
      'LURE_DEEP_DIVER',
      'LURE_GLIDE_BAIT',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.87 }),
    audio: Object.freeze({
      ttsVoiceId:      'CARL_TIBBS',
      catchPhrasePool: Object.freeze(['THATS_A_TOAD', 'TROPHY_CONFIRMED', 'WORTH_THE_WAIT', 'KNEW_SHE_WAS_THERE']),
      skunkPhrase:     'PATIENCE_RAN_OUT',
    }),
  }),

  Object.freeze({
    id:                   'donna_peake',
    displayName:          'Donna Peake',
    personalityArchetype: 'METHODICAL',
    naturalTier:          4,
    patience:             0.90,
    targetPreference:     Object.freeze({ VOLUME: 0.20, BALANCED: 0.55, TROPHY: 0.25 }),
    adaptability:         0.72,
    skill:                0.75,
    poiSelectionBias:     0.70,
    weatherSensitivity:   0.40,
    lureRotation: Object.freeze([
      'LURE_SWIM_JIG',
      'LURE_FOOTBALL_JIG',
      'LURE_PLASTIC_WORM_6IN',
      'LURE_DEEP_DIVER',
      'LURE_SUSPENDING_JERKBAIT',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.88 }),
    audio: Object.freeze({
      ttsVoiceId:      'DONNA_PEAKE',
      catchPhrasePool: Object.freeze(['SYSTEMATIC_APPROACH', 'PATTERN_CONFIRMED', 'METHODICAL_RESULT', 'COVERAGE_COMPLETE']),
      skunkPhrase:     'PATTERN_ELUDED_ME',
    }),
  }),

  // ── Legendary — Tier-3+ only; dominant at Tier 5 ─────────────────────────

  Object.freeze({
    id:                   'bill_the_legend',
    displayName:          'Bill the Legend',
    personalityArchetype: 'TROPHY_HUNTER',
    naturalTier:          5,           // only appears at event tier 3+
    patience:             0.92,
    targetPreference:     Object.freeze({ VOLUME: 0.05, BALANCED: 0.15, TROPHY: 0.80 }),
    adaptability:         0.96,
    skill:                1.00,        // maximum skill
    poiSelectionBias:     0.90,        // always targets the highest-value deep structure
    weatherSensitivity:   0.15,        // nearly unaffected by harsh weather
    lureRotation: Object.freeze([
      'LURE_DEEP_DIVER',
      'LURE_FOOTBALL_JIG',
      'LURE_GLIDE_BAIT',
      'LURE_FLUTTER_SPOON',
      'LURE_CREATURE_BAIT',
    ]),
    tierSkillCurve: Object.freeze({ matchedTier: 1.00, underTier: UNDER_TIER_PENALTY, overTier: 0.88 }),
    audio: Object.freeze({
      ttsVoiceId:      'BILL_LEGEND',
      catchPhrasePool: Object.freeze([
        'THAT_IS_A_FISH', 'LEGEND_STILL_HAS_IT', 'LUNKER_ALERT',
        'SEEN_BIGGER_IN_MY_SLEEP', 'TEXTBOOK_EXECUTION', 'JUST_ANOTHER_DAY',
      ]),
      skunkPhrase:     'EVEN_LEGENDS_BLANK',
    }),
  }),
]);

// ===========================================================================
// Tier-weight table for D-064 weighted slot-fill.
// Each array has 5 elements (one per event tier, index = tier − 1).
// Higher weight = more likely to be selected at that tier.
// Bill and Donna have weight 0 at tier 1–2 (never show up at low events).
// ===========================================================================

const TIER_WEIGHTS = Object.freeze({
  benny_voss:      Object.freeze([5, 4, 2, 1, 0]),  // GRINDER  — dominates low tier
  skip_harmon:     Object.freeze([4, 4, 2, 1, 1]),  // GAMBLER  — present at all tiers
  greta_snaggs:    Object.freeze([4, 5, 3, 2, 1]),  // GRINDER  — peaks tier 2
  ray_calloway:    Object.freeze([3, 5, 3, 2, 1]),  // RUN_AND_GUN — peaks tier 2
  mira_santos:     Object.freeze([2, 4, 5, 3, 2]),  // OPPORTUNIST — peaks tier 3
  carl_tibbs:      Object.freeze([1, 2, 5, 5, 3]),  // TROPHY_HUNTER — tier 3+
  donna_peake:     Object.freeze([0, 0, 2, 5, 5]),  // METHODICAL — tier 3+
  bill_the_legend: Object.freeze([0, 0, 1, 3, 6]),  // Legendary — tier 3+; dominant at 5
});

// ===========================================================================
// Module state
// ===========================================================================

/** Currently active bot instances (selected for this tournament). */
let _activeBotList  = [];

/** Handle ids returned by clock.every() — one per active bot. H-005 cancel. */
let _clockHandles   = [];

/**
 * Per-bot ephemeral runtime stats (reset on each mount).
 * @type {Map<string, { personalBest: number, catchCount: number }>}
 */
let _botRuntimes    = new Map();

/**
 * Map from lureId → category string, pre-built from the equipment catalog at mount time.
 * @type {Map<string, string>}
 */
let _lureCategories = new Map();

/**
 * Available POI IDs from the current world, collected at mount time via poiGraph.
 * Used by bots to label their catch events with a plausible POI (H-015 brainRng).
 * @type {string[]}
 */
let _availablePoiIds = [];

/** Snapshot of the tournament spec for the current run. */
let _tournamentSpec = null;

/**
 * 1-based cut-line rank. Bots ranked ≤ this receive NORMAL TTS priority (D-062).
 */
let _cutLineRank = 1;

// ===========================================================================
// Private helpers
// ===========================================================================

/**
 * Select `count` distinct bots for the event tier using weighted sampling
 * without replacement (D-064 slot-fill rule). Uses a tournament-scoped
 * setup RNG stream (not a per-bot stream; neither brainRng nor catchRng).
 *
 * @param {number}    tier       - event tier 1..5
 * @param {number}    count      - how many bots to select
 * @param {{weightedPick, pick}} setupRng - rngStream for roster decisions
 * @returns {Array}  selected bot profile objects from BOT_CATALOG
 */
function _selectBots(tier, count, setupRng) {
  const tierIdx    = Math.min(4, Math.max(0, tier - 1));
  const available  = BOT_CATALOG.slice();   // mutable working copy
  const selected   = [];

  while (selected.length < count && available.length > 0) {
    const weights = available.map(bot => TIER_WEIGHTS[bot.id]?.[tierIdx] ?? 0);

    // If all weights are 0 (shouldn't happen with our catalog), fall back to uniform.
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const bot = totalWeight > 0
      ? setupRng.weightedPick(available, weights)
      : setupRng.pick(available);

    selected.push(bot);
    available.splice(available.indexOf(bot), 1);
  }

  return selected;
}

/**
 * Compute G(gearTier) for the D-059 headless equation.
 *
 * Comparison is event aiGearTier vs bot's naturalTier:
 *   aiGearTier === bot.naturalTier → matchedTier (1.00)
 *   aiGearTier >  bot.naturalTier → underTier  (0.70) — bot's gear is behind event standard
 *   aiGearTier <  bot.naturalTier → overTier   (0.85) — bot is over-geared for the event
 *
 * @param {object} bot
 * @param {number} aiGearTier - from tournament spec
 * @returns {number}
 */
function _computeG(bot, aiGearTier) {
  if (aiGearTier === bot.naturalTier) return bot.tierSkillCurve.matchedTier;
  if (aiGearTier >  bot.naturalTier)  return bot.tierSkillCurve.underTier;
  /* aiGearTier < bot.naturalTier */  return bot.tierSkillCurve.overTier;
}

/**
 * Compute the objective alignment score for the D-063 mismatch penalty.
 *
 * Alignment ∈ [0..1]: 1 = perfectly aligned with this win condition; 0 = misaligned.
 * mismatchPenalty = 1 − 0.20 * (1 − alignment)  ∈ [0.80, 1.00]
 *
 * @param {object} bot
 * @param {string} winCondition - 'HEAVIEST_BAG' | 'BIGGEST_FISH' | 'TOTAL_CATCH_COUNT'
 * @returns {{ alignment: number, mismatchPenalty: number }}
 */
function _computeObjectiveAlignment(bot, winCondition) {
  let alignment;
  switch (winCondition) {
    case 'BIGGEST_FISH':
      // Trophy hunters strongly aligned; volume grinders heavily penalised.
      alignment = bot.targetPreference.TROPHY;
      break;
    case 'TOTAL_CATCH_COUNT':
      // Volume grinders strongly aligned; trophy hunters penalised.
      alignment = bot.targetPreference.VOLUME;
      break;
    case 'HEAVIEST_BAG':
    default:
      // Balanced bots are most aligned; hybrid of volume and balance.
      alignment = bot.targetPreference.BALANCED * 0.6 + bot.targetPreference.VOLUME * 0.4;
      break;
  }
  const mismatchPenalty = 1 - 0.20 * (1 - alignment);
  return { alignment, mismatchPenalty };
}

/**
 * Build the lure → category lookup cache by querying the equipment catalog.
 * Invalid lure IDs (not in catalog) are silently skipped; their catches
 * will use a neutral M_lure_species = 0.40.
 *
 * @param {string[][]} lureRotations - array of per-bot lure ID arrays
 * @returns {Map<string,string>} lureId → category
 */
function _buildLureCategories(lureRotations) {
  const cache      = new Map();
  const uniqueIds  = new Set(lureRotations.flat());
  for (const lureId of uniqueIds) {
    try {
      const lureSpec = equipment.getLure(lureId);
      cache.set(lureId, lureSpec.category);
    } catch {
      // Lure not in catalog — skipped. Falls back to neutral affinity.
    }
  }
  return cache;
}

/**
 * Collect all POI IDs from the active world (via poiGraph draftClass queries).
 * Deduplicates across the three draft classes.
 *
 * @returns {string[]}
 */
function _collectPoiIds() {
  const ids = new Set();
  for (const draftClass of ['SHALLOW', 'MEDIUM', 'DEEP']) {
    try {
      const poiList = poiGraph.poisByDraft(draftClass);
      if (Array.isArray(poiList)) {
        for (const poi of poiList) {
          // poi may be a string ID or an object with an id field.
          ids.add(typeof poi === 'string' ? poi : poi.id);
        }
      }
    } catch {
      // poiGraph not yet populated or method signature differs; skip.
    }
  }
  return [...ids];
}

/**
 * Select the species and lure category for a single bot catch.
 *
 * Uses brainRng for lure selection (movement/lure decision per H-015).
 * Uses catchRng for species weighted-pick (catch outcome per H-015).
 *
 * Returns:
 *   speciesId       — the species that was caught
 *   M_lure_species  — lure affinity score [0.15 | 0.65 | 1.00] (D-059)
 *   lureId          — which lure was in use (NOT emitted on the bus per D-061)
 *
 * @param {object}    bot
 * @param {{next,int,pick,bool,weightedPick,lognormal}} catchRng
 * @param {{next,int,pick,bool,weightedPick,lognormal}} brainRng
 * @param {string}    winCondition
 * @returns {{ speciesId: string, M_lure_species: number, lureId: string }}
 */
function _selectSpeciesAndLure(bot, catchRng, brainRng, winCondition) {
  // Brain picks the lure (movement/lure rotation decision → brainRng per H-015).
  const lureId    = brainRng.pick(bot.lureRotation);
  const category  = _lureCategories.get(lureId) ?? null;

  // Weight each species by its affinity for the chosen lure category.
  const speciesIds = Object.keys(SPECIES_CATALOG);
  const weights    = speciesIds.map(sId => {
    const sp = SPECIES_CATALOG[sId];
    let w;
    if (!category) {
      w = 0.40;   // neutral fallback when lure isn't in catalog
    } else if (sp.presentationPreferences.preferred.includes(category)) {
      w = 1.00;
    } else if (sp.presentationPreferences.tolerated.includes(category)) {
      w = 0.65;
    } else {
      w = 0.15;   // rejected — fish will rarely bite
    }

    // D-063 BIGGEST_FISH: bias toward heavier species (trophy hunting).
    if (winCondition === 'BIGGEST_FISH') {
      // Boost weight for naturally heavier species using their log-mean weight.
      // exp(mu) is the median weight. Heavier median → higher boost.
      w *= (1 + Math.max(0, SPECIES_CATALOG[sId].weight.mu));
    }

    return w;
  });

  // Catch outcome uses catchRng (H-015).
  const speciesId = catchRng.weightedPick(speciesIds, weights);

  // Compute the M_lure↔species affinity score for the final P_catch formula.
  const sp = SPECIES_CATALOG[speciesId];
  let M_lure_species;
  if (!category) {
    M_lure_species = 0.40;
  } else if (sp.presentationPreferences.preferred.includes(category)) {
    M_lure_species = 1.00;
  } else if (sp.presentationPreferences.tolerated.includes(category)) {
    M_lure_species = 0.65;
  } else {
    M_lure_species = 0.15;
  }

  return { speciesId, M_lure_species, lureId };
}

/**
 * Compute the final P_catch probability for one bot on one cooldown tick (D-059, LOCKED).
 *
 * P_catch = base(tier) · S(skill) · G(gearTier) · W · M_lure↔species · M_lure↔poi · R
 * Final clamped [0.05, 0.95]. NO desperation mode.
 *
 * R(pressure) is approximated as a function of tournament progress (no real tile access):
 *   R = 1 − PRESSURE_STRIKE_PENALTY * pressureFrac * 0.4
 * where pressureFrac ramps 0→1 over the first 80% of the tournament.
 * Maximum pressure reduction ≈ 24% (leaves a large stubborn-fish floor).
 *
 * @param {object} bot
 * @param {number} tier           - event tier 1..5
 * @param {number} aiGearTier     - D-054 gear tier 1..5
 * @param {number} weatherQuality - 0.0 (harsh) … 1.0 (optimal)
 * @param {number} M_lure_species - lure↔species affinity [0.15..1.00]
 * @param {string} winCondition
 * @param {number} atMs           - current tournament clock time
 * @param {number} durationMs     - total tournament duration
 * @returns {number} P_catch ∈ [0.05, 0.95]
 */
function _computePCatch(bot, tier, aiGearTier, weatherQuality, M_lure_species, winCondition, atMs, durationMs) {
  const tierIdx = Math.min(4, Math.max(0, tier - 1));
  const base    = BASE_P_BY_TIER[tierIdx];

  // S(skill) with D-063 mismatch penalty applied.
  const { mismatchPenalty } = _computeObjectiveAlignment(bot, winCondition);
  const S = (0.5 + 0.5 * bot.skill) * mismatchPenalty;

  // G(gearTier) — bot's gear vs event standard (D-059).
  const G = _computeG(bot, aiGearTier);

  // W — weather modifier (D-059): W = 1 + weatherSensitivity * (lakeWeatherBias − 0.5)
  // lakeWeatherBias ≈ weatherQuality (favorable=1.0, neutral=0.5, harsh=0.0).
  const W = 1 + bot.weatherSensitivity * (weatherQuality - 0.5);

  // M_lure↔poi — dot-product of lure profile vs structureIndex tags × poiSelectionBias.
  // Simplified to: 0.4 + 0.6 * poiSelectionBias (scales from 0.4 for random POI to 1.0
  // for a bot perfectly targeting the best structure).
  const M_lure_poi = 0.4 + 0.6 * bot.poiSelectionBias;

  // R(pressure) — approximated from tournament progress (D-059).
  const pressureFrac = Math.min(1, atMs / Math.max(1, durationMs * 0.8));
  const R = 1 - PRESSURE_STRIKE_PENALTY * pressureFrac * 0.4;

  return Math.min(0.95, Math.max(0.05, base * S * G * W * M_lure_species * M_lure_poi * R));
}

/**
 * Compute the D-060 cooldown duration for a single bot.
 *
 * botCooldownMs = baseTickMs(tier) * (1.5 − 0.5 * skill) * weatherTickMod
 *
 * Minimum cooldown is clamped at 15 000ms (15 s) to prevent degenerate loops.
 *
 * @param {object} bot
 * @param {number} tier           - event tier 1..5
 * @param {number} weatherTickMod - from WEATHER_TICK_MOD map
 * @returns {number} cooldown in ms
 */
function _computeCooldownMs(bot, tier, weatherTickMod) {
  const tierIdx  = Math.min(4, Math.max(0, tier - 1));
  const baseTick = BASE_COOLDOWN_BY_TIER_MS[tierIdx];
  return Math.max(15_000, Math.round(baseTick * (1.5 - 0.5 * bot.skill) * weatherTickMod));
}

/**
 * Build and register a clock.every callback for one AI bot.
 *
 * Each callback independently executes the FULL pipeline:
 *   roll P_catch → sample weight → trophy gate → isPersonalBest →
 *   scoring.computeImpact → scoring.commit → bus.emit('AI_FISH_LANDED')
 *
 * All steps are SYNCHRONOUS in one call-stack frame, satisfying H-016 and H-018.
 * Because each bot owns its own clock.every handle and the clock fires them in
 * insertion order, same-tick catches are processed strictly sequentially (H-018).
 *
 * @param {object} bot
 * @param {object} ctx - { tier, aiGearTier, weatherQuality, weatherTickMod, winCondition, durationMs }
 * @returns {number} clock handle
 */
function _registerBotClock(bot, ctx) {
  const { tier, aiGearTier, weatherQuality, winCondition, durationMs } = ctx;

  // Each bot gets dedicated, INDEPENDENT sub-streams (H-015).
  const catchRng = rng.rngStream('aiCatch:'  + bot.id);  // P_catch rolls + weight sampling
  const brainRng = rng.rngStream('aiBrain:' + bot.id);  // lure rotation + POI selection

  const cooldownMs = _computeCooldownMs(bot, tier, ctx.weatherTickMod);

  const handle = clock.every(cooldownMs, (atMs) => {
    // ── 1. Select species and lure (brainRng for lure, catchRng for species) ──
    const { speciesId, M_lure_species, lureId } = _selectSpeciesAndLure(
      bot, catchRng, brainRng, winCondition
    );

    // ── 2. Compute P_catch (D-059) ──────────────────────────────────────────
    const P_catch = _computePCatch(
      bot, tier, aiGearTier, weatherQuality, M_lure_species,
      winCondition, atMs, durationMs
    );

    // ── 3. Roll — catchRng (H-015) ──────────────────────────────────────────
    if (catchRng.next() > P_catch) return;  // no catch this tick

    // ── 4. Sample weight (D-059) ─────────────────────────────────────────────
    const sp          = SPECIES_CATALOG[speciesId];
    const gearIdx     = Math.min(4, Math.max(0, aiGearTier - 1));
    const twMult      = TIER_WEIGHT_CURVE[gearIdx];
    const skillMult   = 1 + 0.4 * bot.skill;
    const prefMult    = 1 + 0.5 * bot.targetPreference.TROPHY
                          - 0.2 * bot.targetPreference.VOLUME;
    const rawWeight   = catchRng.lognormal(sp.weight.mu, sp.weight.sigma);
    const weightKg    = Math.max(0.01, rawWeight * skillMult * prefMult * twMult);

    // ── 5. Trophy gate (D-059) ───────────────────────────────────────────────
    const baseTrophyGate = Math.min(0.12, 0.10 + bot.targetPreference.TROPHY * 0.04);
    // D-063 BIGGEST_FISH: trophy gate boosted to the 12% cap.
    const trophyGate     = winCondition === 'BIGGEST_FISH' ? 0.12 : baseTrophyGate;
    const isTrophy       = catchRng.next() < trophyGate;

    // ── 6. Personal best (relative to this tournament run) ───────────────────
    const runtime        = _botRuntimes.get(bot.id);
    const isPersonalBest = weightKg > runtime.personalBest;
    if (isPersonalBest) runtime.personalBest = weightKg;
    runtime.catchCount++;

    // ── 7. Select POI via brainRng (movement decision per H-015) ─────────────
    const poiId = _availablePoiIds.length > 0
      ? brainRng.pick(_availablePoiIds)
      : 'UNKNOWN';

    // ── 8. Build the catch spec ───────────────────────────────────────────────
    const catchSpec = {
      anglerId:    bot.id,
      displayName: bot.displayName,
      speciesId,
      weightKg,
      atMs,
    };

    // ── 9. H-016 atomic block: computeImpact → commit → emit ─────────────────
    const leaderboardImpact = scoring.computeImpact(catchSpec);
    scoring.commit(catchSpec);

    // D-062: TTS priority ladder.
    let ttsPriority;
    if (leaderboardImpact.tookTheLead) {
      ttsPriority = 'URGENT';
    } else if (isTrophy) {
      ttsPriority = 'HIGH';
    } else if (leaderboardImpact.newRank <= _cutLineRank) {
      ttsPriority = 'NORMAL';
    } else {
      ttsPriority = 'LOW';
    }

    // Pick phrase token from the bot's pool (catchRng — outcome-related per H-015).
    const phraseToken = catchRng.pick(bot.audio.catchPhrasePool);

    // D-061 event schema. `lureId` intentionally omitted from the payload (D-061 LOCKED)
    // so players cannot reverse-engineer the bot's tackle setup by listening to the bus.
    bus.emit('AI_FISH_LANDED', {
      type:                 'AI_FISH_LANDED',
      atMs,
      botId:                bot.id,
      botDisplayName:       bot.displayName,
      personalityArchetype: bot.personalityArchetype,
      speciesId,
      speciesDisplayName:   SPECIES_DISPLAY_NAMES[speciesId] ?? speciesId,
      weightKg,
      isTrophy,
      isPersonalBest,
      poiId,
      leaderboardImpact,
      ttsPriority,
      phraseToken,
      rngSeed:              null,  // replay seed — reserved for Phase 9 determinism test
    });
  });

  return handle;
}

/**
 * Emit SIMULATED_TOURNAMENT_SKUNK for every active bot that ended with 0 catches (D-061).
 *
 * @param {number} atMs - current clock time (end-of-tournament)
 */
function _emitSkunkEvents(atMs) {
  for (const bot of _activeBotList) {
    const runtime = _botRuntimes.get(bot.id);
    if (runtime && runtime.catchCount === 0) {
      bus.emit('SIMULATED_TOURNAMENT_SKUNK', {
        botId:          bot.id,
        botDisplayName: bot.displayName,
        skunkPhrase:    bot.audio.skunkPhrase,
        atMs,
      });
    }
  }
}

// ===========================================================================
// Core lifecycle
// ===========================================================================

/**
 * Mount the AI competitor system for a tournament run.
 *
 * Steps:
 *   1. Parse the spec (tier, aiGearTier, winCondition, durationMs, weather).
 *   2. Build the lure-category cache from all active bots' rotations.
 *   3. Collect available POI IDs from the world.
 *   4. Select N−1 bots using weighted slot-fill (D-064).
 *   5. Initialise per-bot runtime state.
 *   6. Register one clock.every handle per bot (D-060).
 *
 * All clock handles are stored in _clockHandles for H-005 cleanup in unmount().
 *
 * @param {object} [tournamentSpec] - stateStore.getState().tournament.spec
 */
function mountForTournament(tournamentSpec) {
  _tournamentSpec = tournamentSpec ?? {};

  const tier           = _tournamentSpec.tier        ?? 1;
  const aiGearTier     = _tournamentSpec.aiGearTier  ?? tier;
  const winCondition   = _tournamentSpec.winCondition ?? 'HEAVIEST_BAG';
  const durationMs     = _tournamentSpec.durationMs  ?? 14_400_000;  // 4 hours default
  const weatherQuality = _tournamentSpec.weather?.quality ?? 'neutral';

  const weatherTickMod = WEATHER_TICK_MOD[weatherQuality]  ?? 1.00;
  const weatherPMod    = WEATHER_P_MOD[weatherQuality]     ?? 0.50;

  // ── Select bots for this tier ────────────────────────────────────────────
  const tierIdx = Math.min(4, Math.max(0, tier - 1));
  const botCount = Math.max(1, TOTAL_FIELD_BY_TIER[tierIdx] - 1);  // N−1 bots

  const setupRng    = rng.rngStream('ai:setup');
  _activeBotList    = _selectBots(tier, botCount, setupRng);

  // ── Lure category cache ───────────────────────────────────────────────────
  _lureCategories = _buildLureCategories(_activeBotList.map(b => b.lureRotation));

  // ── POI list ──────────────────────────────────────────────────────────────
  _availablePoiIds = _collectPoiIds();

  // ── Cut-line rank (D-062) ─────────────────────────────────────────────────
  const totalAnglers = _activeBotList.length + 1;  // bots + player
  _cutLineRank       = Math.ceil(totalAnglers * CUT_LINE_FRACTION);

  // ── Register per-bot clock handles ───────────────────────────────────────
  _botRuntimes  = new Map();
  _clockHandles = [];

  const ctx = { tier, aiGearTier, weatherQuality: weatherPMod, weatherTickMod, winCondition, durationMs };

  for (const bot of _activeBotList) {
    _botRuntimes.set(bot.id, { personalBest: 0, catchCount: 0 });
    const handle = _registerBotClock(bot, ctx);
    _clockHandles.push(handle);
  }
}

/**
 * Unmount the AI competitor system.
 *
 * Cancels all clock handles (H-005) and emits SIMULATED_TOURNAMENT_SKUNK for
 * any bots that finished the run without catching a single fish (D-061).
 *
 * Called automatically by the mount manifest onUnmount, and may be called
 * directly in tests.
 */
function unmount() {
  const atMs = (() => {
    try { return clock.nowMs(); } catch { return 0; }
  })();

  // Emit skunk events BEFORE cancelling handles so clock time is still valid.
  _emitSkunkEvents(atMs);

  // Cancel all bot cooldown timers (H-005).
  for (const handle of _clockHandles) {
    clock.cancel(handle);
  }
  _clockHandles = [];

  // Clear runtime state.
  _activeBotList   = [];
  _botRuntimes     = new Map();
  _lureCategories  = new Map();
  _availablePoiIds = [];
  _tournamentSpec  = null;
}

// ===========================================================================
// Mount Manifest — TOURNAMENT_ACTIVE (H-005)
// ===========================================================================

registerMountManifest({
  id:    'competitorAI',
  modes: [MODES.TOURNAMENT_ACTIVE],

  /**
   * Read the tournament spec from stateStore and mount all bot cooldowns.
   * The spec is expected to be frozen into state.tournament before TOURNAMENT_ACTIVE
   * is entered (D-069 Loadout Rigging anchors this to TOURNAMENT_BRIEFING).
   */
  onMount(/* nextMode, prevMode */) {
    const spec = stateStore.getState().tournament.spec;
    mountForTournament(spec);
  },

  /**
   * Emit skunk events and cancel all clock handles (H-005).
   * Fires regardless of which mode we're transitioning to (HUB, RESULTS, or quit).
   */
  onUnmount(/* prevMode, nextMode */) {
    unmount();
  },
});

// ===========================================================================
// Exports
// ===========================================================================

export { mountForTournament, unmount, BOT_CATALOG };
