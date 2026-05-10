/**
 * AFish Integration Test Harness — tests/harness.js
 *
 * Exercises Phase 0 (src/core/*), Phase 1 (src/engine.js, src/profile/profileStore.js),
 * and Phase 2 (src/world/*) contracts in sequence.
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
// SUMMARY
// ===========================================================================
const total = _passed + _failed;
console.log('\n' + '='.repeat(50));
console.log(`HARNESS SUMMARY: ${_passed}/${total} passed, ${_failed} failed`);
console.log('='.repeat(50));

if (_failed > 0) {
  process.exit(1);
}
