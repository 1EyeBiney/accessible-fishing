/**
 * AFish World Map — src/world/worldMap.js
 *
 * Public API Contract: getTile(coord) / tilesByPoi(poiId) / allCoords()
 *
 * Owns the D-037 Water Tile Schema. The engine ONLY queries world data through
 * this surface — no subsystem may read the internal sparse Map or iterate raw
 * grid coordinates directly (§9).
 *
 * Tile schema (D-037 — LOCKED):
 *   id:     string
 *   coord:  { x: number, y: number }
 *   traits: (IMMUTABLE post-generation) {
 *     depth:  { bottomM, minM, maxM, slopeDeg }
 *     bottom: { primary, secondary, hardness }  — enums: BOTTOM_TYPES
 *     cover:  { type, density, canopyDepthM, snagRisk, shadeFactor }  — enums: COVER_TYPES
 *     tags:   string[]  — subset of TILE_TAGS
 *     reach:  { fromDockMin, draftClass }
 *   }
 *   state: (MUTABLE per-tournament) {
 *     spook:    { level, updatedAtMs, sourceEventId }
 *     pressure: { level, updatedAtMs, lastCastAtMs, lastCatchAtMs }
 *     occupancy:{ fishCount, fishCountStaleAtMs }
 *     events:   []  — diagnostic only; NOT serialised in replay snapshots (H-004)
 *   }
 *
 * Tile existence in the sparse Map encodes water (D-009). Land tiles do not exist.
 * No `isWater` field is present.
 *
 * Per-tile `flow` is REMOVED from v0.1 — flow is per-POI only (D-037 note).
 *
 * Mutable state is modified ONLY via mutateTileState(), not by direct property assignment.
 * castSpookModel.js writes to tile.state.spook.
 * fish/fishBehavior.js writes to tile.state.pressure and tile.state.occupancy.
 *
 * POI Zone registry:
 *   registerPoiZone(poiId, coordKeys) associates a set of tile coords with a POI frame.
 *   This is called by the lake generator during world generation.
 *   tilesByPoi(poiId) returns all tiles in that registered zone.
 *   structureIndex.rebuild() consumes tilesByPoi() to precompute candidates (H-002).
 */

// ---------------------------------------------------------------------------
// Schema enumerations (D-037)
// ---------------------------------------------------------------------------

/** Valid bottom type values for tile.traits.bottom.primary / secondary. */
export const BOTTOM_TYPES = Object.freeze(['MUD', 'SAND', 'GRAVEL', 'ROCK']);

/** Valid cover type values for tile.traits.cover.type. */
export const COVER_TYPES = Object.freeze([
  'NONE', 'WEEDBED', 'TIMBER', 'LILYPADS',
  'DOCK', 'BRUSHPILE', 'ROCKPILE', 'OVERHANG',
]);

/** Valid structural tag values for tile.traits.tags[]. */
export const TILE_TAGS = Object.freeze([
  'DROP_OFF_EDGE', 'WEEDBED_INNER', 'WEEDBED_EDGE',
  'TIMBER_INNER',  'TIMBER_EDGE',   'AMBUSH_POINT',
  'OPEN_FLAT',     'POINT',         'TRANSITION',    'SHADED_DAY',
]);

/** Valid draft class values for tile.traits.reach.draftClass. */
export const DRAFT_CLASSES = Object.freeze(['SHALLOW', 'MEDIUM', 'DEEP']);

// ---------------------------------------------------------------------------
// Coordinate helpers (D-009)
// ---------------------------------------------------------------------------

/**
 * Returns the canonical sparse-Map key for a tile coordinate.
 * All world-map lookups MUST use this key format — no raw `${x},${y}` templates
 * elsewhere in the codebase.
 *
 * @param {number} x
 * @param {number} y
 * @returns {string} e.g. "3,7"
 */
export function coordKey(x, y) {
  return `${x},${y}`;
}

/**
 * Parses a coordKey string back into a coordinate object.
 *
 * @param {string} key
 * @returns {{ x: number, y: number }}
 */
export function parseCoordKey(key) {
  const parts = key.split(',');
  return { x: Number(parts[0]), y: Number(parts[1]) };
}

/**
 * Normalises a coord argument: accepts either {x,y} object or a coordKey string.
 *
 * @param {{ x: number, y: number } | string} coord
 * @returns {{ key: string, x: number, y: number }}
 * @throws {TypeError} if coord is not a valid form
 */
function _resolveCoord(coord) {
  if (typeof coord === 'string') {
    const { x, y } = parseCoordKey(coord);
    return { key: coord, x, y };
  }
  if (coord && typeof coord.x === 'number' && typeof coord.y === 'number') {
    return { key: coordKey(coord.x, coord.y), x: coord.x, y: coord.y };
  }
  throw new TypeError(
    'worldMap: coord must be {x,y} object or a coordKey string'
  );
}

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/** Sparse tile map: coordKey → Tile (water tiles only). @type {Map<string, object>} */
const _tiles = new Map();

/** POI zone registry: poiId → coordKey[]. @type {Map<string, string[]>} */
const _poiZones = new Map();

// ---------------------------------------------------------------------------
// Schema validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates a traits block against the D-037 schema.
 * Throws a descriptive TypeError on any schema violation.
 * Called once during registerTile(); traits are frozen after validation.
 *
 * @param {object} traits
 * @param {string} tileId  - included in error messages for diagnostics
 * @throws {TypeError}
 */
function _validateTraits(traits, tileId) {
  const id = `[tile ${tileId}]`;

  // depth
  if (!traits.depth || typeof traits.depth !== 'object') {
    throw new TypeError(`${id} traits.depth is required`);
  }
  const { bottomM, minM, maxM, slopeDeg } = traits.depth;
  if (typeof bottomM !== 'number' || bottomM < 0) {
    throw new TypeError(`${id} traits.depth.bottomM must be a non-negative number`);
  }
  if (typeof minM !== 'number' || typeof maxM !== 'number' || minM > maxM) {
    throw new TypeError(`${id} traits.depth.minM must be ≤ maxM`);
  }
  if (typeof slopeDeg !== 'number' || slopeDeg < 0 || slopeDeg > 90) {
    throw new TypeError(`${id} traits.depth.slopeDeg must be in [0, 90]`);
  }

  // bottom
  if (!traits.bottom || typeof traits.bottom !== 'object') {
    throw new TypeError(`${id} traits.bottom is required`);
  }
  if (!BOTTOM_TYPES.includes(traits.bottom.primary)) {
    throw new TypeError(
      `${id} traits.bottom.primary must be one of: ${BOTTOM_TYPES.join(', ')}`
    );
  }
  if (traits.bottom.secondary !== null && traits.bottom.secondary !== undefined &&
      !BOTTOM_TYPES.includes(traits.bottom.secondary)) {
    throw new TypeError(
      `${id} traits.bottom.secondary must be null or one of: ${BOTTOM_TYPES.join(', ')}`
    );
  }
  if (typeof traits.bottom.hardness !== 'number' ||
      traits.bottom.hardness < 0 || traits.bottom.hardness > 1) {
    throw new TypeError(`${id} traits.bottom.hardness must be in [0, 1]`);
  }

  // cover
  if (!traits.cover || typeof traits.cover !== 'object') {
    throw new TypeError(`${id} traits.cover is required`);
  }
  if (!COVER_TYPES.includes(traits.cover.type)) {
    throw new TypeError(
      `${id} traits.cover.type must be one of: ${COVER_TYPES.join(', ')}`
    );
  }
  if (typeof traits.cover.density !== 'number' ||
      traits.cover.density < 0 || traits.cover.density > 1) {
    throw new TypeError(`${id} traits.cover.density must be in [0, 1]`);
  }
  if (typeof traits.cover.canopyDepthM !== 'number' || traits.cover.canopyDepthM < 0) {
    throw new TypeError(`${id} traits.cover.canopyDepthM must be a non-negative number`);
  }
  if (typeof traits.cover.snagRisk !== 'number' ||
      traits.cover.snagRisk < 0 || traits.cover.snagRisk > 1) {
    throw new TypeError(`${id} traits.cover.snagRisk must be in [0, 1]`);
  }
  if (typeof traits.cover.shadeFactor !== 'number' ||
      traits.cover.shadeFactor < 0 || traits.cover.shadeFactor > 1) {
    throw new TypeError(`${id} traits.cover.shadeFactor must be in [0, 1]`);
  }

  // tags
  if (!Array.isArray(traits.tags)) {
    throw new TypeError(`${id} traits.tags must be an array`);
  }
  for (const tag of traits.tags) {
    if (!TILE_TAGS.includes(tag)) {
      throw new TypeError(
        `${id} traits.tags contains unknown tag "${tag}". Valid: ${TILE_TAGS.join(', ')}`
      );
    }
  }

  // reach
  if (!traits.reach || typeof traits.reach !== 'object') {
    throw new TypeError(`${id} traits.reach is required`);
  }
  if (typeof traits.reach.fromDockMin !== 'number' || traits.reach.fromDockMin < 0) {
    throw new TypeError(`${id} traits.reach.fromDockMin must be a non-negative number`);
  }
  if (!DRAFT_CLASSES.includes(traits.reach.draftClass)) {
    throw new TypeError(
      `${id} traits.reach.draftClass must be one of: ${DRAFT_CLASSES.join(', ')}`
    );
  }
}

/**
 * Creates a fresh default mutable tile state.
 * Matches the D-037 state schema exactly.
 *
 * @returns {object}
 */
function _makeMutableState() {
  return {
    spook: {
      level:        0,
      updatedAtMs:  0,
      sourceEventId: null,
    },
    pressure: {
      level:          0,
      updatedAtMs:    0,
      lastCastAtMs:   0,
      lastCatchAtMs:  0,
    },
    occupancy: {
      fishCount:          0,
      fishCountStaleAtMs: 0,
    },
    // Diagnostic only — NOT serialised in replay snapshots (H-004).
    // Cast/fight events that affected this tile are appended here for tooling.
    events: [],
  };
}

// ---------------------------------------------------------------------------
// Public API — world generation (called by the lake generator)
// ---------------------------------------------------------------------------

/**
 * Register a tile in the world.
 * Validates the full D-037 schema, deep-freezes traits (immutable post-generation),
 * and initialises a default mutable state.
 *
 * The `state` field in tileSpec is IGNORED — initial state is always the default.
 * Pass `initialState` to override (e.g. for loading a saved tournament snapshot).
 *
 * @param {object}  tileSpec
 * @param {string}  tileSpec.id
 * @param {{ x: number, y: number }} tileSpec.coord
 * @param {object}  tileSpec.traits          - full D-037 traits block
 * @param {object}  [tileSpec.initialState]  - override initial mutable state
 * @returns {object} the registered Tile object
 * @throws {TypeError}  on schema violations
 * @throws {Error}      if a tile already exists at that coord (no silent overwrites)
 */
export function registerTile(tileSpec) {
  if (!tileSpec || typeof tileSpec !== 'object') {
    throw new TypeError('worldMap.registerTile: tileSpec must be an object');
  }
  if (typeof tileSpec.id !== 'string' || tileSpec.id.length === 0) {
    throw new TypeError('worldMap.registerTile: tileSpec.id must be a non-empty string');
  }

  const { key, x, y } = _resolveCoord(tileSpec.coord);

  if (_tiles.has(key)) {
    throw new Error(
      `worldMap.registerTile: tile already exists at (${x},${y}). Use mutateTileState() to update state.`
    );
  }

  const traits = tileSpec.traits;
  if (!traits || typeof traits !== 'object') {
    throw new TypeError(`worldMap.registerTile [${tileSpec.id}]: traits is required`);
  }

  _validateTraits(traits, tileSpec.id);

  // Deep-freeze traits — immutable post-generation (D-037).
  const frozenDepth = Object.freeze({
    bottomM:  traits.depth.bottomM,
    minM:     traits.depth.minM,
    maxM:     traits.depth.maxM,
    slopeDeg: traits.depth.slopeDeg,
  });
  const frozenBottom = Object.freeze({
    primary:   traits.bottom.primary,
    secondary: traits.bottom.secondary ?? null,
    hardness:  traits.bottom.hardness,
  });
  const frozenCover = Object.freeze({
    type:         traits.cover.type,
    density:      traits.cover.density,
    canopyDepthM: traits.cover.canopyDepthM,
    snagRisk:     traits.cover.snagRisk,
    shadeFactor:  traits.cover.shadeFactor,
  });
  const frozenReach = Object.freeze({
    fromDockMin: traits.reach.fromDockMin,
    draftClass:  traits.reach.draftClass,
  });
  const frozenTraits = Object.freeze({
    depth:  frozenDepth,
    bottom: frozenBottom,
    cover:  frozenCover,
    tags:   Object.freeze([...traits.tags]),
    reach:  frozenReach,
  });

  const tile = {
    id:     tileSpec.id,
    coord:  Object.freeze({ x, y }),
    traits: frozenTraits,
    state:  tileSpec.initialState
              ? { ...tileSpec.initialState }
              : _makeMutableState(),
  };

  _tiles.set(key, tile);
  return tile;
}

/**
 * Associate a set of tile coordinates with a POI frame zone.
 * Called by the lake generator during world generation.
 * Replaces any previous zone registration for this poiId.
 *
 * @param {string}   poiId
 * @param {string[]} coordKeys - array of coordKey strings (e.g. ['3,7', '4,7'])
 * @throws {TypeError} if arguments are invalid
 */
export function registerPoiZone(poiId, coordKeys) {
  if (typeof poiId !== 'string' || poiId.length === 0) {
    throw new TypeError('worldMap.registerPoiZone: poiId must be a non-empty string');
  }
  if (!Array.isArray(coordKeys)) {
    throw new TypeError('worldMap.registerPoiZone: coordKeys must be an array');
  }
  _poiZones.set(poiId, [...coordKeys]);
}

// ---------------------------------------------------------------------------
// Public API — world queries (§9 contract surface)
// ---------------------------------------------------------------------------

/**
 * Returns the Tile at the given coordinate, or undefined if no water tile exists there.
 *
 * @param {{ x: number, y: number } | string} coord
 * @returns {object | undefined}
 */
export function getTile(coord) {
  const { key } = _resolveCoord(coord);
  return _tiles.get(key);
}

/**
 * Returns all Tile objects registered in a POI's frame zone.
 * Returns an empty array if the POI has no registered zone or if any coord has no tile.
 *
 * Used by structureIndex.rebuild() to precompute candidate lists (H-002).
 *
 * @param {string} poiId
 * @returns {object[]} array of Tile objects (may be empty)
 */
export function tilesByPoi(poiId) {
  const coordKeys = _poiZones.get(poiId);
  if (!coordKeys) return [];

  const result = [];
  for (const key of coordKeys) {
    const tile = _tiles.get(key);
    if (tile) result.push(tile);
  }
  return result;
}

/**
 * Returns all registered coord keys in the world as { x, y } objects.
 * Callers must never iterate the raw sparse Map — use this instead.
 *
 * @returns {{ x: number, y: number }[]}
 */
export function allCoords() {
  const result = [];
  for (const key of _tiles.keys()) {
    result.push(parseCoordKey(key));
  }
  return result;
}

/**
 * Returns all registered POI zone ids.
 * Useful for world validation and for structureIndex.rebuild() when no explicit
 * list of POI ids is provided.
 *
 * @returns {string[]}
 */
export function allPoiIds() {
  return [..._poiZones.keys()];
}

// ---------------------------------------------------------------------------
// Public API — mutable state update
// ---------------------------------------------------------------------------

/**
 * Apply a mutation to a tile's mutable state.
 *
 * This is the ONLY permitted way to mutate tile.state. Direct property writes
 * on the tile object returned by getTile() are FORBIDDEN.
 *
 * The updater function receives the current state object and returns a new
 * state object (or mutates-and-returns — both patterns work since tile.state
 * is replaced by reference).
 *
 * Consumers:
 *   - castSpookModel.js writes to tile.state.spook
 *   - fish/fishBehavior.js writes to tile.state.pressure and occupancy
 *
 * @param {{ x: number, y: number } | string} coord
 * @param {(state: object) => object} updater - (currentState) => nextState
 * @throws {TypeError}  if updater is not a function
 * @throws {Error}      if no tile exists at that coord
 */
export function mutateTileState(coord, updater) {
  if (typeof updater !== 'function') {
    throw new TypeError('worldMap.mutateTileState: updater must be a function');
  }
  const { key, x, y } = _resolveCoord(coord);
  const tile = _tiles.get(key);
  if (!tile) {
    throw new Error(`worldMap.mutateTileState: no tile at (${x},${y})`);
  }
  tile.state = updater(tile.state);
}

/**
 * Reset all tile events arrays.
 * Called between tournaments to clear diagnostic event history (H-004: events are
 * NOT serialised in replay snapshots, so they can be freely cleared on new tournament).
 * Spook and pressure states carry over between tournaments (compute-on-read decay
 * handles their decay automatically — D-038, D-039).
 */
export function clearTileEvents() {
  for (const tile of _tiles.values()) {
    tile.state.events = [];
  }
}

// ---------------------------------------------------------------------------
// World metrics (informational)
// ---------------------------------------------------------------------------

/**
 * Returns the total number of registered water tiles.
 *
 * @returns {number}
 */
export function tileCount() {
  return _tiles.size;
}

/**
 * Returns the number of tiles registered in a given POI's zone.
 * Returns 0 if the POI has no registered zone.
 *
 * @param {string} poiId
 * @returns {number}
 */
export function tileCountForPoi(poiId) {
  const coordKeys = _poiZones.get(poiId);
  return coordKeys ? coordKeys.length : 0;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Clear all tiles and POI zone registrations.
 * FOR TESTING ONLY — resets the world to an empty state.
 */
export function _clear() {
  _tiles.clear();
  _poiZones.clear();
}
