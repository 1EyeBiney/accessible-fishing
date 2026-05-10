/**
 * AFish Integration Test Harness — tests/harness.js
 *
 * Exercises Phase 0 (src/core/*), Phase 1 (src/engine.js, src/profile/profileStore.js),
 * Phase 2 (src/world/*), and Phase 3 (src/navigation/*) contracts in sequence.
 *
 * Run with:  node tests/harness.js
 *        or: npm run harness
 *
 * Each section resets shared singleton state (stateStore, clock, modeRouter, worldMap,
 * poiGraph, structureIndex) before running, so sections are independent.
 *
 * Exit code:
 *   0 — all assertions passed
 *   1 — one or more assertions failed
 */

// ---------------------------------------------------------------------------
// Phase 0 — core
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
  _resetManifests,
} from '../src/core/modeRouter.js';

// ---------------------------------------------------------------------------
// Phase 1
// ---------------------------------------------------------------------------
import * as engine       from '../src/engine.js';
import * as profileStore from '../src/profile/profileStore.js';

// ---------------------------------------------------------------------------
// Phase 2 — world
// ---------------------------------------------------------------------------
import * as worldMap       from '../src/world/worldMap.js';
import * as poiGraph       from '../src/world/poiGraph.js';
import * as structureIndex from '../src/world/structureIndex.js';

// ---------------------------------------------------------------------------
// Phase 3 — navigation & equipment
// (importing navigation.js also transitively imports equipment/boats.js which
//  registers the HUB_ACTIVE_BOAT_SET reducer)
// ---------------------------------------------------------------------------
import * as wind       from '../src/navigation/wind.js';
import * as motor      from '../src/navigation/motor.js';
import * as navigation from '../src/navigation/navigation.js';

// ---------------------------------------------------------------------------
// Harness bookkeeping
// ---------------------------------------------------------------------------

let _passed = 0;
let _failed = 0;
let _section = '';

function section(label) {
  _section = label;
  console.log(`\n=== ${label} ===`);
}

/**
 * Assert that `value` is truthy. Logs [PASS] or [FAIL] with a description.
 *
 * @param {boolean} value
 * @param {string}  description
 * @param {*}       [actual]     - printed alongside FAIL for diagnostics
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
 * Assert strict equality.
 *
 * @param {*}      actual
 * @param {*}      expected
 * @param {string} description
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
 * Assert that `fn` throws with a message matching `msgSubstring`.
 *
 * @param {Function} fn
 * @param {string}   msgSubstring
 * @param {string}   description
 */
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

/**
 * Reset all singleton state so each harness section starts clean.
 * Must be called at the top of each section that may be affected by prior sections.
 */
function resetAll() {
  stateStore._reset();
  clock.reset();
  _resetManifests();
  engine._resetBootedFlag();
  profileStore._clearInMemory();
  worldMap._clear();
  poiGraph._clear();
  structureIndex._clear();
  // Phase 3 resets
  wind.invalidateModel();    // clear cached wind session model (depends on rng seed)
  motor._resetWarnings();    // clear MOTOR_FUEL_LOW / MOTOR_BATTERY_LOW sentinels
}

// ===========================================================================
// SECTION 1: Boot & Profile Logic
// ===========================================================================
section('BOOT & PROFILE LOGIC');
resetAll();

// Inject a known profile so boot() does not touch the real filesystem.
const KNOWN_SEED = 0xABCD1234;
const testProfile = {
  id:          'test-profile-001',
  displayName: 'TestAngler',
  settings:    { ttsRate: 1.2, volume: 0.9 },
  globalSeed:  KNOWN_SEED,
  createdAt:   1714000000000,
};
const TEST_PROFILE_PATH = '__harness_test_profile__';
profileStore._seedInMemory(TEST_PROFILE_PATH, testProfile);

// boot() is async — run it and then assert
await engine.boot({ profilePath: TEST_PROFILE_PATH });

// 1a. state.profile is populated with the injected profile
const state = stateStore.getState();
assert(state.profile !== null, '1a. state.profile is not null after boot');
assertEqual(state.profile.id, 'test-profile-001', '1a. state.profile.id matches injected profile');
assertEqual(state.profile.displayName, 'TestAngler', '1a. state.profile.displayName correct');

// 1b. globalSeed was transferred to state.profile
assertEqual(state.profile.globalSeed, KNOWN_SEED, '1b. state.profile.globalSeed matches KNOWN_SEED');

// 1c. Engine transitioned to FOCUS_TRAP after boot
assertEqual(currentMode(), MODES.FOCUS_TRAP, '1c. mode is FOCUS_TRAP after boot');

// 1d. rng.seed() was called — verify by checking rngStream('test').next() produces a
//     deterministic float in [0, 1) for the known seed.
const testStream = rng.rngStream('test');
const firstVal   = testStream.next();
assert(
  typeof firstVal === 'number' && firstVal >= 0 && firstVal < 1,
  `1d. rngStream('test').next() returns float in [0,1)  (got: ${firstVal})`,
);

// Re-seed with the same seed and verify deterministic output.
rng.seed(KNOWN_SEED);
const streamA = rng.rngStream('determinism-check');
const streamB = rng.rngStream('determinism-check');
const a1 = streamA.next();
const b1 = streamB.next();
assertEqual(a1, b1, '1d. Two streams with same name produce equal first values (deterministic)');

// 1e. boot() is idempotent — calling it a second time does not throw or double-seed
let secondBootThrew = false;
try {
  await engine.boot({ profilePath: TEST_PROFILE_PATH });
} catch {
  secondBootThrew = true;
}
assert(!secondBootThrew, '1e. Second boot() call is a no-op (does not throw)');

// ===========================================================================
// SECTION 2: World Construction — D-037 Schema & structureIndex
// ===========================================================================
section('WORLD CONSTRUCTION — D-037 SCHEMA & STRUCTURE INDEX');
resetAll();

// ── 2a. Register tiles conforming to the D-037 schema ──────────────────────

// Tile 1: AMBUSH_POINT with DOCK cover — should score high
const tile1Spec = {
  id:    'T_DOCK_AMBUSH',
  coord: { x: 5, y: 3 },
  traits: {
    depth:  { bottomM: 4.5, minM: 3.5, maxM: 5.5, slopeDeg: 20 },
    bottom: { primary: 'GRAVEL', secondary: 'ROCK', hardness: 0.8 },
    cover:  { type: 'DOCK', density: 0.9, canopyDepthM: 1.0, snagRisk: 0.3, shadeFactor: 0.7 },
    tags:   ['AMBUSH_POINT', 'SHADED_DAY'],
    reach:  { fromDockMin: 0, draftClass: 'DEEP' },
  },
};

// Tile 2: DROP_OFF_EDGE with WEEDBED — should score second-highest
const tile2Spec = {
  id:    'T_DROP_OFF',
  coord: { x: 6, y: 3 },
  traits: {
    depth:  { bottomM: 6.0, minM: 5.0, maxM: 7.0, slopeDeg: 45 },
    bottom: { primary: 'ROCK', secondary: null, hardness: 0.95 },
    cover:  { type: 'WEEDBED', density: 0.5, canopyDepthM: 0.5, snagRisk: 0.4, shadeFactor: 0.2 },
    tags:   ['DROP_OFF_EDGE', 'TRANSITION'],
    reach:  { fromDockMin: 2, draftClass: 'DEEP' },
  },
};

// Tile 3: OPEN_FLAT with no cover — should score lowest
const tile3Spec = {
  id:    'T_OPEN_FLAT',
  coord: { x: 7, y: 3 },
  traits: {
    depth:  { bottomM: 3.0, minM: 2.5, maxM: 3.5, slopeDeg: 2 },
    bottom: { primary: 'SAND', secondary: 'MUD', hardness: 0.2 },
    cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
    tags:   ['OPEN_FLAT'],
    reach:  { fromDockMin: 3, draftClass: 'MEDIUM' },
  },
};

// Tile for a second POI zone (Ambush Cove)
const tile4Spec = {
  id:    'T_AMBUSH_COVE',
  coord: { x: 20, y: 10 },
  traits: {
    depth:  { bottomM: 2.0, minM: 1.5, maxM: 2.5, slopeDeg: 10 },
    bottom: { primary: 'MUD', secondary: null, hardness: 0.1 },
    cover:  { type: 'LILYPADS', density: 0.8, canopyDepthM: 0.2, snagRisk: 0.6, shadeFactor: 0.5 },
    tags:   ['AMBUSH_POINT', 'WEEDBED_INNER'],
    reach:  { fromDockMin: 8, draftClass: 'SHALLOW' },
  },
};

const t1 = worldMap.registerTile(tile1Spec);
const t2 = worldMap.registerTile(tile2Spec);
const t3 = worldMap.registerTile(tile3Spec);
const t4 = worldMap.registerTile(tile4Spec);

assert(t1 !== undefined, '2a. registerTile returns a tile object');
assert(Object.isFrozen(t1.traits),  '2a. tile.traits is frozen post-registration');
assert(!Object.isFrozen(t1.state), '2a. tile.state is NOT frozen (mutable)');
assertEqual(worldMap.tileCount(), 4, '2a. tileCount() is 4 after 4 registrations');

// 2b. D-037 schema validation rejects bad input
assertThrows(
  () => worldMap.registerTile({ id: 'BAD', coord: { x: 0, y: 0 }, traits: {
    depth:  { bottomM: -1, minM: 0, maxM: 1, slopeDeg: 0 }, // negative bottomM
    bottom: { primary: 'SAND', secondary: null, hardness: 0.5 },
    cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
    tags:   [],
    reach:  { fromDockMin: 0, draftClass: 'SHALLOW' },
  }}),
  'non-negative',
  '2b. registerTile throws on negative depth.bottomM',
);

assertThrows(
  () => worldMap.registerTile({ id: 'BAD2', coord: { x: 99, y: 99 }, traits: {
    depth:  { bottomM: 3, minM: 0, maxM: 4, slopeDeg: 5 },
    bottom: { primary: 'LAVA', secondary: null, hardness: 0.5 }, // invalid enum
    cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
    tags:   [],
    reach:  { fromDockMin: 0, draftClass: 'SHALLOW' },
  }}),
  'must be one of',
  '2b. registerTile throws on invalid bottom.primary enum',
);

assertThrows(
  () => worldMap.registerTile({ id: 'BAD3', coord: { x: 88, y: 88 }, traits: {
    depth:  { bottomM: 3, minM: 0, maxM: 4, slopeDeg: 5 },
    bottom: { primary: 'SAND', secondary: null, hardness: 0.5 },
    cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
    tags:   ['INVALID_TAG'],  // unknown tag
    reach:  { fromDockMin: 0, draftClass: 'SHALLOW' },
  }}),
  'unknown tag',
  '2b. registerTile throws on unknown tag in traits.tags',
);

// 2c. Duplicate coord is rejected
assertThrows(
  () => worldMap.registerTile({ ...tile1Spec, id: 'T_DOCK_DUP' }), // same coord as T_DOCK_AMBUSH
  'already exists',
  '2c. registerTile throws on duplicate coord',
);

// 2d. getTile retrieves by coord object and by coordKey string
const byObj = worldMap.getTile({ x: 5, y: 3 });
const byKey = worldMap.getTile('5,3');
assert(byObj !== undefined,       '2d. getTile({x,y}) finds registered tile');
assert(byKey !== undefined,       '2d. getTile("x,y") finds registered tile');
assertEqual(byObj.id, 'T_DOCK_AMBUSH', '2d. getTile returns correct tile by coord object');
assertEqual(byKey.id, 'T_DOCK_AMBUSH', '2d. getTile returns correct tile by coordKey string');
assert(worldMap.getTile({ x: 999, y: 999 }) === undefined, '2d. getTile returns undefined for unregistered coord');

// 2e. mutateTileState — the ONLY permitted mutation path
worldMap.mutateTileState({ x: 5, y: 3 }, (s) => ({
  ...s,
  spook: { ...s.spook, level: 0.8, updatedAtMs: 1000, sourceEventId: 'EVT_001' },
}));
const afterMutate = worldMap.getTile({ x: 5, y: 3 });
assertEqual(afterMutate.state.spook.level, 0.8, '2e. mutateTileState updates spook.level');
assertEqual(afterMutate.state.spook.sourceEventId, 'EVT_001', '2e. mutateTileState updates spook.sourceEventId');
assert(Object.isFrozen(afterMutate.traits), '2e. traits remain frozen after mutateTileState');

// 2f. Register POI zones and verify tilesByPoi
// 'Dock' zone contains tiles 1, 2, 3
worldMap.registerPoiZone('POI_DOCK', ['5,3', '6,3', '7,3']);
// 'Ambush Cove' zone contains tile 4
worldMap.registerPoiZone('POI_AMBUSH_COVE', ['20,10']);

const dockTiles = worldMap.tilesByPoi('POI_DOCK');
assertEqual(dockTiles.length, 3, '2f. tilesByPoi returns 3 tiles for POI_DOCK');
assert(dockTiles.some(t => t.id === 'T_DOCK_AMBUSH'), '2f. POI_DOCK zone includes T_DOCK_AMBUSH');
assert(dockTiles.some(t => t.id === 'T_DROP_OFF'),    '2f. POI_DOCK zone includes T_DROP_OFF');
assert(dockTiles.some(t => t.id === 'T_OPEN_FLAT'),   '2f. POI_DOCK zone includes T_OPEN_FLAT');

const coveTiles = worldMap.tilesByPoi('POI_AMBUSH_COVE');
assertEqual(coveTiles.length, 1, '2f. tilesByPoi returns 1 tile for POI_AMBUSH_COVE');
assertEqual(coveTiles[0].id, 'T_AMBUSH_COVE', '2f. POI_AMBUSH_COVE zone includes correct tile');

assertEqual(worldMap.tilesByPoi('POI_NONEXISTENT').length, 0, '2f. tilesByPoi returns [] for unknown POI');

// 2g. structureIndex.rebuild() — also register POIs in poiGraph so rebuild() can
//     resolve poi.centerCoord for offset computation
poiGraph.registerPoi({
  id:          'POI_DOCK',
  label:       'Main Dock',
  centerCoord: { x: 5, y: 3 },
  frameRadius: 5,
  draftClass:  'DEEP',
});
poiGraph.registerPoi({
  id:          'POI_AMBUSH_COVE',
  label:       'Ambush Cove',
  centerCoord: { x: 20, y: 10 },
  frameRadius: 5,
  draftClass:  'SHALLOW',
});

const { built, skipped } = structureIndex.rebuild();
assertEqual(built, 2,   '2g. rebuild() built both POIs');
assertEqual(skipped, 0, '2g. rebuild() skipped 0 POIs');

assert(structureIndex.isBuilt('POI_DOCK'),         '2g. isBuilt returns true for POI_DOCK after rebuild');
assert(structureIndex.isBuilt('POI_AMBUSH_COVE'),  '2g. isBuilt returns true for POI_AMBUSH_COVE after rebuild');
assert(!structureIndex.isBuilt('POI_NONEXISTENT'), '2g. isBuilt returns false for unknown POI');

// 2h. candidatesForPoi — sorted best-first, correct fields present
const dockCandidates = structureIndex.candidatesForPoi('POI_DOCK');
assertEqual(dockCandidates.length, 3, '2h. candidatesForPoi returns 3 candidates for POI_DOCK');

const best   = dockCandidates[0];
const middle = dockCandidates[1];
const worst  = dockCandidates[2];

assert(best.structureScore >= middle.structureScore,
  '2h. candidates are sorted best-first (best >= middle)');
assert(middle.structureScore >= worst.structureScore,
  '2h. candidates are sorted best-first (middle >= worst)');
assertEqual(best.tileId, 'T_DOCK_AMBUSH',
  '2h. highest scoring tile is AMBUSH_POINT+DOCK (T_DOCK_AMBUSH)');
assertEqual(worst.tileId, 'T_OPEN_FLAT',
  '2h. lowest scoring tile is OPEN_FLAT (T_OPEN_FLAT)');
assert(best.structureScore > 0 && best.structureScore <= 1,
  `2h. best.structureScore is in (0,1]  (got: ${best.structureScore.toFixed(4)})`);

// 2i. Candidate fields — all required fields present and correctly typed
assert(typeof best.tileId  === 'string',  '2i. candidate.tileId is a string');
assert(typeof best.coord   === 'object',  '2i. candidate.coord is an object');
assert(typeof best.offset  === 'object',  '2i. candidate.offset is an object');
assert(typeof best.offset.dx === 'number','2i. candidate.offset.dx is a number');
assert(typeof best.depthM === 'number',   '2i. candidate.depthM is a number');
assert(typeof best.label  === 'string' && best.label.length > 0,
  `2i. candidate.label is a non-empty string  (got: "${best.label}")`);
assert(Array.isArray(best.tags), '2i. candidate.tags is an array');
console.log(`      label for best candidate: "${best.label}"`);

// 2j. Offset computed correctly relative to POI centre (5,3)
// T_DOCK_AMBUSH is at (5,3), POI_DOCK centre is (5,3) → offset should be (0,0)
assertEqual(best.offset.dx, 0, '2j. T_DOCK_AMBUSH offset.dx is 0 (same as POI centre)');
assertEqual(best.offset.dy, 0, '2j. T_DOCK_AMBUSH offset.dy is 0 (same as POI centre)');

// T_DROP_OFF is at (6,3), POI_DOCK centre is (5,3) → offset should be (1,0)
const dropOff = dockCandidates.find(c => c.tileId === 'T_DROP_OFF');
assertEqual(dropOff.offset.dx, 1, '2j. T_DROP_OFF offset.dx is 1');
assertEqual(dropOff.offset.dy, 0, '2j. T_DROP_OFF offset.dy is 0');

// 2k. candidatesForPoi returns shallow copies — augmenting returned objects
//     does NOT pollute the precomputed index
const copy1 = structureIndex.candidatesForPoi('POI_DOCK')[0];
copy1.structureScore = 9999;
copy1.liveAugmented  = true;
const copy2 = structureIndex.candidatesForPoi('POI_DOCK')[0];
assert(copy2.structureScore !== 9999,    '2k. augmenting returned candidate does not pollute index');
assert(copy2.liveAugmented === undefined,'2k. liveAugmented field not present in fresh copy');

// ===========================================================================
// SECTION 3: Graph Topology — poiGraph.js
// ===========================================================================
section('GRAPH TOPOLOGY — poiGraph.js');
resetAll();

// 3a. Register two POIs with different draft classes
poiGraph.registerPoi({
  id:          'POI_DOCK',
  label:       'Main Dock',
  centerCoord: { x: 0, y: 0 },
  frameRadius: 5,
  draftClass:  'DEEP',
});
poiGraph.registerPoi({
  id:          'POI_SHALLOW_CREEK',
  label:       'Shallow Creek',
  centerCoord: { x: 30, y: 10 },
  frameRadius: 3,
  draftClass:  'SHALLOW',
});
poiGraph.registerPoi({
  id:          'POI_CHOP_LEDGE',
  label:       'Chop Ledge',
  centerCoord: { x: 60, y: 0 },
  frameRadius: 4,
  draftClass:  'DEEP',
  description: 'Offshore ledge with exposed water — rowboats unsafe',
});

assertEqual(poiGraph.poiCount(), 3, '3a. poiCount() is 3 after registering 3 POIs');

// 3b. registerPoi rejects invalid specs
assertThrows(
  () => poiGraph.registerPoi({ id: '', label: 'x', centerCoord: { x: 0, y: 0 }, frameRadius: 1, draftClass: 'DEEP' }),
  'non-empty',
  '3b. registerPoi throws on empty id',
);
assertThrows(
  () => poiGraph.registerPoi({ id: 'X', label: 'x', centerCoord: { x: 0, y: 0 }, frameRadius: -1, draftClass: 'DEEP' }),
  'positive',
  '3b. registerPoi throws on negative frameRadius',
);
assertThrows(
  () => poiGraph.registerPoi({ id: 'X', label: 'x', centerCoord: { x: 0, y: 0 }, frameRadius: 1, draftClass: 'CANOE' }),
  'SHALLOW',
  '3b. registerPoi throws on invalid draftClass',
);

// 3c. Register edges between the POIs
// DOCK ↔ SHALLOW_CREEK: shallow channel — accessible to rowboats only (maxDepthM < bass draft)
poiGraph.registerEdge({
  from:              'POI_DOCK',
  to:                'POI_SHALLOW_CREEK',
  distanceTiles:     30,
  minDepthM:         0.4,   // shallow: rowboat (0.3m) passes, bass boat (0.7m) does NOT
  maxDepthM:         0.8,
  minBoatDraftM:     0,     // no stability minimum
  travelTimeMinBase: 8,
});

// DOCK ↔ CHOP_LEDGE: exposed offshore — requires bass boat or bigger (stability constraint)
poiGraph.registerEdge({
  from:              'POI_DOCK',
  to:                'POI_CHOP_LEDGE',
  distanceTiles:     60,
  minDepthM:         1.5,   // deep water — all boats draft-fit
  maxDepthM:         4.0,
  minBoatDraftM:     0.7,   // rowboat (0.3m) blocked by stability constraint
  travelTimeMinBase: 15,
});

assertEqual(poiGraph.edgeCount(), 2, '3c. edgeCount() is 2 after registering 2 edges');

// 3d. registerEdge requires both POIs to be registered first
assertThrows(
  () => poiGraph.registerEdge({
    from: 'POI_DOCK', to: 'POI_GHOST',
    distanceTiles: 10, minDepthM: 1, maxDepthM: 2, travelTimeMinBase: 5,
  }),
  'not registered',
  '3d. registerEdge throws when destination POI is not registered',
);

// 3e. edge() retrieval — bidirectional
const e1 = poiGraph.edge('POI_DOCK', 'POI_SHALLOW_CREEK');
const e2 = poiGraph.edge('POI_SHALLOW_CREEK', 'POI_DOCK');
assert(e1 !== null, '3e. edge() finds DOCK↔SHALLOW_CREEK');
assert(e2 !== null, '3e. edge() bidirectional: SHALLOW_CREEK↔DOCK also found');
assertEqual(e1, e2, '3e. edge(a,b) === edge(b,a) (same object, canonical key)');
assertEqual(e1.minDepthM,    0.4, '3e. edge.minDepthM correct');
assertEqual(e1.minBoatDraftM, 0,  '3e. edge.minBoatDraftM defaults to 0');
assert(poiGraph.edge('POI_DOCK', 'POI_NONEXISTENT') === null, '3e. edge() returns null for unknown pair');

// 3f. neighbors() lists connected POIs and the connecting edge
const dockNeighbors = poiGraph.neighbors('POI_DOCK');
assertEqual(dockNeighbors.length, 2, '3f. POI_DOCK has 2 neighbours');

const creeNeighbour = dockNeighbors.find(n => n.poi.id === 'POI_SHALLOW_CREEK');
assert(creeNeighbour !== undefined, '3f. POI_SHALLOW_CREEK is a neighbour of POI_DOCK');
assert(creeNeighbour.edge !== undefined, '3f. neighbour entry includes the edge object');

const creekOnlyNeighbors = poiGraph.neighbors('POI_SHALLOW_CREEK');
assertEqual(creekOnlyNeighbors.length, 1, '3f. POI_SHALLOW_CREEK has 1 neighbour (only DOCK connects to it)');

// 3g. Draft-based routing — canTraverseEdge() and poisByDraft()
// Rowboat: 0.3m draft
const ROWBOAT_DRAFT     = 0.30;  // DRAFT_CLASS_M.ROWBOAT
const BASS_BOAT_DRAFT   = 0.70;  // DRAFT_CLASS_M.BASS_BOAT
const TOURNAMENT_DRAFT  = 1.20;  // DRAFT_CLASS_M.TOURNAMENT_BOAT

// DOCK ↔ SHALLOW_CREEK: minDepthM=0.4, minBoatDraftM=0
// Rowboat (0.3m): 0.3 <= 0.4 AND 0.3 >= 0 → CAN traverse
// Bass boat (0.7m): 0.7 <= 0.4? NO → CANNOT traverse (too deep for the channel)
assert(
  poiGraph.canTraverseEdge('POI_DOCK', 'POI_SHALLOW_CREEK', ROWBOAT_DRAFT),
  '3g. Rowboat (0.3m) CAN traverse shallow creek edge (minDepthM=0.4)',
);
assert(
  !poiGraph.canTraverseEdge('POI_DOCK', 'POI_SHALLOW_CREEK', BASS_BOAT_DRAFT),
  '3g. Bass boat (0.7m) CANNOT traverse shallow creek edge (minDepthM=0.4, bass too large)',
);

// DOCK ↔ CHOP_LEDGE: minDepthM=1.5, minBoatDraftM=0.7
// Rowboat (0.3m): 0.3 <= 1.5 BUT 0.3 >= 0.7? NO → CANNOT traverse (stability)
// Bass boat (0.7m): 0.7 <= 1.5 AND 0.7 >= 0.7 → CAN traverse
// Tournament boat (1.2m): 1.2 <= 1.5 AND 1.2 >= 0.7 → CAN traverse
assert(
  !poiGraph.canTraverseEdge('POI_DOCK', 'POI_CHOP_LEDGE', ROWBOAT_DRAFT),
  '3g. Rowboat (0.3m) CANNOT traverse chop ledge edge (minBoatDraftM=0.7, stability blocked)',
);
assert(
  poiGraph.canTraverseEdge('POI_DOCK', 'POI_CHOP_LEDGE', BASS_BOAT_DRAFT),
  '3g. Bass boat (0.7m) CAN traverse chop ledge edge',
);
assert(
  poiGraph.canTraverseEdge('POI_DOCK', 'POI_CHOP_LEDGE', TOURNAMENT_DRAFT),
  '3g. Tournament boat (1.2m) CAN traverse chop ledge edge',
);

// 3h. poisByDraft() — fleet-level accessibility filter
// ROWBOAT: only SHALLOW-class POIs are accessible (POI_SHALLOW_CREEK)
// (POI_DOCK is DEEP: POI_DRAFT_DEPTH_M.DEEP=2.0 >= 0.3 → accessible?
//  Actually POI_DOCK is DEEP — its water is 2.0m deep, rowboat needs only 0.3m → it can access it)
// Let me re-read the logic: boatDraftM <= POI_DRAFT_DEPTH_M[poi.draftClass]
//   ROWBOAT (0.3m) → 0.3 <= DEEP(2.0) = true; 0.3 <= SHALLOW(0.5) = true
//   All POIs accessible to rowboat — rowboat is the smallest boat.
const rowboatPois = poiGraph.poisByDraft('ROWBOAT');
assert(
  rowboatPois.some(p => p.id === 'POI_SHALLOW_CREEK'),
  '3h. poisByDraft(ROWBOAT) includes POI_SHALLOW_CREEK (SHALLOW draftClass)',
);
assert(
  rowboatPois.some(p => p.id === 'POI_DOCK'),
  '3h. poisByDraft(ROWBOAT) includes POI_DOCK (DEEP water deep enough for tiny rowboat)',
);
assertEqual(rowboatPois.length, 3, '3h. poisByDraft(ROWBOAT) returns all 3 POIs (rowboat fits everywhere)');

// TOURNAMENT_BOAT: only DEEP POIs accessible (TOURNAMENT_BOAT draft 1.2m)
//   SHALLOW water depth = 0.5m: 1.2 <= 0.5? NO → cannot access SHALLOW POIs
//   DEEP water depth = 2.0m: 1.2 <= 2.0? YES
const tournamentPois = poiGraph.poisByDraft('TOURNAMENT_BOAT');
assert(
  !tournamentPois.some(p => p.id === 'POI_SHALLOW_CREEK'),
  '3h. poisByDraft(TOURNAMENT_BOAT) excludes POI_SHALLOW_CREEK (water too shallow for 1.2m draft)',
);
assert(
  tournamentPois.some(p => p.id === 'POI_DOCK'),
  '3h. poisByDraft(TOURNAMENT_BOAT) includes POI_DOCK (DEEP water, 2.0m)',
);

// 3i. getPoi and allPois
const dockNode = poiGraph.getPoi('POI_DOCK');
assert(dockNode !== undefined, '3i. getPoi returns registered POI');
assertEqual(dockNode.label, 'Main Dock', '3i. getPoi returns correct label');
assert(Object.isFrozen(dockNode), '3i. POI nodes are frozen');

assertEqual(poiGraph.allPois().length, 3, '3i. allPois() returns all 3 POIs');

// 3j. Invalid poisByDraft throws
assertThrows(
  () => poiGraph.poisByDraft('CANOE'),
  'unknown draftClass',
  '3j. poisByDraft throws on unknown draft class',
);

// ===========================================================================
// SECTION 4: H-005 Leak Test
// ===========================================================================
section('H-005 LEAK TEST');
resetAll();

// Re-boot for the leak test so stateStore has a profile and engine is in a valid
// post-boot state. assertNoLeaks() requires that the engine has been booted.
const LEAK_SEED = 0x1A2B3C4D;
profileStore._seedInMemory(TEST_PROFILE_PATH, { ...testProfile, globalSeed: LEAK_SEED });
await engine.boot({ profilePath: TEST_PROFILE_PATH });

const leakResult = engine.assertNoLeaks();

console.log(`\nH-005 result:\n  passed:         ${leakResult.passed}`);
console.log(`  listenerLeaks:  ${leakResult.listenerLeaks}`);
console.log(`  clockLeaks:     ${leakResult.clockLeaks}`);
console.log(`  details:        ${leakResult.details}`);

assert(leakResult.passed,
  '4a. H-005 assertNoLeaks() passes: no stray listeners or clock handles after round-trip');
assertEqual(leakResult.listenerLeaks, 0,
  '4b. H-005 listenerLeaks === 0');
assertEqual(leakResult.clockLeaks, 0,
  '4c. H-005 clockLeaks === 0');

// ===========================================================================
// SECTION 5: Wind & Motor Mechanics
// ===========================================================================
section('WIND & MOTOR MECHANICS');
resetAll();
rng.seed(KNOWN_SEED);

// ── 5a. wind.sample() schema ────────────────────────────────────────────────
const w1 = wind.sample(5_000);

assert(typeof w1.directionDeg === 'number',
  '5a. wind.sample() returns numeric directionDeg');
assert(w1.directionDeg >= 0 && w1.directionDeg < 360,
  `5a. directionDeg is in [0, 360)  (got: ${w1.directionDeg.toFixed(2)})`);
assert(typeof w1.intensityMs === 'number' && w1.intensityMs >= 0 && w1.intensityMs <= wind.MAX_WIND_INTENSITY_MS,
  `5a. intensityMs is in [0, MAX_WIND_INTENSITY_MS]  (got: ${w1.intensityMs})`);
assert(typeof w1.dx === 'number' && Math.abs(w1.dx) <= 1,
  `5a. dx is a number in [-1, 1]  (got: ${w1.dx})`);
assert(typeof w1.dy === 'number' && Math.abs(w1.dy) <= 1,
  `5a. dy is a number in [-1, 1]  (got: ${w1.dy})`);
assert(w1.gustLevel >= 0 && w1.gustLevel <= 1,
  `5a. gustLevel is in [0, 1]  (got: ${w1.gustLevel})`);
assertEqual(w1.atMs, 5_000, '5a. atMs is echoed through in the return value');

// Sanity-check that (dx, dy) is a proper unit vector (or zero vector when calm)
const unitLen = Math.hypot(w1.dx, w1.dy);
assert(
  w1.intensityMs < 0.001 || (unitLen > 0.99 && unitLen <= 1.01),
  `5a. (dx, dy) is a unit vector when wind is non-zero  (hypot=${unitLen.toFixed(6)})`,
);
console.log(`      wind at t=5000: dir=${w1.directionDeg}° ` +
            `int=${w1.intensityMs} m/s gust=${w1.gustLevel}`);

// ── 5b. wind.sample() is deterministic for the same timestamp ───────────────
const w2 = wind.sample(5_000);
assertEqual(w1.directionDeg, w2.directionDeg,
  '5b. wind.sample(5000) directionDeg is identical on second call');
assertEqual(w1.intensityMs, w2.intensityMs,
  '5b. wind.sample(5000) intensityMs is identical on second call');
assertEqual(w1.gustLevel, w2.gustLevel,
  '5b. wind.sample(5000) gustLevel is identical on second call');

// ── 5c. Different timestamps produce different wind vectors ─────────────────
// Use a gap of half the CHOP period (15 000 ms) — the fastest sinusoidal layer
// has period 30 000 ms, so at t=5000 and t=20000 we are at very different phase.
const w3 = wind.sample(20_000);
assert(
  w3.directionDeg !== w1.directionDeg || w3.intensityMs !== w1.intensityMs,
  '5c. wind.sample(20000) differs from wind.sample(5000) (time-varying)',
);
console.log(`      wind at t=20000: dir=${w3.directionDeg}° int=${w3.intensityMs} m/s`);

// ── 5d. Different RNG seed → different session wind fingerprint ─────────────
rng.seed(KNOWN_SEED + 1);
wind.invalidateModel();          // force model rebuild with new seed
const w4 = wind.sample(5_000);
assert(
  w4.directionDeg !== w1.directionDeg || w4.intensityMs !== w1.intensityMs,
  '5d. Different RNG seed produces different wind vector at the same timestamp',
);
console.log(`      wind(seed+1)@5000: dir=${w4.directionDeg}° int=${w4.intensityMs} m/s`);

// Restore canonical seed for the motor tests below
rng.seed(KNOWN_SEED);
wind.invalidateModel();

// ── 5e. motor.initialise() populates state.tournament.motor ─────────────────
motor.initialise({ fuelCapacityL: 20, fuelPerTile: 0.5 });
const motorState = stateStore.getState().tournament.motor;
assert(motorState !== undefined,
  '5e. motor.initialise() creates state.tournament.motor partition');
assertEqual(motorState.fuelLitres, 20,
  '5e. fuelLitres is fuelCapacityL (starts full)');
assertEqual(motorState.fuelCapacity, 20,
  '5e. fuelCapacity recorded correctly');

// ── 5f. fuelRemaining() and batteryRemaining() read from stateStore ──────────
assertEqual(motor.fuelRemaining(), 20,
  '5f. motor.fuelRemaining() returns 20 after initialise(20L)');
assertEqual(motor.batteryRemaining(), 100,
  '5f. motor.batteryRemaining() returns 100 after initialise');

// ── 5g. consume(distance, OUTBOARD) correctly reduces fuel ──────────────────
// 4 tiles × 0.5 L/tile = 2 L consumed; 20 - 2 = 18 L remaining
const consumeResult = motor.consume(4, 'OUTBOARD', 0);
assertEqual(consumeResult.actualDistance, 4,
  '5g. consume() actualDistance equals requested distance when fuel is sufficient');
assert(!consumeResult.outOfFuel,
  '5g. consume() outOfFuel is false when fuel is sufficient');
assertEqual(consumeResult.fuelUsed, 2,
  '5g. consume() fuelUsed is distance × fuelPerTile (4 × 0.5 = 2)');
assertEqual(consumeResult.batteryUsed, 0,
  '5g. consume(OUTBOARD) batteryUsed is 0');

// ── 5h. fuelRemaining() reflects consumption ────────────────────────────────
assertEqual(motor.fuelRemaining(), 18,
  '5h. fuelRemaining() is 18 after consuming 2L');

// ── 5i. fuelFraction() returns normalised level ─────────────────────────────
const frac = motor.fuelFraction();
assert(Math.abs(frac - 0.9) < 0.0001,
  `5i. fuelFraction() is 0.9 after consuming 2/20 L  (got: ${frac})`);

// ── 5j. consume(distance, TROLLING) drains battery ─────────────────────────
// 10 tiles × 0.5 %/tile = 5 % drained; 100 - 5 = 95 %
const trollResult = motor.consume(10, 'TROLLING', 0);
assertEqual(trollResult.batteryUsed, 5,
  '5j. consume(TROLLING) batteryUsed is distance × batteryDrainPct (10 × 0.5 = 5)');
assert(!trollResult.outOfBattery,
  '5j. consume(TROLLING) outOfBattery is false when charge is sufficient');
assertEqual(trollResult.fuelUsed, 0,
  '5j. consume(TROLLING) fuelUsed is 0');

// ── 5k. batteryRemaining() reflects trolling drain ──────────────────────────
assertEqual(motor.batteryRemaining(), 95,
  '5k. batteryRemaining() is 95 after draining 5%');

// ── 5l. Out-of-fuel: outOfFuel=true, actualDistance reflects partial travel ─
// fuelRemaining = 18 L; request 100 tiles × 0.5 = 50 L needed
const drainResult = motor.consume(100, 'OUTBOARD', 0);
assert(drainResult.outOfFuel,
  '5l. consume(100 tiles) outOfFuel is true when only 18L remain (50L needed)');
assert(drainResult.actualDistance < 100,
  `5l. actualDistance < requested distance when fuel runs out  (got: ${drainResult.actualDistance})`);
// actualDistance = 18L / 0.5 L/tile = 36 tiles
assert(Math.abs(drainResult.actualDistance - 36) < 0.01,
  `5l. actualDistance is 36 tiles (18L ÷ 0.5 L/tile)  (got: ${drainResult.actualDistance})`);

// ── 5m. fuelRemaining() is 0 after draining the tank ───────────────────────
assertEqual(motor.fuelRemaining(), 0,
  '5m. fuelRemaining() is 0 after the tank is exhausted');
assert(!motor.canUseOutboard(1),
  '5m. canUseOutboard(1) returns false when fuel is 0');

// ── 5n. MOTOR_FUEL_LOW event fires when fuel crosses the 20% threshold ──────
// Reinitialise with a fresh 10 L tank (threshold = 2 L)
motor.initialise({ fuelCapacityL: 10, fuelPerTile: 1.0 });
let fuelLowFired = false;
const unsubFuelLow = bus.on('MOTOR_FUEL_LOW', () => { fuelLowFired = true; });
// Consume 9 tiles × 1 L/tile = 9 L → 1 L remaining = 10% < 20% threshold
motor.consume(9, 'OUTBOARD', 0);
unsubFuelLow();
assert(fuelLowFired,
  '5n. MOTOR_FUEL_LOW bus event fires when fuel level falls below 20% of capacity');

// ===========================================================================
// SECTION 6: Navigation Physics & Penalties
// ===========================================================================
section('NAVIGATION PHYSICS & PENALTIES');
resetAll();
rng.seed(KNOWN_SEED);

// ── World setup for Section 6 ───────────────────────────────────────────────
// Three POIs: HOME (deep, large frame), SPOT (deep, for travel target),
//             SHALLOW_POOL (shallow, for D-007 override test)
// Tiles are registered at each POI's centerCoord so _currentTile() resolves correctly.

const HOME_POI_ID    = 'POI_HOME';
const SPOT_POI_ID    = 'POI_SPOT';
const SHALLOW_POI_ID = 'POI_SHALLOW_POOL';

// Tile at HOME center (0, 0) — deep water, safe for all boats
worldMap.registerTile({
  id:    'T_HOME_CENTER',
  coord: { x: 0, y: 0 },
  traits: {
    depth:  { bottomM: 5.0, minM: 3.5, maxM: 6.0, slopeDeg: 5 },
    bottom: { primary: 'GRAVEL', secondary: 'ROCK', hardness: 0.8 },
    cover:  { type: 'NONE', density: 0, canopyDepthM: 0, snagRisk: 0, shadeFactor: 0 },
    tags:   ['OPEN_FLAT'],
    reach:  { fromDockMin: 0, draftClass: 'DEEP' },
  },
});

// Tile at SPOT center (10, 0) — deep water
worldMap.registerTile({
  id:    'T_SPOT_CENTER',
  coord: { x: 10, y: 0 },
  traits: {
    depth:  { bottomM: 4.0, minM: 3.0, maxM: 5.0, slopeDeg: 3 },
    bottom: { primary: 'SAND', secondary: null, hardness: 0.3 },
    cover:  { type: 'WEEDBED', density: 0.4, canopyDepthM: 0.5, snagRisk: 0.2, shadeFactor: 0.1 },
    tags:   ['WEEDBED_EDGE'],
    reach:  { fromDockMin: 5, draftClass: 'DEEP' },
  },
});

// Tile at SHALLOW_POOL center (20, 0) — very shallow: minM=0.35
// Bass boat shallowDraftMin=0.70 → 0.35 < 0.70 → D-007 fires
worldMap.registerTile({
  id:    'T_SHALLOW_CENTER',
  coord: { x: 20, y: 0 },
  traits: {
    depth:  { bottomM: 0.50, minM: 0.35, maxM: 0.70, slopeDeg: 2 },
    bottom: { primary: 'MUD', secondary: null, hardness: 0.1 },
    cover:  { type: 'LILYPADS', density: 0.7, canopyDepthM: 0.2, snagRisk: 0.5, shadeFactor: 0.4 },
    tags:   ['WEEDBED_INNER'],
    reach:  { fromDockMin: 12, draftClass: 'SHALLOW' },
  },
});

worldMap.registerPoiZone(HOME_POI_ID,    ['0,0']);
worldMap.registerPoiZone(SPOT_POI_ID,    ['10,0']);
worldMap.registerPoiZone(SHALLOW_POI_ID, ['20,0']);

// POIs — frameRadius=30 gives plenty of room for the driftStep test
poiGraph.registerPoi({
  id:          HOME_POI_ID,
  label:       'Home Dock',
  centerCoord: { x: 0, y: 0 },
  frameRadius: 30,
  draftClass:  'DEEP',
});
poiGraph.registerPoi({
  id:          SPOT_POI_ID,
  label:       'Fishing Spot',
  centerCoord: { x: 10, y: 0 },
  frameRadius: 30,
  draftClass:  'DEEP',
});
poiGraph.registerPoi({
  id:          SHALLOW_POI_ID,
  label:       'Shallow Pool',
  centerCoord: { x: 20, y: 0 },
  frameRadius: 10,
  draftClass:  'SHALLOW',
});

// Edges
// HOME ↔ SPOT: 10 tiles, 5 min base time, minDepthM=0.5 — traversable by all boats
poiGraph.registerEdge({
  from:              HOME_POI_ID,
  to:                SPOT_POI_ID,
  distanceTiles:     10,
  minDepthM:         0.5,
  maxDepthM:         4.0,
  minBoatDraftM:     0,
  travelTimeMinBase: 5,
});
// HOME ↔ SHALLOW_POOL: exists so requestTravel can attempt the route (D-007 fires before edge check)
poiGraph.registerEdge({
  from:              HOME_POI_ID,
  to:                SHALLOW_POI_ID,
  distanceTiles:     20,
  minDepthM:         0.5,
  maxDepthM:         1.0,
  minBoatDraftM:     0,
  travelTimeMinBase: 10,
});

// Motor initialised with 100 L / 0.5 L per tile — plenty for the travel tests
motor.initialise({ fuelCapacityL: 100, fuelPerTile: 0.5 });

// ── 6a. placeAt() sets position in stateStore ────────────────────────────────
navigation.placeAt(HOME_POI_ID);

assertEqual(navigation.currentPoiId(), HOME_POI_ID,
  '6a. placeAt() sets currentPoiId to the target POI');
const initOffset = navigation.currentOffset();
assertEqual(initOffset.dx, 0,
  '6a. placeAt() initialises microOffset.dx to 0');
assertEqual(initOffset.dy, 0,
  '6a. placeAt() initialises microOffset.dy to 0');
assert(!navigation.isTravelling(),
  '6a. isTravelling() is false after placeAt');

// ── 6b. driftStep() moves the boat according to the H-001 wind pipeline ─────
// clock.nowMs() = 0 after resetAll; wind.sample(0) gives us the push vector.
// No POI current (no flow field), no station keeping → pure wind drift.
// navigation.js applies: velDx = -w.dx * w.intensityMs * WIND_DRIFT_SCALE * windPenalty
// Fallback windPenalty = 0.20 (hub.activeBoat is null → fallback stat block used)
const windAtZero = wind.sample(clock.nowMs()); // clock at 0
const WIND_DRIFT_SCALE_K   = 0.25;             // must match navigation.js constant
const FALLBACK_WIND_PENALTY = 0.20;            // must match navigation.js fallback

const velDx = -windAtZero.dx * windAtZero.intensityMs * WIND_DRIFT_SCALE_K * FALLBACK_WIND_PENALTY;
const velDy = -windAtZero.dy * windAtZero.intensityMs * WIND_DRIFT_SCALE_K * FALLBACK_WIND_PENALTY;
const DT = 60; // in-game seconds — large enough to produce measurable displacement
const expectedDx = velDx * DT;
const expectedDy = velDy * DT;

navigation.driftStep(DT);
const afterDrift = navigation.currentOffset();

assert(
  Math.abs(afterDrift.dx - expectedDx) < 0.0002,
  `6b. driftStep offset.dx matches H-001 wind-only pipeline ` +
  `(expected≈${expectedDx.toFixed(5)}, got=${afterDrift.dx.toFixed(5)})`,
);
assert(
  Math.abs(afterDrift.dy - expectedDy) < 0.0002,
  `6b. driftStep offset.dy matches H-001 wind-only pipeline ` +
  `(expected≈${expectedDy.toFixed(5)}, got=${afterDrift.dy.toFixed(5)})`,
);
// Conditional: if wind is non-trivial, offset must have actually moved
assert(
  windAtZero.intensityMs < 0.001 || Math.hypot(afterDrift.dx, afterDrift.dy) > 0.0001,
  `6b. microOffset changed from zero after driftStep (intensityMs=${windAtZero.intensityMs})`,
);
console.log(`      drift after 60s: dx=${afterDrift.dx.toFixed(5)}, dy=${afterDrift.dy.toFixed(5)}`);

// ── 6c. station('OARS') sets anchored=true in stateStore ────────────────────
navigation.station('OARS');
assertEqual(stateStore.getState().session.player.anchored, true,
  '6c. station(OARS) sets state.session.player.anchored to true');

// ── 6d. station() rejects invalid mode ──────────────────────────────────────
assertThrows(
  () => navigation.station('ANCHOR'),
  'must be OARS',
  '6d. station() throws TypeError on invalid mode',
);

// ── 6e. D-040: nudge() beyond frameRadius triggers 300 000 ms clock penalty ─
// Reset boat to center; disable station keeping so offset math is clean
navigation.placeAt(HOME_POI_ID);
navigation.station('NONE');
const poi        = poiGraph.getPoi(HOME_POI_ID); // frameRadius = 30
const timeBefore = clock.nowMs();
// Nudge 40 tiles east — well beyond frameRadius=30
navigation.nudge(1, 0, poi.frameRadius + 10);    // rawOffset = {dx:40, dy:0}
const timeAfter  = clock.nowMs();

assertEqual(
  timeAfter - timeBefore,
  300_000,
  '6e. D-040: clock advances by exactly 300 000 ms after frame-boundary violation',
);

// ── 6f. After D-040 penalty, offset is snapped back inside frameRadius ───────
const penaltyOffset = navigation.currentOffset();
const penaltyMag    = Math.hypot(penaltyOffset.dx, penaltyOffset.dy);

assert(
  penaltyMag < poi.frameRadius,
  `6f. D-040: snapped offset is within frameRadius  (mag=${penaltyMag.toFixed(4)}, r=${poi.frameRadius})`,
);
assert(
  penaltyMag > 0,
  `6f. D-040: snapped offset is non-zero (snapped to 50% of frameRadius, not origin)  (mag=${penaltyMag.toFixed(4)})`,
);
// rawOffset was {40, 0} → snapped scale = (30 * 0.5) / 40 = 15/40 → snapped.dx ≈ 15
assert(
  Math.abs(penaltyOffset.dx - 15) < 0.001,
  `6f. D-040: snapped dx is 15 (= frameRadius * 0.5 = 30 * 0.5)  (got: ${penaltyOffset.dx.toFixed(4)})`,
);
console.log(`      penalty offset: dx=${penaltyOffset.dx.toFixed(4)}, dy=${penaltyOffset.dy.toFixed(4)}`);

// ── 6g. requestTravel() succeeds for a valid well-fuelled route ──────────────
// Place boat back at HOME (clean offset); clock is at 300 000 after D-040 penalty
navigation.placeAt(HOME_POI_ID);
const travelTimeBefore = clock.nowMs();              // 300 000 ms (from D-040 above)
const edge = poiGraph.edge(HOME_POI_ID, SPOT_POI_ID);
// speedFactor = fallback(4.0) / reference(4.0) = 1.0 → travelTimeMs = 5 * 60 000 = 300 000
const expectedTravelMs = Math.round(edge.travelTimeMinBase * 60_000 / 1.0);

const travelResult = navigation.requestTravel(SPOT_POI_ID);

assert(travelResult.success,
  '6g. requestTravel() returns { success: true } for a valid route');
assertEqual(travelResult.reason, null,
  '6g. requestTravel() reason is null on success');
assertEqual(navigation.currentPoiId(), SPOT_POI_ID,
  '6g. currentPoiId() updated to destination POI after travel');
const arrivalOffset = navigation.currentOffset();
assertEqual(arrivalOffset.dx, 0,
  '6g. microOffset.dx is 0 on arrival (boat docked at POI centre)');
assertEqual(arrivalOffset.dy, 0,
  '6g. microOffset.dy is 0 on arrival (boat docked at POI centre)');
assert(!navigation.isTravelling(),
  '6g. isTravelling() is false after arrival');

// ── 6h. requestTravel() advances the tournament clock by travelTimeMs ────────
const travelTimeElapsed = clock.nowMs() - travelTimeBefore;
assertEqual(
  travelTimeElapsed,
  expectedTravelMs,
  `6h. clock advanced by exactly travelTimeMs (${expectedTravelMs} ms) during requestTravel`,
);
console.log(`      travel: ${edge.distanceTiles} tiles in ${expectedTravelMs / 60_000} in-game min`);

// ── 6i. requestTravel() consumes fuel from the outboard motor ────────────────
// 10 tiles × 0.5 L/tile = 5 L consumed; 100 - 5 = 95 L remaining
const fuelAfterTravel = motor.fuelRemaining();
const fuelExpected    = 100 - edge.distanceTiles * 0.5;
assert(
  Math.abs(fuelAfterTravel - fuelExpected) < 0.001,
  `6i. fuel reduced by distanceTiles × fuelPerTile (expected ${fuelExpected}L, got ${fuelAfterTravel}L)`,
);

// ── 6j. D-007 Shallow Water Override blocks Bass Boat at shallow tile ─────────
// Set hub.activeBoat = BASS_BOAT (shallowDraftMin = 0.70)
// The tile at SHALLOW_POOL center has minM = 0.35 → 0.35 < 0.70 → D-007 fires
stateStore.dispatch({ type: 'HUB_ACTIVE_BOAT_SET', payload: { boatId: 'BASS_BOAT' } });
navigation.placeAt(SHALLOW_POI_ID);   // bass boat is now at the shallow tile

// Any outbound travel attempt from here should be D-007 blocked
const shallowResult = navigation.requestTravel(HOME_POI_ID);

assert(!shallowResult.success,
  '6j. D-007: requestTravel() returns { success: false } when current tile is below shallowDraftMin');
assertEqual(shallowResult.reason, 'SHALLOW_OVERRIDE',
  '6j. D-007: reason is SHALLOW_OVERRIDE (bass boat 0.70m draft, tile minM=0.35m)');

// ===========================================================================
// SUMMARY
// ===========================================================================
const total = _passed + _failed;
console.log('\n' + '='.repeat(50));
console.log(`HARNESS SUMMARY: ${_passed}/${total} passed, ${_failed} failed`);
console.log('='.repeat(50));

if (_failed > 0) {
  process.exit(1);
}
