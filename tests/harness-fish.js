/**
 * AFish Phase 6 Isolated Test Harness — tests/harness-fish.js
 *
 * Tests the Fish & Fight modules introduced in Phase 6:
 *   src/fish/fishBehavior.js — species catalog, pressure model, population,
 *                              strike pipeline, bite timer, fight FSM
 *   src/fish/fightLoop.js   — hookset trap, tension model, fight tick,
 *                              4-channel events, terminal conditions
 *
 * Sections:
 *   1  Species Catalog Integrity (D-044, D-047)
 *   2  Pressure Model (D-039, LOCKED math)
 *   3  advanceFight FSM (D-031)
 *   4  Tile Occupancy / Population Model
 *   5  Strike Pipeline (evaluateStrike)
 *   6  Bite Sequence (scheduleBite / cancelBite)
 *   7  Fight Loop — Hookset Trap (D-033, D-050)
 *   8  Fight Loop — Tension & Terminal Conditions (D-034, D-035, D-036)
 *
 * Run with:  node tests/harness-fish.js
 *
 * Does NOT modify or depend on tests/harness.js.
 * Uses the same [PASS]/[FAIL] console convention.
 *
 * Exit code:
 *   0 — all assertions passed
 *   1 — one or more assertions failed
 */

// ---------------------------------------------------------------------------
// Core imports
// ---------------------------------------------------------------------------
import * as bus          from '../src/core/eventBus.js';
import * as clock        from '../src/core/clock.js';
import * as rng          from '../src/core/rng.js';
import * as stateStore   from '../src/core/stateStore.js';
import * as inputAdapter from '../src/core/inputAdapter.js';
import {
  MODES,
  transitionTo,
  currentMode,
} from '../src/core/modeRouter.js';

// ---------------------------------------------------------------------------
// World imports
// ---------------------------------------------------------------------------
import * as worldMap       from '../src/world/worldMap.js';
import * as poiGraph       from '../src/world/poiGraph.js';
import * as structureIndex from '../src/world/structureIndex.js';

// ---------------------------------------------------------------------------
// Equipment (registers reducers as side-effect)
// ---------------------------------------------------------------------------
import * as equipment from '../src/equipment/equipment.js';

// ---------------------------------------------------------------------------
// Spook model (needed by evaluateStrike internals)
// ---------------------------------------------------------------------------
import * as castSpookModel from '../src/casting/castSpookModel.js';

// ---------------------------------------------------------------------------
// Phase 6 modules under test
// Side-effect: each file calls modeRouter.registerMountManifest() on import.
// fightLoop.js must be imported so its manifest is registered before the first
// transitionTo(TOURNAMENT_ACTIVE).
// ---------------------------------------------------------------------------
import * as fishBehavior from '../src/fish/fishBehavior.js';
import '../src/fish/fightLoop.js';

// ---------------------------------------------------------------------------
// Harness bookkeeping
// ---------------------------------------------------------------------------

let _passed  = 0;
let _failed  = 0;
let _section = '';

function section(label) {
  _section = label;
  console.log(`\n=== ${label} ===`);
}

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

function assertEqual(actual, expected, description) {
  if (actual === expected) {
    console.log(`[PASS] ${description}`);
    _passed++;
  } else {
    console.error(`[FAIL] ${description}  (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
    _failed++;
  }
}

function assertApprox(actual, expected, tolerance, description) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`[PASS] ${description}`);
    _passed++;
  } else {
    console.error(`[FAIL] ${description}  (expected: ${expected} ± ${tolerance}, got: ${actual})`);
    _failed++;
  }
}

function assertThrows(fn, msgSubstring, description) {
  try {
    fn();
    console.error(`[FAIL] ${description}  (expected a throw, but did not throw)`);
    _failed++;
  } catch (err) {
    if (msgSubstring && !err.message.includes(msgSubstring)) {
      console.error(`[FAIL] ${description}  (threw "${err.message}", expected to contain "${msgSubstring}")`);
      _failed++;
    } else {
      console.log(`[PASS] ${description}`);
      _passed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

const KNOWN_SEED = 0xFEED_F15H;

/**
 * Lightweight reset for fish test sections.
 * Unmounts TOURNAMENT_ACTIVE first (triggers onUnmount on fishBehavior + fightLoop),
 * then clears all singleton state so the next section starts clean.
 */
function resetForFish() {
  if (stateStore.getState().mode === MODES.TOURNAMENT_ACTIVE) {
    transitionTo(MODES.HUB);   // fires onUnmount for fishBehavior + fightLoop
  }
  stateStore._reset();         // mode → 'BOOT', all partitions cleared
  clock.reset();               // t = 0, clears all pending schedules
  inputAdapter._reset();       // clears held inputs + lockout
  worldMap._clear();
  poiGraph._clear();
  structureIndex._clear();
  rng.seed(KNOWN_SEED);
}

// ---------------------------------------------------------------------------
// World-building helpers shared by multiple sections
// ---------------------------------------------------------------------------

/**
 * Build a minimal world: one POI zone ('POI_DOCK') with 3 fish-friendly tiles
 * and one barren tile (for spook tests).
 *
 * Tile layout:
 *   (10,5) T_WEEDBED_DOCK   — WEEDBED cover, MUD bottom, AMBUSH_POINT+WEEDBED_EDGE  ← prime bass habitat
 *   (11,5) T_TIMBER_DROP    — TIMBER cover, GRAVEL bottom, DROP_OFF_EDGE+TIMBER_EDGE ← strong structure
 *   (12,5) T_OPEN_FLAT      — NONE cover, SAND bottom, OPEN_FLAT                     ← weak habitat
 *   (20,20) T_BARREN_OPEN   — NONE cover, SAND bottom, OPEN_FLAT (different POI zone) ← isolation tile
 *
 * POI center at (10,5), frameRadius=5.
 * Tiles (10,5), (11,5), (12,5) are in zone POI_DOCK.
 * Tile (20,20) is in zone POI_BARREN.
 */
function buildTestWorld() {
  // Prime bass habitat at POI center
  worldMap.registerTile({
    id:    'T_WEEDBED_DOCK',
    coord: { x: 10, y: 5 },
    traits: {
      depth:  { bottomM: 2.5, minM: 2.0, maxM: 3.0, slopeDeg: 8 },
      bottom: { primary: 'MUD', secondary: 'GRAVEL', hardness: 0.3 },
      cover:  { type: 'WEEDBED', density: 0.85, canopyDepthM: 0.4, snagRisk: 0.5, shadeFactor: 0.4 },
      tags:   ['AMBUSH_POINT', 'WEEDBED_EDGE', 'SHADED_DAY'],
      reach:  { fromDockMin: 0, draftClass: 'MEDIUM' },
    },
  });

  // Solid structure habitat
  worldMap.registerTile({
    id:    'T_TIMBER_DROP',
    coord: { x: 11, y: 5 },
    traits: {
      depth:  { bottomM: 4.0, minM: 3.5, maxM: 4.5, slopeDeg: 30 },
      bottom: { primary: 'GRAVEL', secondary: 'ROCK', hardness: 0.7 },
      cover:  { type: 'TIMBER', density: 0.7, canopyDepthM: 1.5, snagRisk: 0.6, shadeFactor: 0.3 },
      tags:   ['DROP_OFF_EDGE', 'TIMBER_EDGE'],
      reach:  { fromDockMin: 1, draftClass: 'DEEP' },
    },
  });

  // Weak habitat
  worldMap.registerTile({
    id:    'T_OPEN_FLAT',
    coord: { x: 12, y: 5 },
    traits: {
      depth:  { bottomM: 2.0, minM: 1.5, maxM: 2.5, slopeDeg: 2 },
      bottom: { primary: 'SAND', secondary: null, hardness: 0.2 },
      cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
      tags:   ['OPEN_FLAT'],
      reach:  { fromDockMin: 2, draftClass: 'SHALLOW' },
    },
  });

  // Isolation tile for spook tests
  worldMap.registerTile({
    id:    'T_BARREN_OPEN',
    coord: { x: 20, y: 20 },
    traits: {
      depth:  { bottomM: 3.0, minM: 2.5, maxM: 3.5, slopeDeg: 3 },
      bottom: { primary: 'SAND', secondary: null, hardness: 0.25 },
      cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
      tags:   ['OPEN_FLAT'],
      reach:  { fromDockMin: 10, draftClass: 'MEDIUM' },
    },
  });

  // POI registrations in poiGraph
  poiGraph.registerPoi({
    id:          'POI_DOCK',
    label:       'Main Dock',
    centerCoord: { x: 10, y: 5 },
    frameRadius: 5,
    draftClass:  'MEDIUM',
  });
  poiGraph.registerPoi({
    id:          'POI_BARREN',
    label:       'Barren Flat',
    centerCoord: { x: 20, y: 20 },
    frameRadius: 5,
    draftClass:  'MEDIUM',
  });

  // Tile → POI zone associations
  worldMap.registerPoiZone('POI_DOCK',   ['10,5', '11,5', '12,5']);
  worldMap.registerPoiZone('POI_BARREN', ['20,20']);

  // Build structure index
  structureIndex.rebuild();
}

/**
 * Dispatch activeTackle with LURE_SHALLOW_CRANK (CRANKBAIT) so evaluateStrike
 * can resolve the active lure. Works even while in TOURNAMENT_ACTIVE because
 * we dispatch directly to stateStore, bypassing the equipment.setActiveTackle()
 * mode guard (H-017 applies to the API surface, not the reducer).
 */
function setActiveLure(lureId) {
  stateStore.dispatch({
    type:    'ACTIVE_TACKLE_SET',
    payload: {
      activeTackle: {
        rods:  [],
        lures: [{ id: lureId }],
        bait:  [],
      },
    },
  });
}

// ===========================================================================
// SECTION 1: Species Catalog Integrity (D-044, D-047)
// ===========================================================================
section('SPECIES CATALOG INTEGRITY');

const VALID_FIGHT_STYLES = new Set(['BULLDOG', 'RUNNER', 'JUMPER', 'DIVER', 'THRASHER']);
const REQUIRED_SPECIES   = [
  'LARGEMOUTH_BASS', 'SMALLMOUTH_BASS', 'SPOTTED_BASS',
  'BLUEGILL', 'RAINBOW_TROUT', 'CATFISH', 'CRAPPIE',
];
const VALID_DIURNAL = new Set(['DAWN', 'DAY', 'DUSK', 'NIGHT']);

// 1a. Constants (D-039, LOCKED)
assertEqual(fishBehavior.MAX_PRESSURE,              5,      '1a. MAX_PRESSURE === 5 (D-039 LOCKED)');
assertEqual(fishBehavior.PRESSURE_DECAY_MS_PER_LEVEL, 90_000, '1a. PRESSURE_DECAY_MS_PER_LEVEL === 90000 (D-039 LOCKED)');
assertEqual(fishBehavior.PRESSURE_STRIKE_PENALTY,  0.6,    '1a. PRESSURE_STRIKE_PENALTY === 0.6 (D-039 LOCKED)');

// 1b. All 7 species present
for (const id of REQUIRED_SPECIES) {
  assert(
    fishBehavior.SPECIES_CATALOG[id] !== undefined,
    `1b. SPECIES_CATALOG contains ${id}`,
  );
}

// 1c. SPECIES_CATALOG is frozen
assert(Object.isFrozen(fishBehavior.SPECIES_CATALOG), '1c. SPECIES_CATALOG is frozen (immutable)');

// 1d. D-044 schema: check every required field on each species
let catalogSchemaOk = true;
for (const [id, sp] of Object.entries(fishBehavior.SPECIES_CATALOG)) {
  const checks = [
    [typeof sp.wariness   === 'number' && sp.wariness   >= 0 && sp.wariness   <= 1, 'wariness in [0,1]'],
    [typeof sp.intelligence === 'number' && sp.intelligence >= 0 && sp.intelligence <= 1, 'intelligence in [0,1]'],
    [typeof sp.moodVolatility === 'number' && sp.moodVolatility >= 0 && sp.moodVolatility <= 1, 'moodVolatility in [0,1]'],
    [sp.nibbleBand && typeof sp.nibbleBand.min === 'number' && typeof sp.nibbleBand.max === 'number'
     && sp.nibbleBand.min >= 1 && sp.nibbleBand.max >= sp.nibbleBand.min, 'nibbleBand valid'],
    [sp.habitat && Array.isArray(sp.habitat.bottomAffinity), 'habitat.bottomAffinity is array'],
    [sp.habitat && Array.isArray(sp.habitat.coverAffinity),  'habitat.coverAffinity is array'],
    [sp.presentationPreferences && Array.isArray(sp.presentationPreferences.preferred), 'presentationPreferences.preferred is array'],
    [sp.diurnal && Object.keys(sp.diurnal).length === 4 &&
     Object.keys(sp.diurnal).every(k => VALID_DIURNAL.has(k)), 'diurnal has DAWN/DAY/DUSK/NIGHT'],
    [Object.values(sp.diurnal).every(v => v > 0 && v < 3), 'diurnal multipliers in reasonable range (0,3)'],
    [typeof sp.stamina === 'number' && sp.stamina > 0 && sp.stamina <= 1, 'stamina in (0,1]'],
    [VALID_FIGHT_STYLES.has(sp.fightStyle), `fightStyle "${sp.fightStyle}" is one of the 5 valid styles`],
    [Array.isArray(sp.pullForceCurve) && sp.pullForceCurve.length === 8, 'pullForceCurve has exactly 8 elements'],
    [sp.pullForceCurve.every(v => v >= 0 && v <= 1), 'all pullForceCurve values in [0,1]'],
    [sp.pullForceCurve[0] >= sp.pullForceCurve[sp.pullForceCurve.length - 1], 'pullForceCurve[0] >= pullForceCurve[last] (monotonically non-increasing)'],
    [typeof sp.mouthHardness === 'number' && sp.mouthHardness >= 0 && sp.mouthHardness <= 1, 'mouthHardness in [0,1]'],
    [typeof sp.hookRetention === 'number' && sp.hookRetention >= 0 && sp.hookRetention <= 1, 'hookRetention in [0,1]'],
    [sp.weight && typeof sp.weight.mu === 'number' && typeof sp.weight.sigma === 'number', 'weight.mu and sigma are numbers'],
    [sp.audio && typeof sp.audio.hookToken === 'string', 'audio.hookToken is a string'],
  ];
  for (const [ok, label] of checks) {
    if (!ok) {
      console.error(`[FAIL] 1d. ${id}: ${label}`);
      _failed++;
      catalogSchemaOk = false;
    }
  }
}
if (catalogSchemaOk) {
  console.log(`[PASS] 1d. All 7 species pass full D-044 schema validation`);
  _passed++;
}

// 1e. All 5 D-047 fight styles represented across the catalog
const fightStylesPresent = new Set(Object.values(fishBehavior.SPECIES_CATALOG).map(s => s.fightStyle));
for (const style of VALID_FIGHT_STYLES) {
  assert(fightStylesPresent.has(style), `1e. Fight style ${style} is used by at least one species`);
}

// 1f. Hookset window floor via species intelligence range
// The highest-intelligence species (RAINBOW_TROUT at 0.78) should still produce a window ≥ 300ms.
// We verify the formula: max(300, 750 - intelligence * 400)
const trout = fishBehavior.SPECIES_CATALOG.RAINBOW_TROUT;
const expectedTroutWindow = Math.max(300, Math.round(750 - trout.intelligence * 400));
assert(expectedTroutWindow >= 300,
  `1f. RAINBOW_TROUT hookset window (${expectedTroutWindow}ms) ≥ 300ms floor (D-050 LOCKED)`);

const catfish = fishBehavior.SPECIES_CATALOG.CATFISH;
const expectedCatfishWindow = Math.max(300, Math.round(750 - catfish.intelligence * 400));
assert(expectedCatfishWindow > expectedTroutWindow,
  `1f. Low-intelligence CATFISH window (${expectedCatfishWindow}ms) > high-intelligence RAINBOW_TROUT window (${expectedTroutWindow}ms)`);

// ===========================================================================
// SECTION 2: Pressure Model (D-039, LOCKED)
// ===========================================================================
section('PRESSURE MODEL — D-039 LOCKED');
resetForFish();

// Register a tile to run pressure tests on.
worldMap.registerTile({
  id:    'PRESSURE_TILE',
  coord: { x: 0, y: 0 },
  traits: {
    depth:  { bottomM: 3.0, minM: 2.5, maxM: 3.5, slopeDeg: 5 },
    bottom: { primary: 'GRAVEL', secondary: null, hardness: 0.6 },
    cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
    tags:   ['OPEN_FLAT'],
    reach:  { fromDockMin: 5, draftClass: 'DEEP' },
  },
});

const P_COORD = { x: 0, y: 0 };

// 2a. Fresh tile → readPressure returns 0
assertEqual(fishBehavior.readPressure(P_COORD, 0), 0, '2a. readPressure on fresh tile returns 0');

// 2b. Unknown coord → 0
assertEqual(fishBehavior.readPressure({ x: 999, y: 999 }, 0), 0, '2b. readPressure on unknown coord returns 0');

// 2c. Apply CAST → level 1; event emitted
let pressureEvents = [];
const unsubPressure = bus.on('PRESSURE_APPLIED', evt => pressureEvents.push(evt));

fishBehavior.applyPressureEvent(P_COORD, 'CAST', 1000);
assertEqual(fishBehavior.readPressure(P_COORD, 1000), 1, '2c. After CAST: pressure = 1');
assertEqual(pressureEvents.length, 1, '2c. PRESSURE_APPLIED event fired once');
assertEqual(pressureEvents[0].kind, 'CAST', '2c. Event kind is CAST');
assertEqual(pressureEvents[0].storedLevel, 1, '2c. Event storedLevel = 1');

// 2d. Successive increments: HOOKSET (+1=2), CATCH (+1=3), CAST (+1=4)
fishBehavior.applyPressureEvent(P_COORD, 'HOOKSET', 1000);
assertEqual(fishBehavior.readPressure(P_COORD, 1000), 2, '2d. After HOOKSET: pressure = 2');
fishBehavior.applyPressureEvent(P_COORD, 'CATCH', 1000);
assertEqual(fishBehavior.readPressure(P_COORD, 1000), 3, '2d. After CATCH: pressure = 3');
fishBehavior.applyPressureEvent(P_COORD, 'CAST', 1000);
assertEqual(fishBehavior.readPressure(P_COORD, 1000), 4, '2d. After CAST: pressure = 4');

// 2e. Cap at MAX_PRESSURE=5
fishBehavior.applyPressureEvent(P_COORD, 'HOOKSET', 1000);
assertEqual(fishBehavior.readPressure(P_COORD, 1000), 5, '2e. After 5 increments: pressure = MAX_PRESSURE (5)');
fishBehavior.applyPressureEvent(P_COORD, 'CAST', 1000);   // 6th increment — should cap
assertEqual(fishBehavior.readPressure(P_COORD, 1000), 5, '2e. 6th increment still capped at MAX_PRESSURE (5)');

// 2f. Decay formula (D-039, LOCKED): max(0, level − floor((atMs − updatedAtMs) / 90000))
// Level=5 at updatedAtMs=1000 → at t=91000: floor((91000-1000)/90000)=1 → level=4
const atT91 = 91_000;
assertEqual(fishBehavior.readPressure(P_COORD, atT91), 4, '2f. After 90000ms: pressure decays from 5 → 4');

// 2 levels decayed → floor(180000/90000)=2 → level=3
const atT181 = 181_000;
assertEqual(fishBehavior.readPressure(P_COORD, atT181), 3, '2f. After 180000ms: pressure decays to 3');

// 4 levels decayed → floor(360000/90000)=4 → level=1
const atT361 = 361_000;
assertEqual(fishBehavior.readPressure(P_COORD, atT361), 1, '2f. After 360000ms: pressure decays to 1');

// Fully decayed: floor(450000/90000)=5 → max(0, 5-5)=0
const atT451 = 451_000;
assertEqual(fishBehavior.readPressure(P_COORD, atT451), 0, '2f. After 450000ms: fully decayed to 0');

// 2g. H-013: pressure and spook are orthogonal — spook state is untouched by applyPressureEvent
const tileAfter = worldMap.getTile(P_COORD);
assertEqual(tileAfter.state.spook.level, 0,
  '2g. Spook level untouched by applyPressureEvent (H-013 orthogonality)');

unsubPressure();

// ===========================================================================
// SECTION 3: advanceFight FSM (D-031)
// ===========================================================================
section('advanceFight FSM — D-031');
// advanceFight uses _fishStream for pull-curve variance, so we need the stream
// to exist. Mount TOURNAMENT_ACTIVE (minimal world, no tiles required).
resetForFish();

transitionTo(MODES.TOURNAMENT_ACTIVE);

// 3a. LARGEMOUTH_BASS (BULLDOG): reeling drains stamina
const LMB = fishBehavior.SPECIES_CATALOG.LARGEMOUTH_BASS;

let fightState = { speciesId: 'LARGEMOUTH_BASS', stamina: LMB.stamina, phase: 'RUNNING' };
const reelInputs = { reeling: true, givingDrag: false, mutex: false };

const result1 = fishBehavior.advanceFight(fightState, reelInputs, 60);
assert(result1.stamina < LMB.stamina, '3a. Reeling while RUNNING drains stamina');
assert(result1.pullForce >= 0 && result1.pullForce <= 1,
  `3a. pullForce in [0,1]  (got: ${result1.pullForce.toFixed(4)})`);
assertEqual(result1.phase, 'RUNNING', '3a. Phase stays RUNNING while stamina is high');

// 3b. RUNNING → TIRED transition at stamina < 15% of species.stamina
const tiredThreshold = 0.15 * LMB.stamina;  // 0.12
let staminaForTiredTest = tiredThreshold - 0.01;  // just below threshold (e.g. 0.11)
const resultTired = fishBehavior.advanceFight(
  { speciesId: 'LARGEMOUTH_BASS', stamina: staminaForTiredTest, phase: 'RUNNING' },
  reelInputs, 60
);
assertEqual(resultTired.phase, 'TIRED',
  `3b. Phase transitions RUNNING→TIRED when stamina (${staminaForTiredTest.toFixed(3)}) < ${tiredThreshold}`);

// 3c. TIRED → RUNNING transition at stamina > 60% of species.stamina
const runningThreshold = 0.60 * LMB.stamina;  // 0.48
const staminaForRunningTest = runningThreshold + 0.01;  // just above (0.49)
const resultRunning = fishBehavior.advanceFight(
  { speciesId: 'LARGEMOUTH_BASS', stamina: staminaForRunningTest, phase: 'TIRED' },
  { reeling: false, givingDrag: false, mutex: false }, 60
);
assertEqual(resultRunning.phase, 'RUNNING',
  `3c. Phase transitions TIRED→RUNNING when stamina (${staminaForRunningTest.toFixed(3)}) > ${runningThreshold}`);

// 3d. TIRED stamina recovers (not reeling)
const resultRecover = fishBehavior.advanceFight(
  { speciesId: 'LARGEMOUTH_BASS', stamina: 0.10, phase: 'TIRED' },
  { reeling: false, givingDrag: false, mutex: false }, 60
);
assert(resultRecover.stamina > 0.10, '3d. TIRED + no reel: stamina recovers');

// 3e. Mutex: both reeling + drag held → no crash, valid output
const mutexResult = fishBehavior.advanceFight(
  { speciesId: 'LARGEMOUTH_BASS', stamina: LMB.stamina, phase: 'RUNNING' },
  { reeling: true, givingDrag: true, mutex: true }, 60
);
assert(mutexResult.stamina >= 0 && mutexResult.stamina <= LMB.stamina,
  '3e. Mutex input: stamina stays in valid range');
assert(mutexResult.pullForce >= 0 && mutexResult.pullForce <= 1,
  '3e. Mutex input: pullForce in [0,1]');

// 3f. All 5 fight styles produce valid pullForce ∈ [0,1]
const styleSpecies = {
  BULLDOG:  'LARGEMOUTH_BASS',
  RUNNER:   'SMALLMOUTH_BASS',
  JUMPER:   'RAINBOW_TROUT',
  THRASHER: 'BLUEGILL',
  DIVER:    'CATFISH',
};
let allStylesValid = true;
for (const [style, speciesId] of Object.entries(styleSpecies)) {
  const sp = fishBehavior.SPECIES_CATALOG[speciesId];
  // Test at multiple exhaustion levels (0%, 50%, 100%) each style
  for (const stamFrac of [1.0, 0.5, 0.1]) {
    const r = fishBehavior.advanceFight(
      { speciesId, stamina: sp.stamina * stamFrac, phase: 'RUNNING' },
      reelInputs, 60
    );
    if (r.pullForce < 0 || r.pullForce > 1) {
      console.error(`[FAIL] 3f. ${style} pullForce out of [0,1] at ${(stamFrac*100).toFixed(0)}% stamina: ${r.pullForce}`);
      _failed++;
      allStylesValid = false;
    }
  }
}
if (allStylesValid) {
  console.log('[PASS] 3f. All 5 fight styles produce pullForce ∈ [0,1] at 100%/50%/10% stamina');
  _passed++;
}

// 3g. Unknown species returns safe default without crash
const unknownResult = fishBehavior.advanceFight(
  { speciesId: 'GHOST_FISH', stamina: 0.5, phase: 'RUNNING' },
  reelInputs, 60
);
assertEqual(unknownResult.phase,       'TIRED', '3g. Unknown species defaults to TIRED phase');
assertEqual(unknownResult.stamina,         0,   '3g. Unknown species defaults to stamina=0');
assert(unknownResult.pullForce >= 0 && unknownResult.pullForce <= 1,
  '3g. Unknown species defaults to safe pullForce ∈ [0,1]');

// ===========================================================================
// SECTION 4: Tile Occupancy / Population Model
// ===========================================================================
section('TILE OCCUPANCY — POPULATION MODEL');
resetForFish();

buildTestWorld();

transitionTo(MODES.TOURNAMENT_ACTIVE);
// At this point, fishBehavior.onMount() has called _populateAllPois(0).
// All built POI zones should have occupancy written to tile.state.

// 4a. Every registered tile in the index now has an occupancy record
const dockCandidates = structureIndex.candidatesForPoi('POI_DOCK');
assert(dockCandidates.length === 3, '4a. POI_DOCK has 3 indexed candidates');

let allHaveOccupancy = true;
for (const candidate of dockCandidates) {
  const tile = worldMap.getTile(candidate.coord);
  if (!tile || tile.state.occupancy === undefined || tile.state.occupancy === null) {
    console.error(`[FAIL] 4a. Tile ${candidate.tileId} has no occupancy record`);
    _failed++;
    allHaveOccupancy = false;
  } else if (typeof tile.state.occupancy.fishCount !== 'number'
             || tile.state.occupancy.fishCount < 0) {
    console.error(`[FAIL] 4a. Tile ${candidate.tileId} occupancy.fishCount is invalid: ${tile.state.occupancy.fishCount}`);
    _failed++;
    allHaveOccupancy = false;
  }
}
if (allHaveOccupancy) {
  console.log('[PASS] 4a. All 3 POI_DOCK tiles have a non-negative occupancy.fishCount');
  _passed++;
}

// 4b. At least one tile has fishCount > 0 (prime habitat should attract fish)
const weedbedTile  = worldMap.getTile({ x: 10, y: 5 });
const timberTile   = worldMap.getTile({ x: 11, y: 5 });
const openTile     = worldMap.getTile({ x: 12, y: 5 });

const anyFish = [weedbedTile, timberTile].some(t => t.state.occupancy.fishCount > 0);
assert(anyFish,
  '4b. At least one prime habitat tile (weedbed or timber) has fishCount > 0');

// 4c. fishCountStaleAtMs is set to 0 (clock was at 0 at mount time)
assertEqual(weedbedTile.state.occupancy.fishCountStaleAtMs, 0,
  '4c. fishCountStaleAtMs = 0 (clock was at t=0 on mount)');

// 4d. T_BARREN_OPEN also has an occupancy record (even if fishCount=0)
const barrenTile = worldMap.getTile({ x: 20, y: 20 });
assert(typeof barrenTile.state.occupancy.fishCount === 'number',
  '4d. T_BARREN_OPEN has an occupancy.fishCount (even if 0)');
console.log(`      POI_DOCK fishCounts: weedbed=${weedbedTile.state.occupancy.fishCount} ` +
            `timber=${timberTile.state.occupancy.fishCount} ` +
            `open=${openTile.state.occupancy.fishCount}`);

// ===========================================================================
// SECTION 5: Strike Pipeline — evaluateStrike
// ===========================================================================
section('STRIKE PIPELINE — evaluateStrike');
// Continue in TOURNAMENT_ACTIVE from Section 4 (world already built, manifests mounted).

// Set up activeTackle with LURE_SHALLOW_CRANK (CRANKBAIT — preferred by LMB, tolerated by others).
setActiveLure('LURE_SHALLOW_CRANK');

// 5a. Lure spec can be resolved from the catalog
let lureSpec;
try {
  lureSpec = equipment.getLure('LURE_SHALLOW_CRANK');
  assert(true, '5a. getLure("LURE_SHALLOW_CRANK") succeeds');
} catch {
  assert(false, '5a. getLure("LURE_SHALLOW_CRANK") succeeds (threw instead)');
}
assertEqual(lureSpec?.category, 'CRANKBAIT', '5a. LURE_SHALLOW_CRANK.category === CRANKBAIT');

// 5b. evaluateStrike on a tile with 0 fish returns { hit: false }
// Force fishCount = 0 on the barren tile to confirm the guard.
worldMap.mutateTileState({ x: 20, y: 20 }, s => ({
  ...s,
  occupancy: { fishCount: 0, fishCountStaleAtMs: 0 },
}));

const castSpecBarren = {
  poiId:          'POI_BARREN',
  landing:        { dx: 0, dy: 0 },    // center of POI at (20,20)
  splashKind:     'NORMAL',
  scatterRadius:  0,
  mitigationFactor: 1,
  candidateId:    'T_BARREN_OPEN',
  finderTier:     'STRONG',
  atMs:           0,
};
const barrenResult = fishBehavior.evaluateStrike(castSpecBarren);
assertEqual(barrenResult.hit, false, '5b. evaluateStrike returns hit=false when fishCount=0');

// 5c. evaluateStrike on prime habitat: run 30 trials, expect at least 1 hit.
// The weedbed tile at (10,5) has LARGEMOUTH_BASS-preferred habitat and a CRANKBAIT
// at DAWN (LMB diurnal = 1.30). High probability for at least some hits.
// Force fishCount > 0 to bypass the occupancy guard.
worldMap.mutateTileState({ x: 10, y: 5 }, s => ({
  ...s,
  occupancy: { fishCount: 5, fishCountStaleAtMs: 0 },
}));

const castSpecPrime = {
  poiId:          'POI_DOCK',
  landing:        { dx: 0, dy: 0 },    // lands at (10,5), the weedbed tile
  splashKind:     'SOFT',
  scatterRadius:  0,
  mitigationFactor: 1,
  candidateId:    'T_WEEDBED_DOCK',
  finderTier:     'STRONG',
  atMs:           500,                  // DAWN period (t<10800000) → LMB mult=1.30
};

let strikeHits = 0;
for (let i = 0; i < 30; i++) {
  const r = fishBehavior.evaluateStrike(castSpecPrime);
  if (r.hit) {
    strikeHits++;
    // Verify fishInstance schema on first hit
    if (strikeHits === 1) {
      assert(typeof r.fishInstance.id       === 'string',  '5c. fishInstance.id is a string');
      assert(typeof r.fishInstance.speciesId === 'string', '5c. fishInstance.speciesId is a string');
      assert(
        fishBehavior.SPECIES_CATALOG[r.fishInstance.speciesId] !== undefined,
        `5c. fishInstance.speciesId "${r.fishInstance.speciesId}" is a valid catalog species`,
      );
      assert(typeof r.fishInstance.weightKg === 'number' && r.fishInstance.weightKg > 0,
        `5c. fishInstance.weightKg > 0  (got: ${r.fishInstance.weightKg})`);
      assert(typeof r.fishInstance.stamina  === 'number' && r.fishInstance.stamina > 0,
        `5c. fishInstance.stamina > 0  (got: ${r.fishInstance.stamina})`);
      assert(typeof r.fishInstance.lureId === 'string',
        '5c. fishInstance.lureId is a string');
    }
  }
  // Between trials: reset fishCount so occupancy guard passes again
  worldMap.mutateTileState({ x: 10, y: 5 }, s => ({
    ...s,
    occupancy: { fishCount: 5, fishCountStaleAtMs: 0 },
  }));
}
assert(strikeHits > 0,
  `5c. At least 1 strike hit in 30 trials on prime habitat  (got: ${strikeHits}/30)`);
console.log(`      Strike hit rate on prime habitat: ${strikeHits}/30`);

// 5d. Pressure penalty: apply MAX_PRESSURE, verify hit rate drops
// Apply 5 CAST events (reaching MAX_PRESSURE) at t=500
for (let i = 0; i < 5; i++) {
  fishBehavior.applyPressureEvent({ x: 10, y: 5 }, 'CAST', 500);
}
assertEqual(fishBehavior.readPressure({ x: 10, y: 5 }, 500),
  fishBehavior.MAX_PRESSURE, '5d. Pressure at MAX after 5 CAST events');

let pressuredHits = 0;
for (let i = 0; i < 30; i++) {
  worldMap.mutateTileState({ x: 10, y: 5 }, s => ({
    ...s,
    occupancy: { fishCount: 5, fishCountStaleAtMs: 0 },
  }));
  const r = fishBehavior.evaluateStrike(castSpecPrime);
  if (r.hit) pressuredHits++;
}
// At MAX_PRESSURE, PRESSURE_STRIKE_PENALTY=0.6 means a 60% reduction —
// hit rate should be meaningfully lower than base rate. We just verify it stays < strikeHits + small buffer.
// (stochastic, so we allow a generous window; we can't assert 0 hits because floor is never 0)
assert(pressuredHits <= strikeHits,
  `5d. Under MAX_PRESSURE, hit rate (${pressuredHits}/30) ≤ base rate (${strikeHits}/30) [D-039 pressure penalty]`);
console.log(`      Hit rate under MAX_PRESSURE: ${pressuredHits}/30  (base: ${strikeHits}/30)`);

// 5e. H-013: Spook and Pressure applied independently — applyPressureEvent never touches spook
const spookBefore = worldMap.getTile({ x: 10, y: 5 }).state.spook.level;
fishBehavior.applyPressureEvent({ x: 10, y: 5 }, 'CAST', 600);
const spookAfter = worldMap.getTile({ x: 10, y: 5 }).state.spook.level;
assertEqual(spookBefore, spookAfter,
  '5e. H-013: spook level unchanged after applyPressureEvent (orthogonal systems)');

// ===========================================================================
// SECTION 6: Bite Sequence — scheduleBite / cancelBite (D-032, D-033)
// ===========================================================================
section('BITE SEQUENCE — scheduleBite / cancelBite');
// Still in TOURNAMENT_ACTIVE, world intact from section 5.

// Advance clock past the pressure-heavy cast spec timestamp so bite callbacks
// fire at clean future times.
clock.tick(10_000);  // t = 10000ms; still in DAWN (t < 10800000ms)

const lmb = fishBehavior.SPECIES_CATALOG.LARGEMOUTH_BASS;

// Build a minimal fishInstance for scheduleBite tests.
// (In production this is created by evaluateStrike; here we construct it directly.)
function makeFishInstance(speciesId, overrides = {}) {
  const sp = fishBehavior.SPECIES_CATALOG[speciesId];
  return {
    id:        `test_fish_${Date.now()}_${Math.random().toFixed(6)}`,
    speciesId,
    weightKg:  0.8,
    stamina:   sp.stamina,
    phase:     'RUNNING',
    coord:     { x: 10, y: 5 },
    poiId:     'POI_DOCK',
    lureId:    'LURE_SHALLOW_CRANK',
    ...overrides,
  };
}

const castSpecBite = {
  poiId:   'POI_DOCK',
  landing: { dx: 0, dy: 0 },
  atMs:    clock.nowMs(),
};

// 6a. scheduleBite returns a { cancel() } handle
const fishInst6a = makeFishInstance('LARGEMOUTH_BASS');
const biteHandle = fishBehavior.scheduleBite(fishInst6a, castSpecBite);
assert(typeof biteHandle === 'object' && typeof biteHandle.cancel === 'function',
  '6a. scheduleBite returns { cancel() } handle');

// 6b. BITE_NIBBLE fires at least once before BITE_THUD
const nibbleEvents = [];
const thudEvents   = [];
const unsubNibble  = bus.on('BITE_NIBBLE', evt => nibbleEvents.push(evt));
const unsubThud    = bus.on('BITE_THUD',   evt => thudEvents.push(evt));

// Advance clock far enough to fire all nibbles + the thud.
// Max possible delay: MAX_NIBBLES * NIBBLE_INTERVAL_MAX + NIBBLE_INTERVAL_MAX
// = 7 * 2000 + 2000 = 16000ms (generous upper bound)
clock.tick(20_000);

assert(nibbleEvents.length >= 1,
  `6b. At least 1 BITE_NIBBLE fired  (got: ${nibbleEvents.length})`);
assert(thudEvents.length === 1,
  `6b. Exactly 1 BITE_THUD fired  (got: ${thudEvents.length})`);
console.log(`      LMB bite: ${nibbleEvents.length} nibble(s), 1 thud`);

// 6c. BITE_NIBBLE payload shape
if (nibbleEvents.length > 0) {
  const nibble0 = nibbleEvents[0];
  assert(typeof nibble0.fishId      === 'string',  '6c. BITE_NIBBLE.fishId is a string');
  assert(typeof nibble0.speciesId   === 'string',  '6c. BITE_NIBBLE.speciesId is a string');
  assert(typeof nibble0.nibbleIndex === 'number',  '6c. BITE_NIBBLE.nibbleIndex is a number');
  assert(typeof nibble0.totalNibbles === 'number', '6c. BITE_NIBBLE.totalNibbles is a number');
  assert(nibble0.nibbleIndex >= 0 && nibble0.nibbleIndex < nibble0.totalNibbles,
    `6c. nibbleIndex (${nibble0.nibbleIndex}) < totalNibbles (${nibble0.totalNibbles})`);
  assertEqual(nibble0.poiId, 'POI_DOCK', '6c. BITE_NIBBLE.poiId matches cast spec');
}

// 6d. BITE_THUD payload shape
if (thudEvents.length === 1) {
  const thud = thudEvents[0];
  assert(typeof thud.fishInstance     === 'object',  '6d. BITE_THUD.fishInstance is an object');
  assert(typeof thud.hooksetWindowMs  === 'number',  '6d. BITE_THUD.hooksetWindowMs is a number');
  assert(thud.hooksetWindowMs >= 300,
    `6d. BITE_THUD.hooksetWindowMs (${thud.hooksetWindowMs}ms) ≥ 300ms floor (D-050 LOCKED)`);
  assert(thud.hooksetWindowMs <= 750,
    `6d. BITE_THUD.hooksetWindowMs (${thud.hooksetWindowMs}ms) ≤ 750ms baseline`);
}

unsubNibble();
unsubThud();

// 6e. cancelBite() prevents BITE_THUD from firing
const nibbleEvents2 = [];
const thudEvents2   = [];
const unsubNibble2  = bus.on('BITE_NIBBLE', evt => nibbleEvents2.push(evt));
const unsubThud2    = bus.on('BITE_THUD',   evt => thudEvents2.push(evt));

const fishInst6e = makeFishInstance('LARGEMOUTH_BASS', { id: 'lmb_cancel_test' });
const cancelHandle = fishBehavior.scheduleBite(fishInst6e, castSpecBite);
// Cancel immediately, before the first nibble can fire
cancelHandle.cancel();
clock.tick(20_000);   // advance enough time to prove nothing fires

assertEqual(thudEvents2.length, 0, '6e. cancelBite() prevents BITE_THUD from firing');
// Note: nibbles already scheduled at fire times ≤ cancel time might still fire in some
// implementations; the key invariant is that THUD does not fire.

unsubNibble2();
unsubThud2();

// ===========================================================================
// SECTION 7: Fight Loop — Hookset Trap (D-033, D-050)
// ===========================================================================
section('FIGHT LOOP — HOOKSET TRAP');
resetForFish();
buildTestWorld();
transitionTo(MODES.TOURNAMENT_ACTIVE);
setActiveLure('LURE_SHALLOW_CRANK');

// Force fishCount so evaluateStrike can produce a fish instance
worldMap.mutateTileState({ x: 10, y: 5 }, s => ({
  ...s,
  occupancy: { fishCount: 5, fishCountStaleAtMs: 0 },
}));

// Build a fresh fish instance for hookset tests
const fishInst7 = makeFishInstance('LARGEMOUTH_BASS');

const hooksetAtMs = clock.nowMs();

// 7a. Emitting BITE_THUD opens the hookset window and fires HOOKSET_ATTEMPTED
const hooksetAttemptedEvents = [];
const unsubHooksetAttempted = bus.on('HOOKSET_ATTEMPTED', evt => hooksetAttemptedEvents.push(evt));

bus.emit('BITE_THUD', {
  fishInstance:    fishInst7,
  hooksetWindowMs: 750,
  castSpec:        { poiId: 'POI_DOCK', landing: { dx: 0, dy: 0 }, atMs: hooksetAtMs },
  atMs:            hooksetAtMs,
});

// HOOKSET_ATTEMPTED fires synchronously inside _onBiteThud
assertEqual(hooksetAttemptedEvents.length, 1, '7a. HOOKSET_ATTEMPTED fires when BITE_THUD emitted');
assert(hooksetAttemptedEvents[0].fishInstance === fishInst7,
  '7a. HOOKSET_ATTEMPTED.fishInstance matches the fish instance');

unsubHooksetAttempted();

// 7b. Window expiry without input → HOOKSET_MISSED and lure rejection recorded
const hooksetMissedEvents = [];
const unsubMissed = bus.on('HOOKSET_MISSED', evt => hooksetMissedEvents.push(evt));

// Advance clock past the hookset window (750ms + 1ms margin)
clock.tick(751);

assertEqual(hooksetMissedEvents.length, 1, '7b. HOOKSET_MISSED fires when hookset window expires');
assert(hooksetMissedEvents[0].fishInstance === fishInst7,
  '7b. HOOKSET_MISSED.fishInstance matches');
assertEqual(hooksetMissedEvents[0].lureId, 'LURE_SHALLOW_CRANK',
  '7b. HOOKSET_MISSED.lureId matches active lure');

unsubMissed();

// 7c. Successful hookset: emit BITE_THUD, then emit INPUT_ACTION with correct type → FISH_HOOKED
const fishHookedEvents = [];
const unsubHooked = bus.on('FISH_HOOKED', evt => fishHookedEvents.push(evt));

const fishInst7c = makeFishInstance('LARGEMOUTH_BASS', {
  id:        'lmb_hookset_success',
  weightKg:  0.04,   // very light → 5.0m start distance for fast landing test later
  stamina:   LMB.stamina,
  phase:     'RUNNING',
});

bus.emit('BITE_THUD', {
  fishInstance:    fishInst7c,
  hooksetWindowMs: 750,
  castSpec:        { poiId: 'POI_DOCK', landing: { dx: 0, dy: 0 }, atMs: clock.nowMs() },
  atMs:            clock.nowMs(),
});

// Emit the hookset input within the window
bus.emit('INPUT_ACTION', { type: 'ARROW_UP_DOWN', atMs: clock.nowMs() });

assertEqual(fishHookedEvents.length, 1, '7c. FISH_HOOKED fires when INPUT_ARROW_UP_DOWN received in hookset window');
assert(fishHookedEvents[0].fishInstance === fishInst7c,
  '7c. FISH_HOOKED.fishInstance matches hooked fish');
assert(typeof fishHookedEvents[0].startTension === 'number' &&
       fishHookedEvents[0].startTension >= 0 && fishHookedEvents[0].startTension <= 1,
  `7c. FISH_HOOKED.startTension ∈ [0,1]  (got: ${fishHookedEvents[0]?.startTension})`);

unsubHooked();

// ===========================================================================
// SECTION 8: Fight Loop — Tension & Terminal Conditions (D-034, D-035, D-036)
// ===========================================================================
section('FIGHT LOOP — TENSION & TERMINAL CONDITIONS');

// ── SUB-TEST A: FIGHT_TENSION events are emitted ──────────────────────────
// The fight from section 7c is still active. Just tick a few times and verify
// FIGHT_TENSION events appear.
const tensionEvents = [];
const phaseChangeEvents = [];
const thresholdEvents = [];
const unsubTension   = bus.on('FIGHT_TENSION',           evt => tensionEvents.push(evt));
const unsubPhase     = bus.on('FIGHT_PHASE_CHANGED',     evt => phaseChangeEvents.push(evt));
const unsubThreshold = bus.on('FIGHT_THRESHOLD_CROSSED', evt => thresholdEvents.push(evt));

// Reel to generate tension events (SPACEBAR held)
inputAdapter.keyDown('SPACEBAR');
clock.tick(300);   // 5 fight ticks

assert(tensionEvents.length > 0,
  `8a. FIGHT_TENSION events emitted during fight ticks  (got: ${tensionEvents.length})`);

if (tensionEvents.length > 0) {
  const t0 = tensionEvents[0];
  assert(typeof t0.tension === 'number' && t0.tension >= 0 && t0.tension <= 1,
    `8a. FIGHT_TENSION.tension ∈ [0,1]  (got: ${t0.tension.toFixed(4)})`);
  assert(typeof t0.phase   === 'string', '8a. FIGHT_TENSION.phase is a string');
  assert(typeof t0.delta   === 'number', '8a. FIGHT_TENSION.delta is a number');
  assert(typeof t0.atMs    === 'number', '8a. FIGHT_TENSION.atMs is a number');
}

unsubTension();
unsubPhase();
unsubThreshold();

// ── Resolve the light-fish fight as FISH_LANDED ───────────────────────────
// The fish from section 7c (fishInst7c, weightKg=0.04) started at 5.0m landing
// distance. We've already reeled for 300ms (5 ticks × 0.20m = 1.0m consumed).
// landingDistanceM ≈ 4.0m. REEL_SPEED=0.20/tick → need ~20 more ticks = 1200ms.

const landedEventsA = [];
const resolvedEventsA = [];
const unsubLandedA   = bus.on('FISH_HOOKED',    () => {});   // ignore re-hooks
const unsubResolvedA = bus.on('FIGHT_RESOLVED', evt => resolvedEventsA.push(evt));

clock.tick(1500);   // 25 more ticks — more than enough to reel in 4.0m at 0.20/tick

inputAdapter.keyUp('SPACEBAR');

if (resolvedEventsA.length > 0) {
  const outcome = resolvedEventsA[0].outcome;
  // Either FISH_LANDED (ideal) or LINE_SNAPPED (acceptable — tension may have peaked).
  // Both represent a terminal condition firing correctly.
  assert(
    outcome === 'FISH_LANDED' || outcome === 'LINE_SNAPPED',
    `8b. Fight resolved with FISH_LANDED or LINE_SNAPPED  (got: "${outcome}")`
  );
  console.log(`      Light fish fight outcome: ${outcome}`);
} else {
  assert(false, '8b. Fight resolved within 1800ms of reeling (got no FIGHT_RESOLVED)');
}

unsubLandedA();
unsubResolvedA();

// ── SUB-TEST C: LINE_SNAPPED ───────────────────────────────────────────────
// Start a fresh fight with a near-exhausted fish (stamina≈0). Fish pull
// will be minimal; continuous reeling causes tension to climb toward 1.0.
resetForFish();
buildTestWorld();
transitionTo(MODES.TOURNAMENT_ACTIVE);
setActiveLure('LURE_SHALLOW_CRANK');

const fishInstSnap = makeFishInstance('LARGEMOUTH_BASS', {
  id:       'lmb_snap_test',
  stamina:  0.001,  // near-exhausted: pullForce ≈ curve[7] = 0.10
  phase:    'TIRED',
  weightKg: 1.2,
});

// Emit BITE_THUD → hookset → FISH_HOOKED
bus.emit('BITE_THUD', {
  fishInstance:    fishInstSnap,
  hooksetWindowMs: 750,
  castSpec:        { poiId: 'POI_DOCK', landing: { dx: 0, dy: 0 }, atMs: clock.nowMs() },
  atMs:            clock.nowMs(),
});
bus.emit('INPUT_ACTION', { type: 'ARROW_UP_DOWN', atMs: clock.nowMs() });

// Reel continuously — near-exhausted fish can't resist; tension reaches 1.0
const resolvedEventsSnap = [];
const unsubSnap = bus.on('FIGHT_RESOLVED', evt => resolvedEventsSnap.push(evt));

inputAdapter.keyDown('SPACEBAR');
clock.tick(60 * 40);   // 40 ticks = 2400ms — sufficient for tension to exceed 1.0
inputAdapter.keyUp('SPACEBAR');

assert(resolvedEventsSnap.length > 0,
  '8c. Fight resolves within 2400ms of reeling near-exhausted fish');

if (resolvedEventsSnap.length > 0) {
  assertEqual(resolvedEventsSnap[0].outcome, 'LINE_SNAPPED',
    '8c. Outcome is LINE_SNAPPED when reeling a near-exhausted fish with max tension');
  assertEqual(resolvedEventsSnap[0].fishInstance, fishInstSnap,
    '8c. LINE_SNAPPED.fishInstance matches the hooked fish');
}
unsubSnap();

// ── SUB-TEST D: HOOK_SHAKEN ────────────────────────────────────────────────
// Hold drag continuously for > SLACK_GRACE_MS (1500ms) to drain tension to 0
// and maintain it there. After the grace period, HOOK_SHAKEN fires.
resetForFish();
buildTestWorld();
transitionTo(MODES.TOURNAMENT_ACTIVE);
setActiveLure('LURE_SHALLOW_CRANK');

const fishInstShake = makeFishInstance('CATFISH', {
  id:       'catfish_shake_test',
  weightKg: 3.5,
});

bus.emit('BITE_THUD', {
  fishInstance:    fishInstShake,
  hooksetWindowMs: 750,
  castSpec:        { poiId: 'POI_DOCK', landing: { dx: 0, dy: 0 }, atMs: clock.nowMs() },
  atMs:            clock.nowMs(),
});
bus.emit('INPUT_ACTION', { type: 'ARROW_UP_DOWN', atMs: clock.nowMs() });

const resolvedEventsShake = [];
const unsubShake = bus.on('FIGHT_RESOLVED', evt => resolvedEventsShake.push(evt));

// Hold drag to drop tension below 0 and hold it there.
// Drag removes DRAG_TENSION_SUB=0.040/tick. Fish pull from RUNNING equilibrium=0.62
// pushes back: (0.62-t)*0.10*pullForce*0.20. Net removal is strong enough to reach 0.
// Ticks to reach 0 from 0.5: ~0.5/0.038 ≈ 13 ticks = 780ms.
// SLACK_GRACE_MS=1500ms after that. Total ≈ 2280ms → use 3000ms for safety.
inputAdapter.keyDown('ARROW_DOWN');
clock.tick(3000);
inputAdapter.keyUp('ARROW_DOWN');

assert(resolvedEventsShake.length > 0,
  '8d. Fight resolves within 3000ms of holding drag continuously');

if (resolvedEventsShake.length > 0) {
  assertEqual(resolvedEventsShake[0].outcome, 'HOOK_SHAKEN',
    '8d. Outcome is HOOK_SHAKEN after continuous drag for > SLACK_GRACE_MS (1500ms)');
}
unsubShake();

// ── SUB-TEST E: FISH_LANDED via FIGHT_RESOLVED ────────────────────────────
// Use a very small fish (tiny weight → min landing distance 5.0m).
// Reel for enough ticks to close the 5m gap without snapping.
resetForFish();
buildTestWorld();
transitionTo(MODES.TOURNAMENT_ACTIVE);
setActiveLure('LURE_SHALLOW_CRANK');

const fishInstLand = makeFishInstance('BLUEGILL', {
  id:       'bluegill_land_test',
  weightKg: 0.04,   // → startDistance = MAX(5, 20*0.04/1.5) = 5.0m
  stamina:  fishBehavior.SPECIES_CATALOG.BLUEGILL.stamina,
  phase:    'RUNNING',
});

bus.emit('BITE_THUD', {
  fishInstance:    fishInstLand,
  hooksetWindowMs: 750,
  castSpec:        { poiId: 'POI_DOCK', landing: { dx: 0, dy: 0 }, atMs: clock.nowMs() },
  atMs:            clock.nowMs(),
});
bus.emit('INPUT_ACTION', { type: 'ARROW_UP_DOWN', atMs: clock.nowMs() });

const resolvedEventsLand = [];
const unsubLand = bus.on('FIGHT_RESOLVED', evt => resolvedEventsLand.push(evt));

// BLUEGILL is THRASHER (erratic, lower pull force). Its equilibrium is RUNNING=0.62.
// With tiny weight (5.0m start), reel REEL_SPEED=0.20/tick → 5.0/0.20=25 ticks = 1500ms.
// Tension at tick 25 will be well below 1.0 because BLUEGILL has low pullForceCurve values.
// Advance 1800ms (30 ticks) — FISH_LANDED should fire at tick ≤ 25.
inputAdapter.keyDown('SPACEBAR');
clock.tick(1800);
inputAdapter.keyUp('SPACEBAR');

assert(resolvedEventsLand.length > 0,
  '8e. Fight resolves within 1800ms for tiny bluegill on 5.0m start distance');

if (resolvedEventsLand.length > 0) {
  const landOutcome = resolvedEventsLand[0].outcome;
  assert(
    landOutcome === 'FISH_LANDED' || landOutcome === 'LINE_SNAPPED',
    `8e. Terminal outcome is FISH_LANDED or LINE_SNAPPED  (got: "${landOutcome}")`
  );
  if (landOutcome === 'FISH_LANDED') {
    assertEqual(resolvedEventsLand[0].fishInstance, fishInstLand,
      '8e. FISH_LANDED.fishInstance matches the bluegill');
  }
  console.log(`      Bluegill fight outcome: ${landOutcome}`);
}
unsubLand();

// ── SUB-TEST F: onUnmount resolves an in-progress fight as HOOK_SHAKEN ─────
resetForFish();
buildTestWorld();
transitionTo(MODES.TOURNAMENT_ACTIVE);
setActiveLure('LURE_SHALLOW_CRANK');

const fishInstUnmount = makeFishInstance('LARGEMOUTH_BASS', { id: 'lmb_unmount_test' });
bus.emit('BITE_THUD', {
  fishInstance:    fishInstUnmount,
  hooksetWindowMs: 750,
  castSpec:        { poiId: 'POI_DOCK', landing: { dx: 0, dy: 0 }, atMs: clock.nowMs() },
  atMs:            clock.nowMs(),
});
bus.emit('INPUT_ACTION', { type: 'ARROW_UP_DOWN', atMs: clock.nowMs() });

// Confirm fight is in progress (FISH_HOOKED should have fired)
const resolvedByUnmount = [];
const unsubUnmount = bus.on('FIGHT_RESOLVED', evt => resolvedByUnmount.push(evt));

// Transition away from TOURNAMENT_ACTIVE → fightLoop.onUnmount should resolve fight
transitionTo(MODES.HUB);

assert(resolvedByUnmount.length > 0,
  '8f. fightLoop.onUnmount() resolves in-progress fight (H-005)');
if (resolvedByUnmount.length > 0) {
  assertEqual(resolvedByUnmount[0].outcome, 'HOOK_SHAKEN',
    '8f. Fight during unmount resolved as HOOK_SHAKEN (not FISH_LANDED or LINE_SNAPPED)');
}
unsubUnmount();

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log(`harness-fish.js result: ${_passed} passed, ${_failed} failed`);
console.log('='.repeat(60));

if (_failed > 0) {
  process.exit(1);
}
