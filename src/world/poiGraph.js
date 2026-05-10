/**
 * AFish POI Graph — src/world/poiGraph.js
 *
 * Public API Contract: neighbors(poiId) / edge(a,b) / poisByDraft(draftClass)
 *
 * Defines the navigable topology of the lake: which POIs (Points of Interest)
 * exist and which edges connect them. Consumed by:
 *   - navigation.js  (travel time, route validation, shallow override — D-007)
 *   - hubMenu.js     (destination menus — D-001)
 *   - structureIndex (POI center coords for offset computation — H-002)
 *   - fishFinder     (draft-filtered destination list — D-042)
 *   - aiBots.js      (POI selection bias — D-059)
 *
 * Pure graph topology — NO fish state, spook, or pressure data lives here (H-014).
 *
 * POI Node schema:
 *   { id, label, centerCoord: {x,y}, frameRadius, draftClass, description }
 *   - draftClass: the MINIMUM water depth class at this POI. Boats whose draft
 *     exceeds the POI's water depth are blocked from this POI (see poisByDraft).
 *     'SHALLOW' = very shallow POI (rowboat-only);
 *     'MEDIUM'  = medium-depth POI (rowboat + bass boat);
 *     'DEEP'    = deep POI (all boats).
 *
 * Edge schema (D-022):
 *   { from, to, distanceTiles, minDepthM, maxDepthM, minBoatDraftM, travelTimeMinBase }
 *   - minDepthM:      minimum water depth along the route corridor (meters).
 *                     A boat with draft > minDepthM cannot traverse this edge.
 *   - maxDepthM:      maximum water depth (for fish-context info, not routing).
 *   - minBoatDraftM:  minimum REQUIRED boat draft in meters (chop/stability routes).
 *                     Rowboats are excluded from edges where their draft < minBoatDraftM.
 *                     This captures "bass boats reach distant/chop POIs that rowboats cannot."
 *   - travelTimeMinBase: travel time in in-game minutes at full-speed reference;
 *                        navigation.js applies the active boat's speedTilesPerMin
 *                        and motor cost model on top.
 *
 * Draft routing rules (D-022):
 *   A boat CAN traverse an edge when:
 *     boat.shallowDraftM <= edge.minDepthM     (water is deep enough for the boat)
 *     AND
 *     boat.shallowDraftM >= edge.minBoatDraftM (boat is stable enough for the route)
 *   This creates the two-sided filtering from the brief:
 *     - Rowboats (small draft) reach shallow POIs (low minDepthM) that bass boats ground on.
 *     - Bass boats (larger draft) reach chop routes (high minBoatDraftM) that rowboats can't handle.
 *
 * Draft class convenience (poisByDraft):
 *   Maps named draft classes to draft meters for quick fleet-level route filtering.
 *   See DRAFT_CLASS_M below.
 */

// ---------------------------------------------------------------------------
// Draft class definitions
// ---------------------------------------------------------------------------

/**
 * Named draft classes and their approximate boat draft in metres.
 * These values are used by poisByDraft() and navigation.js to filter edges.
 * The actual per-boat shallowDraftMin lives in equipment/boats.js stat blocks;
 * these constants are the canonical class-to-metre lookup used by the graph.
 *
 * @readonly
 */
export const DRAFT_CLASS_M = Object.freeze({
  ROWBOAT:          0.30,
  BASS_BOAT:        0.70,
  TOURNAMENT_BOAT:  1.20,
});

/**
 * Ordered list of draft class names from smallest to largest draft (shallowest to deepest).
 * @readonly
 */
export const DRAFT_CLASS_ORDER = Object.freeze(
  Object.keys(DRAFT_CLASS_M)
);

/**
 * POI draft water depth classes and their approximate minimum water depths.
 * A POI is only reachable by a boat whose draft <= the POI's water depth.
 * @readonly
 */
export const POI_DRAFT_DEPTH_M = Object.freeze({
  SHALLOW: 0.50,   // Very shallow near-shore POIs; rowboats only
  MEDIUM:  1.00,   // Medium depth; rowboats and bass boats
  DEEP:    2.00,   // Deep water; all boats
});

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} poiId → PoiNode */
const _nodes = new Map();

/** @type {Map<string, object>} edgeKey → Edge (keyed by canonical sorted pair) */
const _edges = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a canonical, bidirectional edge key for a pair of POI ids.
 * Edges are undirected: edge('DOCK','COVE') === edge('COVE','DOCK').
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function _edgeKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

// ---------------------------------------------------------------------------
// Public API — registration (called by lake generator)
// ---------------------------------------------------------------------------

/**
 * Register a POI node in the graph.
 * Replaces any existing node with the same id (allows lake generator to re-register
 * POIs as their state is refined during generation).
 *
 * @param {object} nodeSpec
 * @param {string} nodeSpec.id            - unique POI identifier, e.g. 'POI_DOCK'
 * @param {string} nodeSpec.label         - short display name for TTS, e.g. 'Main Dock'
 * @param {{ x: number, y: number }} nodeSpec.centerCoord  - global grid coordinate of POI centre
 * @param {number} nodeSpec.frameRadius   - radius in grid tiles of this POI's fishable frame
 * @param {'SHALLOW'|'MEDIUM'|'DEEP'} nodeSpec.draftClass  - water depth class at this POI
 * @param {string} [nodeSpec.description] - longer description for TTS context (optional)
 * @returns {object} the registered node
 * @throws {TypeError}  on validation failure
 */
export function registerPoi(nodeSpec) {
  if (!nodeSpec || typeof nodeSpec !== 'object') {
    throw new TypeError('poiGraph.registerPoi: nodeSpec must be an object');
  }
  if (typeof nodeSpec.id !== 'string' || nodeSpec.id.length === 0) {
    throw new TypeError('poiGraph.registerPoi: nodeSpec.id must be a non-empty string');
  }
  if (typeof nodeSpec.label !== 'string' || nodeSpec.label.length === 0) {
    throw new TypeError(`poiGraph.registerPoi [${nodeSpec.id}]: label must be a non-empty string`);
  }
  const cc = nodeSpec.centerCoord;
  if (!cc || typeof cc.x !== 'number' || typeof cc.y !== 'number') {
    throw new TypeError(
      `poiGraph.registerPoi [${nodeSpec.id}]: centerCoord must be {x: number, y: number}`
    );
  }
  if (typeof nodeSpec.frameRadius !== 'number' || nodeSpec.frameRadius <= 0) {
    throw new TypeError(
      `poiGraph.registerPoi [${nodeSpec.id}]: frameRadius must be a positive number`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(POI_DRAFT_DEPTH_M, nodeSpec.draftClass)) {
    throw new TypeError(
      `poiGraph.registerPoi [${nodeSpec.id}]: draftClass must be one of: ${Object.keys(POI_DRAFT_DEPTH_M).join(', ')}`
    );
  }

  const node = Object.freeze({
    id:          nodeSpec.id,
    label:       nodeSpec.label,
    centerCoord: Object.freeze({ x: cc.x, y: cc.y }),
    frameRadius: nodeSpec.frameRadius,
    draftClass:  nodeSpec.draftClass,
    description: nodeSpec.description ?? '',
  });

  _nodes.set(nodeSpec.id, node);
  return node;
}

/**
 * Register an undirected edge between two POIs.
 * Replaces any existing edge between the same pair.
 * Both POIs MUST be registered before the edge is registered.
 *
 * @param {object} edgeSpec
 * @param {string} edgeSpec.from              - source POI id
 * @param {string} edgeSpec.to                - destination POI id
 * @param {number} edgeSpec.distanceTiles     - Euclidean distance in grid tiles
 * @param {number} edgeSpec.minDepthM         - minimum water depth on this route (meters)
 * @param {number} edgeSpec.maxDepthM         - maximum water depth on this route (meters)
 * @param {number} [edgeSpec.minBoatDraftM=0] - minimum required boat draft (meters); 0 = any boat
 * @param {number} edgeSpec.travelTimeMinBase - base travel time in in-game minutes
 * @returns {object} the registered edge
 * @throws {TypeError}  on validation failure
 * @throws {Error}      if either POI is not registered
 */
export function registerEdge(edgeSpec) {
  if (!edgeSpec || typeof edgeSpec !== 'object') {
    throw new TypeError('poiGraph.registerEdge: edgeSpec must be an object');
  }
  const { from, to } = edgeSpec;

  if (typeof from !== 'string' || from.length === 0) {
    throw new TypeError('poiGraph.registerEdge: from must be a non-empty string');
  }
  if (typeof to !== 'string' || to.length === 0) {
    throw new TypeError('poiGraph.registerEdge: to must be a non-empty string');
  }
  if (from === to) {
    throw new TypeError(`poiGraph.registerEdge: from and to must differ (got "${from}" twice)`);
  }
  if (!_nodes.has(from)) {
    throw new Error(
      `poiGraph.registerEdge: POI "${from}" is not registered. Register the node first.`
    );
  }
  if (!_nodes.has(to)) {
    throw new Error(
      `poiGraph.registerEdge: POI "${to}" is not registered. Register the node first.`
    );
  }

  if (typeof edgeSpec.distanceTiles !== 'number' || edgeSpec.distanceTiles <= 0) {
    throw new TypeError(`poiGraph.registerEdge [${from}↔${to}]: distanceTiles must be > 0`);
  }
  if (typeof edgeSpec.minDepthM !== 'number' || edgeSpec.minDepthM < 0) {
    throw new TypeError(`poiGraph.registerEdge [${from}↔${to}]: minDepthM must be ≥ 0`);
  }
  if (typeof edgeSpec.maxDepthM !== 'number' || edgeSpec.maxDepthM < edgeSpec.minDepthM) {
    throw new TypeError(
      `poiGraph.registerEdge [${from}↔${to}]: maxDepthM must be ≥ minDepthM`
    );
  }
  if (typeof edgeSpec.travelTimeMinBase !== 'number' || edgeSpec.travelTimeMinBase <= 0) {
    throw new TypeError(
      `poiGraph.registerEdge [${from}↔${to}]: travelTimeMinBase must be > 0`
    );
  }

  const minBoatDraftM = edgeSpec.minBoatDraftM ?? 0;
  if (typeof minBoatDraftM !== 'number' || minBoatDraftM < 0) {
    throw new TypeError(
      `poiGraph.registerEdge [${from}↔${to}]: minBoatDraftM must be ≥ 0`
    );
  }

  const edgeObj = Object.freeze({
    from,
    to,
    distanceTiles:    edgeSpec.distanceTiles,
    minDepthM:        edgeSpec.minDepthM,
    maxDepthM:        edgeSpec.maxDepthM,
    minBoatDraftM,
    travelTimeMinBase: edgeSpec.travelTimeMinBase,
  });

  _edges.set(_edgeKey(from, to), edgeObj);
  return edgeObj;
}

// ---------------------------------------------------------------------------
// Public API — graph queries (§9 contract surface)
// ---------------------------------------------------------------------------

/**
 * Returns an array of all POIs directly connected to the given POI by a registered edge.
 * Each entry contains the neighbour node and the edge connecting them.
 *
 * @param {string} poiId
 * @returns {{ poi: object, edge: object }[]}
 * @throws {Error} if poiId is not registered
 */
export function neighbors(poiId) {
  if (!_nodes.has(poiId)) {
    throw new Error(`poiGraph.neighbors: POI "${poiId}" is not registered`);
  }

  const result = [];
  for (const [, edgeObj] of _edges.entries()) {
    let neighborId = null;
    if (edgeObj.from === poiId) neighborId = edgeObj.to;
    else if (edgeObj.to === poiId) neighborId = edgeObj.from;

    if (neighborId !== null) {
      const poi = _nodes.get(neighborId);
      if (poi) result.push({ poi, edge: edgeObj });
    }
  }
  return result;
}

/**
 * Returns the edge between two POIs, or null if no edge exists.
 * Bidirectional: edge('DOCK','COVE') === edge('COVE','DOCK').
 *
 * @param {string} a
 * @param {string} b
 * @returns {object | null}
 */
export function edge(a, b) {
  return _edges.get(_edgeKey(a, b)) ?? null;
}

/**
 * Returns all POI nodes accessible to a boat of the given draft class.
 *
 * A POI is accessible if:
 *   boatDraftM <= POI_DRAFT_DEPTH_M[poi.draftClass]
 *   (the water at the POI is deep enough for the boat's draft)
 *
 * Note: this filters on POI water depth only, not on route availability. A POI
 * may be accessible by draft but have no traversable edge route (isolated POI).
 * navigation.js uses canReachViaEdge() below to filter traversable routes.
 *
 * @param {string} draftClass - one of DRAFT_CLASS_M keys (e.g. 'ROWBOAT', 'BASS_BOAT')
 * @returns {object[]} array of accessible PoiNode objects
 * @throws {TypeError} if draftClass is not a known draft class
 */
export function poisByDraft(draftClass) {
  if (!Object.prototype.hasOwnProperty.call(DRAFT_CLASS_M, draftClass)) {
    throw new TypeError(
      `poiGraph.poisByDraft: unknown draftClass "${draftClass}". Valid: ${Object.keys(DRAFT_CLASS_M).join(', ')}`
    );
  }

  const boatDraftM = DRAFT_CLASS_M[draftClass];
  const result     = [];

  for (const node of _nodes.values()) {
    const poiWaterDepthM = POI_DRAFT_DEPTH_M[node.draftClass];
    if (boatDraftM <= poiWaterDepthM) {
      result.push(node);
    }
  }

  return result;
}

/**
 * Checks whether a specific edge is traversable by a boat with the given draft (in metres).
 * Returns true when BOTH conditions are met (D-022):
 *   1. boatDraftM <= edge.minDepthM  (boat fits in the shallowest part of the channel)
 *   2. boatDraftM >= edge.minBoatDraftM  (boat is stable/capable for chop/depth)
 *
 * Used by navigation.js to filter available routes during requestTravel().
 *
 * @param {string} fromPoiId
 * @param {string} toPoiId
 * @param {number} boatDraftM - the active boat's shallowDraftMin in metres (from boats.js stat block)
 * @returns {boolean}
 */
export function canTraverseEdge(fromPoiId, toPoiId, boatDraftM) {
  const edgeObj = _edges.get(_edgeKey(fromPoiId, toPoiId));
  if (!edgeObj) return false;
  return boatDraftM <= edgeObj.minDepthM && boatDraftM >= edgeObj.minBoatDraftM;
}

/**
 * Returns the registered POI node for the given id, or undefined if not found.
 *
 * @param {string} poiId
 * @returns {object | undefined}
 */
export function getPoi(poiId) {
  return _nodes.get(poiId);
}

/**
 * Returns all registered POI nodes as an array.
 *
 * @returns {object[]}
 */
export function allPois() {
  return [..._nodes.values()];
}

/**
 * Returns the number of registered POIs.
 *
 * @returns {number}
 */
export function poiCount() {
  return _nodes.size;
}

/**
 * Returns the number of registered edges.
 *
 * @returns {number}
 */
export function edgeCount() {
  return _edges.size;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Clear all registered POIs and edges.
 * FOR TESTING ONLY.
 */
export function _clear() {
  _nodes.clear();
  _edges.clear();
}
