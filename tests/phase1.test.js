/**
 * tests/phase1.test.js — Phase 1 Test Harness (v1.79)
 *
 * Headless Node.js test script.  No external test framework required.
 * Run: node tests/phase1.test.js
 *
 * Sections:
 *   1. DETERMINISM              — same seed + inputs → identical FIGHT_RESOLVED outcome
 *   2. CAST ABORTION            — INPUT_R (Soft Retrieve) → clock +5000ms, spook unchanged
 *                                  INPUT_Q (Power Rip)    → clock +2000ms, spook +1 NORMAL
 *   3. TROPHY YANK & CROOKED STICK — SPACEBAR on standard rod → durability −0.10,
 *                                     clock +1000ms, trophyMultiplier +0.15
 *                                     SPACEBAR on crooked_stick → complete no-op (D-083)
 *   4. DECEPTIVE THUD           — STATE_ANNOUNCE emits STRIKE_LIGHT / STRIKE_MODERATE /
 *                                  STRIKE_HEAVY per InitialPull formula; TIME_TO_FIGHT absent
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as bus           from '../src/core/eventBus.js';
import * as clock         from '../src/core/clock.js';
import * as rng           from '../src/core/rng.js';
import * as stateStore    from '../src/core/stateStore.js';
import * as inputAdapter  from '../src/core/inputAdapter.js';
import { MODES, transitionTo, currentMode } from '../src/core/modeRouter.js';
import * as worldMap      from '../src/world/worldMap.js';
import * as poiGraph      from '../src/world/poiGraph.js';
import * as wind          from '../src/navigation/wind.js';
import * as motor         from '../src/navigation/motor.js';
import * as equipment     from '../src/equipment/equipment.js';
import * as castSpookModel from '../src/casting/castSpookModel.js';

// Side-effect imports — register TOURNAMENT_ACTIVE mount manifests
import '../src/fish/fightLoop.js';
import '../src/casting/castPipeline.js';

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

let _passed = 0;
let _failed = 0;

function section(title) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(62));
}

function assert(cond, msg) {
  if (cond) {
    console.log(`  [PASS] ${msg}`);
    _passed++;
  } else {
    console.error(`  [FAIL] ${msg}`);
    _failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    console.log(`  [PASS] ${msg}  (${actual})`);
    _passed++;
  } else {
    console.error(`  [FAIL] ${msg}  (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
    _failed++;
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  [PASS] ${msg}  (≈${actual})`);
    _passed++;
  } else {
    console.error(`  [FAIL] ${msg}  (expected ≈${expected} ±${tolerance}, got ${actual})`);
    _failed++;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_SEED = 0xABCD1234;   // matches harness.js (0xFEED_F15H is not valid hex)

// ---------------------------------------------------------------------------
// Shared reset helper
// ---------------------------------------------------------------------------

/**
 * Full state teardown between sections.
 * Mirrors the resetAll() used in harness.js / harness-fish.js.
 */
function resetAll() {
  // Unmount subsystems cleanly so their onUnmount() handlers cancel all
  // bus subscriptions and clock handles before we wipe the state.
  if (stateStore.getState().mode === MODES.TOURNAMENT_ACTIVE) {
    transitionTo(MODES.HUB);
  }
  stateStore._reset();
  clock.reset();
  inputAdapter._reset();
  worldMap._clear();
  poiGraph._clear();
  wind.invalidateModel();
  try { motor._resetWarnings(); } catch { /* motor may not be initialised */ }
}

// ---------------------------------------------------------------------------
// World builder — minimal single-tile lake for fight / cast tests
// ---------------------------------------------------------------------------

const TEST_POI_ID = 'POI_TEST_LAKE';
const TEST_TILE_COORD = { x: 0, y: 0 };

/**
 * Register the minimum viable world: one deep-water tile at origin + one POI.
 * Used by all test sections that need castPipeline to resolve a POI centre.
 */
function buildTestWorld() {
  worldMap.registerTile({
    id:    'T_TEST_ORIGIN',
    coord: TEST_TILE_COORD,
    traits: {
      depth:  { bottomM: 4.0, minM: 2.5, maxM: 5.0, slopeDeg: 3 },
      bottom: { primary: 'SAND', secondary: null, hardness: 0.3 },
      cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
      tags:   ['OPEN_FLAT'],
      reach:  { fromDockMin: 0, draftClass: 'DEEP' },
    },
  });

  // stateStore._initialState() sets session.player.currentPoiId = 'DOCK'.
  // castPipeline._getPoiCenter() uses currentPoiId first, so 'DOCK' must be
  // a registered POI or the spook-coord calculation silently returns null.
  poiGraph.registerPoi({
    id:          'DOCK',
    label:       'Dock',
    centerCoord: TEST_TILE_COORD,
    frameRadius: 30,
    draftClass:  'DEEP',
  });

  poiGraph.registerPoi({
    id:          TEST_POI_ID,
    label:       'Test Lake',
    centerCoord: TEST_TILE_COORD,
    frameRadius: 30,
    draftClass:  'DEEP',
  });
}

// ---------------------------------------------------------------------------
// Active tackle + state helpers
// ---------------------------------------------------------------------------

/**
 * Set hub.activeTackle and copy it to tournament.activeTackle in one step.
 * Dispatching TOURNAMENT_ENTERED after ACTIVE_TACKLE_SET causes the stateStore
 * TOURNAMENT_ENTERED reducer to deep-copy hub.activeTackle into
 * state.tournament.activeTackle (H-017).  equipment.getActiveTackle() then
 * returns the correct rod list once the mode is TOURNAMENT_ACTIVE.
 *
 * @param {string}  rodId       — rod id from ROD_CATALOG
 * @param {number}  durability  — initial rod durability to store
 */
function setActiveTackleWithRod(rodId, durability) {
  stateStore.dispatch({
    type:    'ACTIVE_TACKLE_SET',
    payload: { activeTackle: { rods: [{ id: rodId, durability }], lures: [], bait: [] } },
  });
  // Copy hub.activeTackle → tournament.activeTackle via the TOURNAMENT_ENTERED reducer.
  stateStore.dispatch({
    type:    'TOURNAMENT_ENTERED',
    payload: { id: 'phase1_test', spec: null },
  });
}

// ---------------------------------------------------------------------------
// Fish instance factory — constructs manually without evaluateStrike
// ---------------------------------------------------------------------------

let _fishSeq = 0;

/**
 * Build a minimal fishInstance object suitable for injecting into BITE_THUD.
 *
 * @param {object} overrides — any fields to override
 * @returns {object}
 */
function makeFishInstance(overrides = {}) {
  return {
    id:             `fish_${++_fishSeq}`,
    speciesId:      'LARGEMOUTH_BASS',
    weightKg:       0.5,
    stamina:        0.4,
    phase:          'RUNNING',
    fightStyle:     'RUNNER',
    lureId:         'LURE_SHALLOW_CRANK',
    coord:          { x: 0, y: 0 },
    trophyMultiplier: undefined, // _startFight will initialise to 1.0
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fight driver helpers
// ---------------------------------------------------------------------------

/**
 * Trigger BITE_THUD then immediately tap ARROW_UP to start the fight.
 * Returns a Promise-free synchronous fight start — the hookset happens within
 * the same synchronous event-loop turn because the hookset window is open and
 * bus.emit is synchronous.
 *
 * @param {object}  fishInstance
 * @param {number}  [hooksetWindowMs=800]
 * @returns {{ fishHookedEvents: object[], stateAnnounceEvents: object[] }}
 */
function startFight(fishInstance, hooksetWindowMs = 800) {
  const fishHookedEvents    = [];
  const stateAnnounceEvents = [];

  const unsubFH = bus.on('FISH_HOOKED',    e => fishHookedEvents.push(e));
  const unsubSA = bus.on('STATE_ANNOUNCE', e => stateAnnounceEvents.push(e));

  const atMs = clock.nowMs();

  // Open the hookset window.
  bus.emit('BITE_THUD', {
    fishInstance,
    hooksetWindowMs,
    castSpec: {},
    atMs,
  });

  // Immediately tap ARROW_UP to hookset within the window.
  bus.emit('INPUT_ARROW_UP', { atMs });

  unsubFH();
  unsubSA();

  return { fishHookedEvents, stateAnnounceEvents };
}

/**
 * Drive an active fight to resolution by holding ARROW_DOWN for the given
 * clock duration.  Returns the FIGHT_RESOLVED event (or null if none fired).
 *
 * @param {number} tickMs  — total clock advance to apply
 * @returns {object|null}
 */
function reelToResolution(tickMs) {
  let resolvedEvent = null;

  const unsubFR = bus.on('FIGHT_RESOLVED', e => { resolvedEvent = e; });

  inputAdapter.keyDown('ARROW_DOWN');
  clock.tick(tickMs);
  inputAdapter.keyUp('ARROW_DOWN');

  unsubFR();
  return resolvedEvent;
}

// ===========================================================================
// SECTION 1 — DETERMINISM
// ===========================================================================
section('1. DETERMINISM');
resetAll();

/**
 * Runs one complete fight sequence (same seed, same fish, same inputs) and
 * returns the FIGHT_RESOLVED payload.
 *
 * @returns {{ outcome: string, fishInstance: object }}
 */
function runFightRun() {
  rng.seed(KNOWN_SEED);
  buildTestWorld();
  // No rod needed for this section — we are not testing Trophy Yank here.
  stateStore.dispatch({
    type:    'ACTIVE_TACKLE_SET',
    payload: { activeTackle: { rods: [], lures: [], bait: [] } },
  });
  stateStore.dispatch({ type: 'TOURNAMENT_ENTERED', payload: { id: 'det_test', spec: null } });

  transitionTo(MODES.TOURNAMENT_ACTIVE);

  // Use a fully deterministic fish: known weight, stamina, style, coord.
  const fish = makeFishInstance({
    weightKg:   0.5,
    stamina:    0.35,
    phase:      'RUNNING',
    fightStyle: 'RUNNER',
  });

  const { fishHookedEvents } = startFight(fish);

  // Collect FIGHT_RESOLVED
  const resolved = reelToResolution(5_000);

  // Unmount cleanly for the next run.
  transitionTo(MODES.HUB);
  stateStore._reset();
  clock.reset();
  inputAdapter._reset();
  worldMap._clear();
  poiGraph._clear();
  wind.invalidateModel();

  return { resolved, fishHookedFired: fishHookedEvents.length > 0 };
}

// Run A
const runA = runFightRun();

// Run B — identical seed and inputs
const runB = runFightRun();

// ── 1a. Both runs started the fight ─────────────────────────────────────────
assert(runA.fishHookedFired, '1a. Run A: FISH_HOOKED fired after BITE_THUD + ARROW_UP hookset');
assert(runB.fishHookedFired, '1a. Run B: FISH_HOOKED fired after BITE_THUD + ARROW_UP hookset');

// ── 1b. Both runs produced a FIGHT_RESOLVED event ───────────────────────────
assert(runA.resolved !== null, '1b. Run A: FIGHT_RESOLVED event received');
assert(runB.resolved !== null, '1b. Run B: FIGHT_RESOLVED event received');

// ── 1c. Both runs resolved with the same outcome token ──────────────────────
assertEqual(
  runA.resolved?.outcome ?? 'NONE',
  runB.resolved?.outcome ?? 'NONE',
  '1c. Both runs produce the same FIGHT_RESOLVED outcome (determinism)'
);
console.log(`      outcome: ${runA.resolved?.outcome}`);

// ── 1d. Both fish instances end with the same stamina ───────────────────────
if (runA.resolved?.fishInstance && runB.resolved?.fishInstance) {
  assertApprox(
    runB.resolved.fishInstance.stamina,
    runA.resolved.fishInstance.stamina,
    1e-9,
    '1d. fishInstance.stamina identical across runs'
  );
}

// ── 1e. Both fish instances end with the same trophyMultiplier ──────────────
if (runA.resolved?.fishInstance && runB.resolved?.fishInstance) {
  assertEqual(
    runB.resolved.fishInstance.trophyMultiplier,
    runA.resolved.fishInstance.trophyMultiplier,
    '1e. fishInstance.trophyMultiplier identical across runs'
  );
}

// ===========================================================================
// SECTION 2 — CAST ABORTION
// ===========================================================================
section('2. CAST ABORTION');
resetAll();
rng.seed(KNOWN_SEED);
buildTestWorld();

// Tackle with a rod so castPipeline can build lure options (a dev_mock_lure
// is injected automatically by _buildLureOptions when lures is empty).
stateStore.dispatch({
  type:    'ACTIVE_TACKLE_SET',
  payload: { activeTackle: { rods: [{ id: 'ROD_MEDIUM_SPINNING', durability: 1.0 }], lures: [], bait: [] } },
});
stateStore.dispatch({ type: 'TOURNAMENT_ENTERED', payload: { id: 'abort_test', spec: null } });
transitionTo(MODES.TOURNAMENT_ACTIVE);

/**
 * Navigate castPipeline FSM from IDLE → LURE_SELECT → ARMED.
 *
 * Emits TARGET_LOCKED (→ LURE_SELECT), then INPUT_SPACEBAR (→ ARMED).
 */
function armCastPipeline() {
  const atMs = clock.nowMs();
  // Emit TARGET_LOCKED — castPipeline enters LURE_SELECT.
  // offset {dx:0, dy:0} → target is at POI centre (0, 0).
  bus.emit('TARGET_LOCKED', {
    poiId:       TEST_POI_ID,
    offset:      { dx: 0, dy: 0 },
    candidateId: 'candidate_1',
    finderTier:  'STANDARD',
    lockedAtMs:  atMs,
  });
  // Confirm lure selection — castPipeline enters ARMED.
  bus.emit('INPUT_SPACEBAR', { atMs });
}

// ── 2a. Soft Retrieve: clock advances 5000ms, CAST_ABORTED mode='SOFT' ───────
{
  const castAbortedEvents = [];
  const unsubCA = bus.on('CAST_ABORTED', e => castAbortedEvents.push(e));

  armCastPipeline();

  const t0 = clock.nowMs();
  bus.emit('INPUT_R', { atMs: t0 });

  unsubCA();

  const elapsed = clock.nowMs() - t0;

  assertEqual(castAbortedEvents.length, 1,
    '2a. CAST_ABORTED fires exactly once on Soft Retrieve');
  assertEqual(castAbortedEvents[0]?.mode ?? 'MISSING', 'SOFT',
    '2a. CAST_ABORTED carries mode = "SOFT"');
  assertEqual(castAbortedEvents[0]?.clockPenaltyMs ?? -1, 5_000,
    '2a. CAST_ABORTED carries clockPenaltyMs = 5000');
  assertEqual(elapsed, 5_000,
    '2a. clock.tick(5000) applied after Soft Retrieve (clock advanced 5000ms)');
}

// ── 2b. Soft Retrieve: spook on target tile is unchanged ─────────────────────
{
  // Re-arm to test spook on a fresh attempt.
  armCastPipeline();

  const spookBefore = castSpookModel.readSpook(TEST_TILE_COORD, clock.nowMs());
  bus.emit('INPUT_R', { atMs: clock.nowMs() });
  const spookAfter  = castSpookModel.readSpook(TEST_TILE_COORD, clock.nowMs());

  assertEqual(spookAfter, spookBefore,
    '2b. Soft Retrieve does NOT increment tile spook (lure exits cleanly)');
}

// ── 2c. Power Rip: clock advances 2000ms, CAST_ABORTED mode='RIP' ──────────
{
  const castAbortedEvents = [];
  const unsubCA = bus.on('CAST_ABORTED', e => castAbortedEvents.push(e));

  armCastPipeline();

  const t0 = clock.nowMs();
  bus.emit('INPUT_Q', { atMs: t0 });

  unsubCA();

  const elapsed = clock.nowMs() - t0;

  assertEqual(castAbortedEvents.length, 1,
    '2c. CAST_ABORTED fires exactly once on Power Rip');
  assertEqual(castAbortedEvents[0]?.mode ?? 'MISSING', 'RIP',
    '2c. CAST_ABORTED carries mode = "RIP"');
  assertEqual(castAbortedEvents[0]?.clockPenaltyMs ?? -1, 2_000,
    '2c. CAST_ABORTED carries clockPenaltyMs = 2000');
  assertEqual(elapsed, 2_000,
    '2c. clock.tick(2000) applied after Power Rip (clock advanced 2000ms)');
}

// ── 2d. Power Rip: spook increments by +1 (NORMAL splash) ───────────────────
{
  // Re-arm for one final attempt.
  armCastPipeline();

  // Read spook BEFORE the rip.
  const spookBefore = castSpookModel.readSpook(TEST_TILE_COORD, clock.nowMs());

  const spookAppliedEvents = [];
  const unsubSP = bus.on('SPOOK_APPLIED', e => spookAppliedEvents.push(e));

  bus.emit('INPUT_Q', { atMs: clock.nowMs() });

  unsubSP();

  // Read spook AFTER the rip (at the same clock time to avoid decay calculation).
  const spookAfter = castSpookModel.readSpook(TEST_TILE_COORD, clock.nowMs());

  assert(spookAfter === spookBefore + 1,
    `2d. Power Rip increments spook by +1 NORMAL ` +
    `(before: ${spookBefore}, after: ${spookAfter})`);
}

// ===========================================================================
// SECTION 3 — TROPHY YANK & CROOKED STICK
// ===========================================================================
section('3. TROPHY YANK & CROOKED STICK');

// ---------------------------------------------------------------------------
// Sub-test 3A — Standard rod: durability −0.10, clock +1000ms, multi +0.15
// ---------------------------------------------------------------------------
// Guaranteed-survival trick: set rod durability to 2.0 in state.
// rodCatalog.durability = 1.0 (ROD_MEDIUM_SPINNING).
// currentDurabilityFraction = 2.0 / 1.0 = 2.0
// P_snap = 0.10 + (1.0 − 2.0) = −0.90  → always < any roll ∈ [0,1) → NO snap.

resetAll();
rng.seed(KNOWN_SEED);
buildTestWorld();
setActiveTackleWithRod('ROD_MEDIUM_SPINNING', 2.0);   // durability intentionally > 1.0
transitionTo(MODES.TOURNAMENT_ACTIVE);

{
  const rodBrokenEvents = [];
  const unsubRB = bus.on('ROD_BROKEN', e => rodBrokenEvents.push(e));

  const fish = makeFishInstance({
    weightKg:   1.0,
    stamina:    0.5,
    phase:      'RUNNING',
    fightStyle: 'RUNNER',
  });

  const { fishHookedEvents } = startFight(fish);
  assert(fishHookedEvents.length === 1, '3A-pre. FISH_HOOKED fires (fight started)');

  // Read baseline state.
  const state0      = stateStore.getState();
  const rod0        = state0.tournament.activeTackle?.rods?.[0];
  const durBefore   = rod0?.durability ?? NaN;
  const multBefore  = fish.trophyMultiplier; // set to 1.0 by _startFight
  const clockBefore = clock.nowMs();

  // Trigger Trophy Yank.
  bus.emit('INPUT_SPACEBAR', { atMs: clockBefore });

  unsubRB();

  // Read post-yank state.
  const state1    = stateStore.getState();
  const rod1      = state1.tournament.activeTackle?.rods?.[0];
  const durAfter  = rod1?.durability ?? NaN;
  const multAfter = fish.trophyMultiplier;
  const clockAfter = clock.nowMs();

  // ── 3A-a. No rod snap fires ───────────────────────────────────────────────
  assertEqual(rodBrokenEvents.length, 0,
    '3A-a. ROD_BROKEN does NOT fire when durabilityFraction > 1.0 (P_snap < 0)');

  // ── 3A-b. Rod durability decreased by exactly 0.10 ───────────────────────
  assertApprox(durAfter, durBefore - 0.10, 1e-9,
    `3A-b. Rod durability decreased by 0.10 (${durBefore} → ${durAfter})`);

  // ── 3A-c. Clock advanced by exactly 1000ms ───────────────────────────────
  assertEqual(clockAfter - clockBefore, 1_000,
    '3A-c. clock.tick(1000) applied — tournament clock advances 1000ms per yank');

  // ── 3A-d. trophyMultiplier increased by 0.15 ─────────────────────────────
  assertApprox(multAfter, multBefore + 0.15, 1e-9,
    `3A-d. trophyMultiplier += 0.15 (${multBefore} → ${multAfter})`);

  // Tear down fight so crooked_stick sub-test starts clean.
  transitionTo(MODES.HUB);
}

// ---------------------------------------------------------------------------
// Sub-test 3B — Crooked Stick: complete no-op (D-083)
// ---------------------------------------------------------------------------

resetAll();
rng.seed(KNOWN_SEED);
buildTestWorld();
// Use 'crooked_stick' as the active rod. _onPump guards on f.activeRodId === 'crooked_stick'
// and returns immediately — no snap roll, no wear, no reward, no clock advance.
setActiveTackleWithRod('crooked_stick', 1.0);
transitionTo(MODES.TOURNAMENT_ACTIVE);

{
  const rodBrokenEvents = [];
  const unsubRB = bus.on('ROD_BROKEN', e => rodBrokenEvents.push(e));

  const fish = makeFishInstance({
    weightKg:   0.8,
    stamina:    0.5,
    phase:      'RUNNING',
    fightStyle: 'RUNNER',
  });

  const { fishHookedEvents } = startFight(fish);
  assert(fishHookedEvents.length === 1, '3B-pre. FISH_HOOKED fires (fight started)');

  // Read baseline — trophyMultiplier is 1.0 after _startFight.
  const multBefore  = fish.trophyMultiplier;
  const clockBefore = clock.nowMs();

  // Tap SPACEBAR — should be a complete no-op for crooked_stick.
  bus.emit('INPUT_SPACEBAR', { atMs: clockBefore });

  unsubRB();

  const multAfter  = fish.trophyMultiplier;
  const clockAfter = clock.nowMs();

  // ── 3B-a. Clock did NOT advance ──────────────────────────────────────────
  assertEqual(clockAfter, clockBefore,
    '3B-a. clock.nowMs() unchanged — clock.tick(1000) NOT called for crooked_stick');

  // ── 3B-b. trophyMultiplier unchanged ─────────────────────────────────────
  assertEqual(multAfter, multBefore,
    '3B-b. trophyMultiplier unchanged — reward NOT applied for crooked_stick');

  // ── 3B-c. ROD_BROKEN NOT emitted ─────────────────────────────────────────
  assertEqual(rodBrokenEvents.length, 0,
    '3B-c. ROD_BROKEN NOT emitted — snap roll skipped for crooked_stick (D-083)');
}

// ===========================================================================
// SECTION 4 — DECEPTIVE THUD
// ===========================================================================
// InitialPull = weightKg × styleMod × (0.8 + rng.next() × 0.4)
// styleMod:  BULLDOG/THRASHER=1.2, RUNNER/JUMPER=1.0, DIVER=0.8
// rng factor range: [0.8, 1.2)
//
// Fish parameters chosen so the token is deterministic regardless of rng.next():
//   STRIKE_LIGHT:    weightKg=0.1, styleMod=0.8(DIVER) → max InitialPull = 0.096 < 1.5  ✓
//   STRIKE_MODERATE: weightKg=2.0, styleMod=1.0(RUNNER) → range [1.6, 2.4] ⊂ [1.5, 3.5) ✓
//   STRIKE_HEAVY:    weightKg=5.0, styleMod=1.2(BULLDOG) → min InitialPull = 4.8 ≥ 3.5  ✓
section('4. DECEPTIVE THUD');
resetAll();
rng.seed(KNOWN_SEED);
buildTestWorld();
stateStore.dispatch({
  type:    'ACTIVE_TACKLE_SET',
  payload: { activeTackle: { rods: [], lures: [], bait: [] } },
});
stateStore.dispatch({ type: 'TOURNAMENT_ENTERED', payload: { id: 'thud_test', spec: null } });
transitionTo(MODES.TOURNAMENT_ACTIVE);

/**
 * Start a fight with the given fishInstance and collect the first STATE_ANNOUNCE token.
 * Returns the token or null if none fired.
 *
 * @param {object} fishInstance
 * @returns {string|null}
 */
function getStrikeToken(fishInstance) {
  const announceTokens = [];
  const unsubSA = bus.on('STATE_ANNOUNCE', e => announceTokens.push(e.token));
  bus.emit('BITE_THUD', { fishInstance, hooksetWindowMs: 800, castSpec: {}, atMs: clock.nowMs() });
  bus.emit('INPUT_ARROW_UP', { atMs: clock.nowMs() });
  unsubSA();
  // Return first STRIKE_* token (ignore subsequent non-STRIKE tokens if any)
  return announceTokens.find(t => t.startsWith('STRIKE_')) ?? null;
}

/**
 * Also assert that TIME_TO_FIGHT is NOT emitted during fight start (deprecated in v1.78).
 *
 * @param {object} fishInstance
 * @returns {{ strikeToken: string|null, timeToFightFired: boolean }}
 */
function getFightStartTokens(fishInstance) {
  const announceTokens = [];
  const unsubSA = bus.on('STATE_ANNOUNCE', e => announceTokens.push(e.token));
  bus.emit('BITE_THUD', { fishInstance, hooksetWindowMs: 800, castSpec: {}, atMs: clock.nowMs() });
  bus.emit('INPUT_ARROW_UP', { atMs: clock.nowMs() });
  unsubSA();
  return {
    strikeToken:     announceTokens.find(t => t.startsWith('STRIKE_')) ?? null,
    timeToFightFired: announceTokens.includes('TIME_TO_FIGHT'),
  };
}

// ── 4a. STRIKE_LIGHT for tiny DIVER fish ─────────────────────────────────────
{
  const fish = makeFishInstance({ weightKg: 0.1, fightStyle: 'DIVER' });
  const { strikeToken, timeToFightFired } = getFightStartTokens(fish);

  assertEqual(strikeToken, 'STRIKE_LIGHT',
    '4a. STRIKE_LIGHT emitted for 0.1kg DIVER (max InitialPull = 0.096 < 1.5)');
  assert(!timeToFightFired,
    '4a. TIME_TO_FIGHT NOT emitted (deprecated as of v1.78)');

  // Tear down this fight before next sub-test.
  transitionTo(MODES.HUB);
  // Re-mount for next test.
  transitionTo(MODES.TOURNAMENT_ACTIVE);
}

// ── 4b. STRIKE_MODERATE for mid-weight RUNNER fish ───────────────────────────
{
  const fish = makeFishInstance({ weightKg: 2.0, fightStyle: 'RUNNER' });
  const { strikeToken, timeToFightFired } = getFightStartTokens(fish);

  assertEqual(strikeToken, 'STRIKE_MODERATE',
    '4b. STRIKE_MODERATE emitted for 2.0kg RUNNER (InitialPull range [1.6, 2.4] ⊂ [1.5, 3.5))');
  assert(!timeToFightFired,
    '4b. TIME_TO_FIGHT NOT emitted (deprecated as of v1.78)');

  transitionTo(MODES.HUB);
  transitionTo(MODES.TOURNAMENT_ACTIVE);
}

// ── 4c. STRIKE_HEAVY for large BULLDOG fish ───────────────────────────────────
{
  const fish = makeFishInstance({ weightKg: 5.0, fightStyle: 'BULLDOG' });
  const { strikeToken, timeToFightFired } = getFightStartTokens(fish);

  assertEqual(strikeToken, 'STRIKE_HEAVY',
    '4c. STRIKE_HEAVY emitted for 5.0kg BULLDOG (min InitialPull = 4.8 ≥ 3.5)');
  assert(!timeToFightFired,
    '4c. TIME_TO_FIGHT NOT emitted (deprecated as of v1.78)');
}

// ── 4d. THRASHER style (=1.2) also produces STRIKE_HEAVY for large fish ───────
// Verify the THRASHER modifier is treated identically to BULLDOG (D-082, LOCKED).
{
  transitionTo(MODES.HUB);
  transitionTo(MODES.TOURNAMENT_ACTIVE);

  const fish = makeFishInstance({ weightKg: 5.0, fightStyle: 'THRASHER' });
  const token = getStrikeToken(fish);

  assertEqual(token, 'STRIKE_HEAVY',
    '4d. THRASHER style (styleMod=1.2) produces STRIKE_HEAVY identical to BULLDOG');
}

// ── 4e. JUMPER style (=1.0) produces STRIKE_MODERATE for mid-weight fish ──────
{
  transitionTo(MODES.HUB);
  transitionTo(MODES.TOURNAMENT_ACTIVE);

  const fish = makeFishInstance({ weightKg: 2.0, fightStyle: 'JUMPER' });
  const token = getStrikeToken(fish);

  assertEqual(token, 'STRIKE_MODERATE',
    '4e. JUMPER style (styleMod=1.0) produces STRIKE_MODERATE identical to RUNNER');
}

// ===========================================================================
// Final report
// ===========================================================================
resetAll();

console.log('\n' + '═'.repeat(62));
console.log(`  RESULTS: ${_passed} passed, ${_failed} failed`);
console.log('═'.repeat(62));

if (_failed > 0) {
  process.exit(1);
}
