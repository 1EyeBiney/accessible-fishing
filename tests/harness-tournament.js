/**
 * AFish Tournament Test Harness — tests/harness-tournament.js
 *
 * Isolated tests for Phase 7: src/tournament/scoring.js and
 * src/tournament/competitorAI.js.
 *
 * Sections:
 *   1  AI Competitor Simulation  — events fire; schema is correct (D-059 / D-061 / D-062)
 *   2  Bag Limit & Scoring Math  — 6-fish submission; bag capped at 5; light fish dropped
 *   3  Leaderboard Sorting       — three anglers; ranks assigned correctly (D-063)
 *
 * Run with:  node tests/harness-tournament.js
 *        or: npm run harness-tournament   (if configured in package.json)
 *
 * Design constraints:
 *   - Does NOT import or modify tests/harness.js.
 *   - Does NOT call transitionTo() — tournament lifecycle APIs (mountForTournament,
 *     unmount, reset) are called directly to keep the harness mode-agnostic.
 *   - Only the minimal subset of core singletons (bus, clock, rng, stateStore, poiGraph)
 *     is touched; no world, navigation, casting, or profile-store modules are loaded.
 *   - Each section resets all relevant singletons before running.
 *
 * Exit code:
 *   0 — all assertions passed
 *   1 — one or more assertions failed
 */

// ---------------------------------------------------------------------------
// Core singletons (minimal set required by tournament modules)
// ---------------------------------------------------------------------------

import * as bus        from '../src/core/eventBus.js';
import * as clock      from '../src/core/clock.js';
import * as rng        from '../src/core/rng.js';
import * as stateStore from '../src/core/stateStore.js';
import * as poiGraph   from '../src/world/poiGraph.js';

// ---------------------------------------------------------------------------
// Tournament modules under test.
// Importing these executes their top-level registerMountManifest() side-effects;
// the manifests remain dormant because we never call transitionTo() here.
// ---------------------------------------------------------------------------

import * as scoring      from '../src/tournament/scoring.js';
import * as competitorAI from '../src/tournament/competitorAI.js';

// ---------------------------------------------------------------------------
// Harness bookkeeping
// ---------------------------------------------------------------------------

let _passed  = 0;
let _failed  = 0;

function section(label) {
  console.log(`\n=== ${label} ===`);
}

/**
 * Assert that `value` is truthy.
 * @param {boolean} value
 * @param {string}  description
 * @param {*}       [actual] - extra context printed on failure
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
 * Assert strict equality (===).
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

/**
 * Assert that `actual` is within `epsilon` of `expected`.
 */
function assertApprox(actual, expected, epsilon, description) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= epsilon) {
    console.log(`[PASS] ${description}`);
    _passed++;
  } else {
    console.error(`[FAIL] ${description}  (expected: ~${expected} ±${epsilon}, got: ${actual})`);
    _failed++;
  }
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Known seed for fully deterministic RNG output across all sections. */
const KNOWN_SEED = 0xDEAD_BEEF;

/**
 * Three hours of in-game time in milliseconds.
 * Long enough to guarantee bot cooldown callbacks fire many times across all
 * active bots at tier 1, even accounting for stochastic P_catch rolls.
 */
const THREE_HOURS_MS = 3 * 60 * 60 * 1_000; // 10_800_000

// ---------------------------------------------------------------------------
// Isolation helper
// ---------------------------------------------------------------------------

/**
 * Full reset of every singleton touched by the tournament modules.
 * Called at the top of each section.
 */
function resetAll() {
  stateStore._reset();   // profile → null, tournament.spec → null, mode → 'BOOT'
  clock.reset();         // t=0, clears all pending schedules (manual mode)
  poiGraph._clear();     // empty graph — bots fall back to poiId='UNKNOWN'
}

// ===========================================================================
// SECTION 1: AI Competitor Simulation
// ===========================================================================
section('SECTION 1: AI COMPETITOR SIMULATION');
resetAll();

// ── 1a. Seed RNG for a fully deterministic run ─────────────────────────────
rng.seed(KNOWN_SEED);

// ── 1b. Inject a minimal profile so scoring.reset() can read displayName ───
stateStore.dispatch({
  type:    'PROFILE_LOADED',
  payload: { profile: { id: 'harness-p1', displayName: 'HarnessPlayer' } },
});
assertEqual(
  stateStore.getState().profile.displayName,
  'HarnessPlayer',
  '1a. stateStore.profile.displayName injected correctly',
);

// ── 1c. Register three POIs so the world isn't completely empty.
//        Note: competitorAI._collectPoiIds() uses poisByDraft('ROWBOAT' / 'BASS_BOAT' /
//        'TOURNAMENT_BOAT') which is the boat draft-class axis, not the POI depth-class
//        axis. With those keys the call succeeds and returns nodes whose
//        POI_DRAFT_DEPTH_M[draftClass] ≥ boatDraftM. ROWBOAT draft = 0.30 m, so any
//        POI with draftClass 'SHALLOW' (0.50 m water) or deeper is returned.
// ────────────────────────────────────────────────────────────────────────────
poiGraph.registerPoi({
  id: 'POI_DOCK',     label: 'Main Dock',   centerCoord: { x: 10, y: 10 },
  frameRadius: 3, draftClass: 'SHALLOW', description: 'Harness dock',
});
poiGraph.registerPoi({
  id: 'POI_COVE',     label: 'Rocky Cove',  centerCoord: { x: 20, y: 15 },
  frameRadius: 4, draftClass: 'MEDIUM',  description: 'Harness cove',
});
poiGraph.registerPoi({
  id: 'POI_DEEPHOLE', label: 'Deep Hole',   centerCoord: { x: 30, y: 25 },
  frameRadius: 5, draftClass: 'DEEP',    description: 'Harness deep hole',
});

// ── 1d. Initialize scoring so bot tick callbacks can call computeImpact / commit ──
scoring.reset({ winCondition: 'HEAVIEST_BAG' });

// ── 1e. Build the tournament spec for a tier-1, neutral-weather, 4-hour run ─
const tier1Spec = Object.freeze({
  id:           'HARNESS_T1',
  tier:          1,
  aiGearTier:    1,
  winCondition: 'HEAVIEST_BAG',
  durationMs:    14_400_000,  // 4 hours
  weather:       { quality: 'neutral' },
});

// ── 1f. Collect AI_FISH_LANDED events emitted during the run ─────────────────
const aiEvents = [];
const unsubAI  = bus.on('AI_FISH_LANDED', (evt) => aiEvents.push(evt));

// ── 1g. Mount the AI (direct API; no mode transition) ────────────────────────
competitorAI.mountForTournament(tier1Spec);

// ── 1h. Advance the clock three in-game hours in one tick.
//        clock.tick() fires all pending clock.every callbacks whose fireAtMs falls
//        within [0, THREE_HOURS_MS], including multiple repeats per bot interval.
// ─────────────────────────────────────────────────────────────────────────────
clock.tick(THREE_HOURS_MS);

// ── 1i. Unmount and clean up ──────────────────────────────────────────────────
unsubAI();
competitorAI.unmount();

// ── Assertions ────────────────────────────────────────────────────────────────

assert(
  aiEvents.length > 0,
  `1b. AI_FISH_LANDED events fired during the 3-hour run (got: ${aiEvents.length})`,
  aiEvents.length,
);

// Validate schema of the first event against the D-061 contract.
const firstEvt = aiEvents[0];

assert(
  firstEvt !== undefined,
  '1c. At least one AI_FISH_LANDED event has a payload',
);

if (firstEvt) {
  assertEqual(firstEvt.type, 'AI_FISH_LANDED', '1d. event.type === "AI_FISH_LANDED"');

  assert(
    typeof firstEvt.botId === 'string' && firstEvt.botId.length > 0,
    '1e. event.botId is a non-empty string',
    firstEvt.botId,
  );

  assert(
    typeof firstEvt.botDisplayName === 'string' && firstEvt.botDisplayName.length > 0,
    '1f. event.botDisplayName is a non-empty string',
    firstEvt.botDisplayName,
  );

  assert(
    typeof firstEvt.personalityArchetype === 'string',
    '1g. event.personalityArchetype is a string',
    firstEvt.personalityArchetype,
  );

  assert(
    typeof firstEvt.speciesId === 'string' && firstEvt.speciesId.length > 0,
    '1h. event.speciesId is a non-empty string',
    firstEvt.speciesId,
  );

  assert(
    typeof firstEvt.weightKg === 'number' && firstEvt.weightKg > 0,
    '1i. event.weightKg is a positive number',
    firstEvt.weightKg,
  );

  assert(
    typeof firstEvt.isTrophy === 'boolean',
    '1j. event.isTrophy is boolean',
    firstEvt.isTrophy,
  );

  assert(
    typeof firstEvt.isPersonalBest === 'boolean',
    '1k. event.isPersonalBest is boolean',
    firstEvt.isPersonalBest,
  );

  // D-061 LOCKED: lureId must NOT appear in the payload (bot tackle stays secret).
  assert(
    !Object.prototype.hasOwnProperty.call(firstEvt, 'lureId'),
    '1l. event does NOT expose lureId (D-061 — bot tackle is secret)',
  );

  // leaderboardImpact must exist and have the correct shape (H-016).
  assert(
    firstEvt.leaderboardImpact !== null && typeof firstEvt.leaderboardImpact === 'object',
    '1m. event.leaderboardImpact is an object',
    firstEvt.leaderboardImpact,
  );

  if (firstEvt.leaderboardImpact) {
    assert(
      typeof firstEvt.leaderboardImpact.newRank === 'number' &&
      firstEvt.leaderboardImpact.newRank >= 1,
      '1n. leaderboardImpact.newRank is a positive integer',
      firstEvt.leaderboardImpact.newRank,
    );

    assert(
      typeof firstEvt.leaderboardImpact.tookTheLead === 'boolean',
      '1o. leaderboardImpact.tookTheLead is boolean',
      firstEvt.leaderboardImpact.tookTheLead,
    );

    assert(
      typeof firstEvt.leaderboardImpact.newBagWeightKg === 'number',
      '1p. leaderboardImpact.newBagWeightKg is a number',
      firstEvt.leaderboardImpact.newBagWeightKg,
    );
  }

  // D-062: ttsPriority must be one of the four defined values.
  const validPriorities = new Set(['URGENT', 'HIGH', 'NORMAL', 'LOW']);
  assert(
    validPriorities.has(firstEvt.ttsPriority),
    `1q. event.ttsPriority is one of URGENT/HIGH/NORMAL/LOW (got: "${firstEvt.ttsPriority}")`,
    firstEvt.ttsPriority,
  );

  assert(
    typeof firstEvt.phraseToken === 'string' && firstEvt.phraseToken.length > 0,
    '1r. event.phraseToken is a non-empty string',
    firstEvt.phraseToken,
  );

  assert(
    typeof firstEvt.atMs === 'number' && firstEvt.atMs > 0,
    '1s. event.atMs is a positive number (clock time of catch)',
    firstEvt.atMs,
  );
}

// All bots should have the same botId namespace (no 'PLAYER' pollution).
const botIds = [...new Set(aiEvents.map(e => e.botId))];
assert(
  !botIds.includes('PLAYER'),
  `1t. No AI_FISH_LANDED event has botId='PLAYER' (${botIds.length} distinct bot IDs seen)`,
  botIds,
);

// Verify determinism: re-seed and re-run; event count and first event weight must match.
rng.seed(KNOWN_SEED);
scoring.reset({ winCondition: 'HEAVIEST_BAG' });

const aiEventsDeterminism = [];
const unsubDet = bus.on('AI_FISH_LANDED', (evt) => aiEventsDeterminism.push(evt));
clock.reset();
competitorAI.mountForTournament(tier1Spec);
clock.tick(THREE_HOURS_MS);
unsubDet();
competitorAI.unmount();

assertEqual(
  aiEventsDeterminism.length,
  aiEvents.length,
  '1u. Re-seeded run produces the same event count (determinism — H-015)',
);

if (aiEvents.length > 0 && aiEventsDeterminism.length > 0) {
  assertEqual(
    aiEventsDeterminism[0].botId,
    aiEvents[0].botId,
    '1v. Re-seeded run: first event botId matches (determinism — H-015)',
  );
  assertApprox(
    aiEventsDeterminism[0].weightKg,
    aiEvents[0].weightKg,
    0.0001,
    '1w. Re-seeded run: first event weightKg matches (determinism — H-015)',
  );
}

// H-016: computeImpact is the read-only preview; the leaderboard after the run must
// reflect the total commits from all events (each committed exactly once).
const lbAfterSection1 = scoring.getLeaderboard();
const totalBotCatches = aiEvents.length;

assert(
  lbAfterSection1.length > 0,
  '1x. Leaderboard has at least one entry after AI run',
  lbAfterSection1.length,
);

// Sum all committed catch counts across bot standings (player has 0 fish).
const botStandings = lbAfterSection1.filter(s => s.anglerId !== 'PLAYER');
const totalCommittedCatches = botStandings.reduce((sum, s) => sum + s.catchCount, 0);
assertEqual(
  totalCommittedCatches,
  totalBotCatches,
  `1y. Total catchCount in leaderboard (${totalCommittedCatches}) equals AI_FISH_LANDED event count (${totalBotCatches}) — no double-commits (H-016)`,
);

// ===========================================================================
// SECTION 2: Bag Limit & Scoring Math
// ===========================================================================
section('SECTION 2: BAG LIMIT & SCORING MATH');
resetAll();
rng.seed(KNOWN_SEED);

// Inject profile so scoring.reset() can read displayName.
stateStore.dispatch({
  type:    'PROFILE_LOADED',
  payload: { profile: { id: 'harness-p2', displayName: 'BagTestPlayer' } },
});

// Reset scoring for a fresh HEAVIEST_BAG tournament.
scoring.reset({ winCondition: 'HEAVIEST_BAG' });

// ── Commit 6 fish for the PLAYER in a deliberate order. ───────────────────
// Six weights — top 5 should be kept, the lightest (0.5) should be evicted.
const fishWeights = [
  { w: 1.0, label: 'Fish-A 1.0 kg' },
  { w: 3.0, label: 'Fish-B 3.0 kg' },
  { w: 0.5, label: 'Fish-C 0.5 kg' },   // lightest — must be evicted after 6th commit
  { w: 5.0, label: 'Fish-D 5.0 kg' },
  { w: 2.0, label: 'Fish-E 2.0 kg' },
  { w: 4.0, label: 'Fish-F 4.0 kg' },
];

// Expected top-5 bag: [5.0, 4.0, 3.0, 2.0, 1.0] → total = 15.0 kg
const EXPECTED_BAG_TOTAL = 15.0;
const EXPECTED_BAG_SIZE  = 5;

for (let i = 0; i < fishWeights.length; i++) {
  const { w } = fishWeights[i];
  scoring.commit({
    anglerId:    'PLAYER',
    displayName: 'BagTestPlayer',
    speciesId:   'LARGEMOUTH_BASS',
    weightKg:    w,
    atMs:        i * 1000,
  });
}

const playerStanding = scoring.getLeaderboard().find(s => s.anglerId === 'PLAYER');

assert(
  playerStanding !== undefined,
  '2a. PLAYER appears in the leaderboard after 6 commits',
);

if (playerStanding) {
  assertEqual(
    playerStanding.catchCount,
    6,
    '2b. PLAYER.catchCount === 6 (all fish recorded)',
  );

  assertEqual(
    playerStanding.bag.length,
    EXPECTED_BAG_SIZE,
    `2c. PLAYER bag is capped at ${EXPECTED_BAG_SIZE} fish (BAG_LIMIT enforced)`,
  );

  assertApprox(
    playerStanding.totalWeight,
    EXPECTED_BAG_TOTAL,
    0.0001,
    `2d. PLAYER.totalWeight === ${EXPECTED_BAG_TOTAL} kg (sum of top 5: 5+4+3+2+1)`,
  );

  // The 0.5 kg fish must NOT be in the scoring bag.
  const lightFishInBag = playerStanding.bag.some(f => Math.abs(f.weightKg - 0.5) < 0.0001);
  assert(
    !lightFishInBag,
    '2e. Lightest fish (0.5 kg) is NOT in the scoring bag (correctly evicted)',
  );

  // The 5.0 kg fish MUST be in the bag (heaviest fish is never evicted).
  const heaviestInBag = playerStanding.bag.some(f => Math.abs(f.weightKg - 5.0) < 0.0001);
  assert(
    heaviestInBag,
    '2f. Heaviest fish (5.0 kg) IS in the scoring bag',
  );

  // Bag must be sorted descending by weight.
  const bagWeights = playerStanding.bag.map(f => f.weightKg);
  const isSortedDesc = bagWeights.every((w, i) => i === 0 || bagWeights[i - 1] >= w);
  assert(
    isSortedDesc,
    `2g. Bag is sorted descending by weight [${bagWeights.join(', ')}]`,
    bagWeights,
  );
}

// ── Verify computeImpact is non-mutating (H-016 read-only contract) ─────────
// Commit a 7th fish (simulated impact) and confirm the live bag is still 5.
const seventh = { anglerId: 'PLAYER', displayName: 'BagTestPlayer', speciesId: 'BLUEGILL', weightKg: 6.0, atMs: 99_000 };
const impactPreview = scoring.computeImpact(seventh);

assert(
  impactPreview !== null && typeof impactPreview === 'object',
  '2h. computeImpact() returns a LeaderboardImpact object without mutating the leaderboard',
);

// Leaderboard must NOT have changed after the non-mutating computeImpact call.
const playerAfterImpact = scoring.getLeaderboard().find(s => s.anglerId === 'PLAYER');
assertEqual(
  playerAfterImpact?.catchCount,
  6,
  '2i. computeImpact() did NOT mutate live catchCount (H-016 non-mutating contract)',
);

assertApprox(
  playerAfterImpact?.totalWeight,
  EXPECTED_BAG_TOTAL,
  0.0001,
  '2j. computeImpact() did NOT mutate live totalWeight (H-016 non-mutating contract)',
);

// Now commit the 7th fish for real and verify bag promotes the 6.0 kg fish.
scoring.commit(seventh);
const playerAfterCommit = scoring.getLeaderboard().find(s => s.anglerId === 'PLAYER');
assertEqual(
  playerAfterCommit?.catchCount,
  7,
  '2k. After commit(), PLAYER.catchCount === 7',
);

// New expected bag: [6.0, 5.0, 4.0, 3.0, 2.0] → total = 20.0 kg
assertApprox(
  playerAfterCommit?.totalWeight,
  20.0,
  0.0001,
  '2l. After committing 6.0 kg fish, totalWeight = 20.0 kg (1.0 kg fish evicted)',
);

// ===========================================================================
// SECTION 3: Leaderboard Sorting & Rank Assignment
// ===========================================================================
section('SECTION 3: LEADERBOARD SORTING & RANK ASSIGNMENT');
resetAll();
rng.seed(KNOWN_SEED);

stateStore.dispatch({
  type:    'PROFILE_LOADED',
  payload: { profile: { id: 'harness-p3', displayName: 'TestPlayer' } },
});

scoring.reset({ winCondition: 'HEAVIEST_BAG' });

// ── Scenario: three anglers with clearly separated bag totals ─────────────
// Player:  bag of 5 fish → 5+4+3+2+1 = 15.0 kg
// ELITE:   3 fish        → 3+2.5+1.5 = 7.0 kg
// AMATEUR: 2 fish        → 0.5+0.3   = 0.8 kg

// Player catches (5 fish).
const playerCatches = [
  { w: 5.0, t: 1_000  },
  { w: 4.0, t: 2_000  },
  { w: 3.0, t: 3_000  },
  { w: 2.0, t: 4_000  },
  { w: 1.0, t: 5_000  },
];
for (const { w, t } of playerCatches) {
  scoring.commit({ anglerId: 'PLAYER', displayName: 'TestPlayer', speciesId: 'LARGEMOUTH_BASS', weightKg: w, atMs: t });
}

// ELITE bot catches (3 fish).
const eliteCatches = [
  { w: 3.0,  t: 10_000 },
  { w: 2.5,  t: 20_000 },
  { w: 1.5,  t: 30_000 },
];
for (const { w, t } of eliteCatches) {
  scoring.commit({ anglerId: 'ELITE_BOT', displayName: 'Elite Bot', speciesId: 'SMALLMOUTH_BASS', weightKg: w, atMs: t });
}

// AMATEUR bot catches (2 fish).
const amateurCatches = [
  { w: 0.5,  t: 40_000 },
  { w: 0.3,  t: 50_000 },
];
for (const { w, t } of amateurCatches) {
  scoring.commit({ anglerId: 'AMATEUR_BOT', displayName: 'Amateur Bot', speciesId: 'BLUEGILL', weightKg: w, atMs: t });
}

// ── Call getLeaderboard() and run assertions ─────────────────────────────────
const leaderboard = scoring.getLeaderboard();

assertEqual(
  leaderboard.length,
  3,
  '3a. getLeaderboard() returns 3 entries (PLAYER + 2 bots)',
);

// Sorted descending by totalWeight for HEAVIEST_BAG.
const lb0 = leaderboard[0];
const lb1 = leaderboard[1];
const lb2 = leaderboard[2];

// ── Rank 1: Player ───────────────────────────────────────────────────────────
assertEqual(lb0.rank, 1, '3b. leaderboard[0].rank === 1 (first place)');
assertEqual(lb0.anglerId, 'PLAYER', '3c. leaderboard[0].anglerId === "PLAYER"');
assertApprox(lb0.totalWeight, 15.0, 0.0001, '3d. leaderboard[0].totalWeight === 15.0 kg');

// ── Rank 2: Elite ────────────────────────────────────────────────────────────
assertEqual(lb1.rank, 2, '3e. leaderboard[1].rank === 2 (second place)');
assertEqual(lb1.anglerId, 'ELITE_BOT', '3f. leaderboard[1].anglerId === "ELITE_BOT"');
assertApprox(lb1.totalWeight, 7.0, 0.0001, '3g. leaderboard[1].totalWeight === 7.0 kg');

// ── Rank 3: Amateur ──────────────────────────────────────────────────────────
assertEqual(lb2.rank, 3, '3h. leaderboard[2].rank === 3 (third place / last)');
assertEqual(lb2.anglerId, 'AMATEUR_BOT', '3i. leaderboard[2].anglerId === "AMATEUR_BOT"');
assertApprox(lb2.totalWeight, 0.8, 0.0001, '3j. leaderboard[2].totalWeight === 0.8 kg');

// ── Strict descending weight order ───────────────────────────────────────────
assert(
  lb0.totalWeight > lb1.totalWeight,
  `3k. Rank 1 (${lb0.totalWeight} kg) > Rank 2 (${lb1.totalWeight} kg)`,
);
assert(
  lb1.totalWeight > lb2.totalWeight,
  `3l. Rank 2 (${lb1.totalWeight} kg) > Rank 3 (${lb2.totalWeight} kg)`,
);

// ── catchCount sanity ─────────────────────────────────────────────────────────
assertEqual(lb0.catchCount, 5,  '3m. PLAYER.catchCount === 5');
assertEqual(lb1.catchCount, 3,  '3n. ELITE_BOT.catchCount === 3');
assertEqual(lb2.catchCount, 2,  '3o. AMATEUR_BOT.catchCount === 2');

// ── computeImpact predicts rank movements before they happen ─────────────────
// If the Amateur lands a 10 kg fish, the impact preview must show rank 1.
const bigAmateur = {
  anglerId:    'AMATEUR_BOT',
  displayName: 'Amateur Bot',
  speciesId:   'CATFISH',
  weightKg:    20.0,   // 20+0.5+0.3 = 20.8 kg bag — exceeds Player's 15.0 kg
  atMs:        60_000,
};
const bigImpact = scoring.computeImpact(bigAmateur);

assertEqual(
  bigImpact.newRank,
  1,
  '3p. computeImpact() predicts AMATEUR_BOT would move to rank 1 after landing a 20 kg Catfish',
);

assert(
  bigImpact.tookTheLead === true,
  '3q. computeImpact() predicts tookTheLead === true for the 20 kg catch',
  bigImpact.tookTheLead,
);

assertEqual(
  bigImpact.knockedOff,
  'TestPlayer',
  '3r. computeImpact() correctly identifies "TestPlayer" as the angler knocked off the lead',
);

assertEqual(
  bigImpact.previousRank,
  3,
  '3s. computeImpact() shows AMATEUR_BOT previousRank === 3 (no prior mutation)',
);

// Verify the live board is STILL unchanged after computeImpact (non-mutating).
const lbAfterImpact = scoring.getLeaderboard();
assertEqual(
  lbAfterImpact[0].anglerId,
  'PLAYER',
  '3t. Live leaderboard still shows PLAYER at rank 1 after computeImpact (non-mutating)',
);

// Now commit the big fish and verify the board flips correctly.
scoring.commit(bigAmateur);
const lbAfterCommit = scoring.getLeaderboard();

assertEqual(
  lbAfterCommit[0].anglerId,
  'AMATEUR_BOT',
  '3u. After committing 20 kg Catfish, AMATEUR_BOT is rank 1 on the live board',
);

assertEqual(
  lbAfterCommit[1].anglerId,
  'PLAYER',
  '3v. After AMATEUR_BOT takes the lead, PLAYER drops to rank 2',
);

// ── BIGGEST_FISH win condition — reset and re-verify ─────────────────────────
scoring.reset({ winCondition: 'BIGGEST_FISH' });

scoring.commit({ anglerId: 'PLAYER',      displayName: 'TestPlayer', speciesId: 'LARGEMOUTH_BASS', weightKg: 5.0, atMs: 1_000 });
scoring.commit({ anglerId: 'PLAYER',      displayName: 'TestPlayer', speciesId: 'LARGEMOUTH_BASS', weightKg: 2.0, atMs: 2_000 });
scoring.commit({ anglerId: 'ELITE_BOT',   displayName: 'Elite Bot',  speciesId: 'SMALLMOUTH_BASS', weightKg: 4.0, atMs: 3_000 });
scoring.commit({ anglerId: 'AMATEUR_BOT', displayName: 'Amateur Bot',speciesId: 'BLUEGILL',        weightKg: 0.5, atMs: 4_000 });

const lbBiggest = scoring.getLeaderboard();

assertEqual(lbBiggest[0].anglerId, 'PLAYER',      '3w. BIGGEST_FISH: PLAYER (5.0 kg personal best) is rank 1');
assertEqual(lbBiggest[1].anglerId, 'ELITE_BOT',   '3x. BIGGEST_FISH: ELITE_BOT (4.0 kg) is rank 2');
assertEqual(lbBiggest[2].anglerId, 'AMATEUR_BOT', '3y. BIGGEST_FISH: AMATEUR_BOT (0.5 kg) is rank 3');

assertApprox(lbBiggest[0].totalWeight, 5.0, 0.0001, '3z. BIGGEST_FISH: PLAYER.totalWeight is the 5.0 kg single-best');

// For BIGGEST_FISH, the bag should contain exactly 1 fish (the personal best).
assertEqual(lbBiggest[0].bag.length, 1, '3aa. BIGGEST_FISH: PLAYER.bag.length === 1 (single-best bag)');

// ── TOTAL_CATCH_COUNT win condition — reset and re-verify ─────────────────────
scoring.reset({ winCondition: 'TOTAL_CATCH_COUNT' });

// AMATEUR lands 4 tiny fish; PLAYER lands 2 bigger fish.
// Count is the primary sort key — AMATEUR should rank higher despite lower weight.
scoring.commit({ anglerId: 'PLAYER',      displayName: 'TestPlayer', speciesId: 'LARGEMOUTH_BASS', weightKg: 3.0, atMs: 1_000 });
scoring.commit({ anglerId: 'PLAYER',      displayName: 'TestPlayer', speciesId: 'LARGEMOUTH_BASS', weightKg: 2.5, atMs: 2_000 });
scoring.commit({ anglerId: 'AMATEUR_BOT', displayName: 'Amateur Bot',speciesId: 'BLUEGILL',        weightKg: 0.3, atMs: 3_000 });
scoring.commit({ anglerId: 'AMATEUR_BOT', displayName: 'Amateur Bot',speciesId: 'BLUEGILL',        weightKg: 0.3, atMs: 4_000 });
scoring.commit({ anglerId: 'AMATEUR_BOT', displayName: 'Amateur Bot',speciesId: 'BLUEGILL',        weightKg: 0.3, atMs: 5_000 });
scoring.commit({ anglerId: 'AMATEUR_BOT', displayName: 'Amateur Bot',speciesId: 'BLUEGILL',        weightKg: 0.3, atMs: 6_000 });

const lbCount = scoring.getLeaderboard();

assertEqual(
  lbCount[0].anglerId,
  'AMATEUR_BOT',
  '3bb. TOTAL_CATCH_COUNT: AMATEUR_BOT (4 fish) outranks PLAYER (2 fish) by count',
);

assertEqual(
  lbCount[0].catchCount,
  4,
  '3cc. TOTAL_CATCH_COUNT: leader has catchCount === 4',
);

assertEqual(
  lbCount[1].anglerId,
  'PLAYER',
  '3dd. TOTAL_CATCH_COUNT: PLAYER (2 fish, higher weight) is rank 2',
);

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${'='.repeat(52)}`);
console.log(`  Phase 7 Tournament Harness — Results`);
console.log(`${'='.repeat(52)}`);
console.log(`  Passed: ${_passed}`);
console.log(`  Failed: ${_failed}`);
console.log(`${'='.repeat(52)}`);

if (_failed > 0) {
  process.exit(1);
}
