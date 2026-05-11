/**
 * AFish Structure Index — src/world/structureIndex.js
 *
 * Public API Contract: candidatesForPoi(poiId) / rebuild(poiIds?) / isBuilt(poiId)
 *
 * H-002 Performance Mitigation: Pre-computes and groups tile candidates by structural
 * interest within each POI's frame radius so the Fish Finder (D-041/D-042) and AI
 * bots (D-005/D-059) NEVER iterate over the raw worldMap during real-time loops.
 *
 * The index is built ONCE during world generation and stays stable for the lifetime
 * of the world. It is rebuilt when the world is regenerated (new tournament lake).
 *
 * Candidate output schema (per tile):
 *   {
 *     tileId:         string,
 *     coord:          { x: number, y: number },     // global grid coordinate
 *     offset:         { dx: number, dy: number },    // local frame offset from POI centre
 *     depthM:         number,                        // representative depth (minM)
 *     bottomType:     string,                        // primary bottom type
 *     coverType:      string,                        // cover type
 *     coverDensity:   number,                        // cover density [0..1]
 *     tags:           string[],                      // structural tags (frozen copy)
 *     snagRisk:       number,                        // cover.snagRisk [0..1]
 *     shadeFactor:    number,                        // cover.shadeFactor [0..1]
 *     draftClass:     string,                        // reach.draftClass
 *     fromDockMin:    number,                        // reach.fromDockMin in game minutes
 *     structureScore: number,                        // static ranking score in [0..1]
 *     label:          string,                        // short TTS label string
 *   }
 *
 * Ranking model:
 *   structureScore is a normalised composite of tag-based and cover-based scores.
 *   The Fish Finder (fishFinder.js) augments this with LIVE data: castSpookModel.readSpook()
 *   and fish/fishBehavior.readPressure(). The structureIndex never reads live state —
 *   it is purely structural (no spook, no pressure, no occupancy). H-014 preserved.
 *
 * Import dependencies (within src/world/ — no cross-folder imports):
 *   worldMap.js  — tilesByPoi(), allPoiIds()
 *   poiGraph.js  — getPoi()
 */

import { tilesByPoi, allPoiIds } from './worldMap.js';
import { getPoi }                from './poiGraph.js';

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/**
 * Tag score contributions. Higher = more likely to hold fish.
 * Hand-tuned based on bass fishing knowledge; not derived from a formula.
 */
const TAG_SCORES = Object.freeze({
  AMBUSH_POINT:   40,
  DROP_OFF_EDGE:  30,
  WEEDBED_EDGE:   25,
  TIMBER_EDGE:    25,
  POINT:          20,
  WEEDBED_INNER:  15,
  TIMBER_INNER:   15,
  TRANSITION:     10,
  SHADED_DAY:      8,
  OPEN_FLAT:       2,  // baseline — some structure beats none
});

/**
 * Cover type score contributions.
 */
const COVER_SCORES = Object.freeze({
  DOCK:      20,
  BRUSHPILE: 18,
  OVERHANG:  15,
  TIMBER:    12,
  ROCKPILE:  12,
  WEEDBED:   10,
  LILYPADS:   8,
  NONE:       0,
});

/**
 * Theoretical maximum raw score (all top tags + best cover).
 * Used to normalise to [0..1].
 * Max tags: AMBUSH_POINT(40) + DROP_OFF_EDGE(30) + WEEDBED_EDGE(25) + TIMBER_EDGE(25)
 *           + POINT(20) + WEEDBED_INNER(15) + TIMBER_INNER(15) + TRANSITION(10)
 *           + SHADED_DAY(8) + OPEN_FLAT(2) = 190
 * Max cover: DOCK(20)
 * Total max = 210
 */
const MAX_STRUCTURE_SCORE = 210;

// ---------------------------------------------------------------------------
// Internal index
// ---------------------------------------------------------------------------

/**
 * Pre-computed candidate list per POI.
 * Sorted by structureScore descending (best candidates first).
 * @type {Map<string, object[]>}
 */
const _index = new Map();

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Compute the normalised structure score for a tile.
 * Score is based entirely on immutable traits — no live state consulted.
 *
 * @param {object} tile - a worldMap Tile object
 * @returns {number} normalised score in [0, 1]
 */
function _computeStructureScore(tile) {
  let raw = 0;

  // Tag contributions
  for (const tag of tile.traits.tags) {
    raw += TAG_SCORES[tag] ?? 0;
  }

  // Cover type contribution
  raw += COVER_SCORES[tile.traits.cover.type] ?? 0;

  // Density bonus: denser cover is more productive (up to +10 at max density)
  if (tile.traits.cover.type !== 'NONE') {
    raw += tile.traits.cover.density * 10;
  }

  return Math.min(1, raw / MAX_STRUCTURE_SCORE);
}

/**
 * Generates a short, screen-reader-friendly label string for a tile candidate.
 * Used by the Fish Finder TTS output (D-042) when reading out scan results.
 *
 * Format: "<cover>, <depth>m, <bottom>, [<primary tag>]"
 * Examples:
 *   "Dock, 3.5m, gravel, ambush point"
 *   "Timber, 6m, rock, drop-off edge"
 *   "Open water, 4m, sand"
 *
 * @param {object} tile
 * @returns {string}
 */
function _generateLabel(tile) {
  const parts = [];

  // Cover type — human-readable
  const coverLabels = {
    NONE:      'Open water',
    WEEDBED:   'Weed bed',
    TIMBER:    'Timber',
    LILYPADS:  'Lily pads',
    DOCK:      'Dock',
    BRUSHPILE: 'Brush pile',
    ROCKPILE:  'Rock pile',
    OVERHANG:  'Overhang',
  };
  parts.push(coverLabels[tile.traits.cover.type] ?? tile.traits.cover.type);

  // Depth — use minM as the representative castable depth
  const depthM = tile.traits.depth.minM;
  parts.push(`${depthM.toFixed(1)}m`);

  // Primary bottom
  const bottomLabels = {
    MUD:    'mud',
    SAND:   'sand',
    GRAVEL: 'gravel',
    ROCK:   'rock',
  };
  parts.push(bottomLabels[tile.traits.bottom.primary] ?? tile.traits.bottom.primary.toLowerCase());

  // Primary structural tag (most significant for player decision-making)
  const tagLabelPriority = [
    'AMBUSH_POINT', 'DROP_OFF_EDGE', 'WEEDBED_EDGE', 'TIMBER_EDGE',
    'POINT', 'TRANSITION', 'WEEDBED_INNER', 'TIMBER_INNER', 'SHADED_DAY',
  ];
  const tagLabels = {
    AMBUSH_POINT:  'ambush point',
    DROP_OFF_EDGE: 'drop-off edge',
    WEEDBED_EDGE:  'weed edge',
    TIMBER_EDGE:   'timber edge',
    POINT:         'point',
    TRANSITION:    'transition',
    WEEDBED_INNER: 'weed flat',
    TIMBER_INNER:  'timber flat',
    SHADED_DAY:    'shaded',
    OPEN_FLAT:     null, // omit — covered by "Open water" cover label
  };
  for (const tag of tagLabelPriority) {
    if (tile.traits.tags.includes(tag) && tagLabels[tag]) {
      parts.push(tagLabels[tag]);
      break;
    }
  }

  return parts.join(', ');
}

/**
 * Build a single candidate object from a tile and its POI context.
 *
 * @param {object} tile         - worldMap Tile
 * @param {object} poi          - poiGraph POI node
 * @returns {object}            - candidate object (plain, not frozen — fishFinder augments it)
 */
function _buildCandidate(tile, poi) {
  const dx = tile.coord.x - poi.centerCoord.x;
  const dy = tile.coord.y - poi.centerCoord.y;

  return {
    tileId:         tile.id,
    coord:          { x: tile.coord.x, y: tile.coord.y },
    offset:         { dx, dy },
    depthM:         tile.traits.depth.minM,
    bottomType:     tile.traits.bottom.primary,
    coverType:      tile.traits.cover.type,
    coverDensity:   tile.traits.cover.density,
    tags:           [...tile.traits.tags],       // unfrozen copy for augmentation
    snagRisk:       tile.traits.cover.snagRisk,
    shadeFactor:    tile.traits.cover.shadeFactor,
    draftClass:     tile.traits.reach.draftClass,
    fromDockMin:    tile.traits.reach.fromDockMin,
    structureScore: _computeStructureScore(tile),
    label:          _generateLabel(tile),
  };
}

// ---------------------------------------------------------------------------
// Public API — index management
// ---------------------------------------------------------------------------

/**
 * (Re)build the structure index for the specified POIs.
 * If no poiIds array is given, rebuilds for ALL POIs registered in worldMap.
 *
 * Process per POI:
 *   1. Fetch all tiles in the POI's zone from worldMap.tilesByPoi().
 *   2. Skip tiles outside the POI's frameRadius (tiles registered in the zone should
 *      already be frame-bounded, but this provides a safety filter).
 *   3. Build a candidate object per tile (structureScore + label + offset).
 *   4. Sort descending by structureScore.
 *   5. Store in _index under the poiId.
 *
 * Should be called:
 *   a) Once after world generation is complete.
 *   b) Again if tiles are replaced (full world regeneration — not mid-tournament).
 *   Never called mid-tournament (H-002: precomputed index is the point; mid-tournament
 *   rebuilds would defeat the performance mitigation).
 *
 * @param {string[]} [poiIds] - explicit list of POI ids to build. Defaults to all.
 * @returns {{ built: number, skipped: number }} summary of build results
 */
export function rebuild(poiIds) {
  const targets = Array.isArray(poiIds) ? poiIds : allPoiIds();
  let built    = 0;
  let skipped  = 0;

  for (const poiId of targets) {
    const poi = getPoi(poiId);
    if (!poi) {
      console.warn(`[structureIndex] rebuild: POI "${poiId}" not in poiGraph — skipping`);
      skipped++;
      continue;
    }

    const tiles = tilesByPoi(poiId);
    if (tiles.length === 0) {
      // POI has no zone tiles registered in worldMap yet. Store an empty list
      // so candidatesForPoi() returns [] rather than null.
      _index.set(poiId, []);
      built++;
      continue;
    }

    const candidates = [];
    const frameRadiusSq = poi.frameRadius * poi.frameRadius;

    for (const tile of tiles) {
      // Safety filter: only include tiles within the declared frame radius.
      // In a correctly-generated world these should all pass, but a mis-registered
      // zone could include out-of-frame tiles.
      const dx    = tile.coord.x - poi.centerCoord.x;
      const dy    = tile.coord.y - poi.centerCoord.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > frameRadiusSq) continue;

      candidates.push(_buildCandidate(tile, poi));
    }

    // Sort best-first: highest structureScore → first candidate offered to fishFinder
    candidates.sort((a, b) => b.structureScore - a.structureScore);

    _index.set(poiId, candidates);
    built++;
  }

  return { built, skipped };
}

// ---------------------------------------------------------------------------
// Public API — query (§9 contract surface)
// ---------------------------------------------------------------------------

/**
 * Returns the precomputed candidate list for a POI, sorted best-first by structureScore.
 *
 * The returned array contains STATIC structural data only — no live spook, pressure,
 * or occupancy. Consumers (fishFinder.js, aiBots.js) are responsible for augmenting
 * with live data at query time.
 *
 * Returns an empty array if:
 *   - The POI has not been indexed (rebuild() not yet called, or POI has no tiles).
 *   - The POI id is unknown.
 *
 * Returns COPIES of candidate objects — consumers may safely augment them with live
 * fields (spook, pressure, presenceHint, speciesBand) for D-041 FISH_FINDER_RESULTS
 * without affecting the precomputed index.
 *
 * @param {string} poiId
 * @returns {object[]} sorted array of candidate objects (copies, safe to augment)
 */
export function candidatesForPoi(poiId) {
  const list = _index.get(poiId);
  if (!list) return [];

  // Return shallow copies of each candidate so live augmentation doesn't pollute
  // the precomputed index. tags[] is already an unfrozen copy from _buildCandidate.
  return list.map(c => ({ ...c }));
}

/**
 * Returns whether the structure index has been built for the given POI.
 *
 * @param {string} poiId
 * @returns {boolean}
 */
export function isBuilt(poiId) {
  return _index.has(poiId);
}

/**
 * Returns the number of structural candidates precomputed for a given POI.
 * Returns 0 if not yet built.
 *
 * @param {string} poiId
 * @returns {number}
 */
export function candidateCount(poiId) {
  return (_index.get(poiId) ?? []).length;
}

/**
 * Returns all POI ids that have been indexed.
 *
 * @returns {string[]}
 */
export function builtPoiIds() {
  return [..._index.keys()];
}

/**
 * Returns the raw scoring constants for external testing or display purposes.
 * Not used by any engine subsystem — exported for harness diagnostics only.
 *
 * @returns {{ tagScores: object, coverScores: object, maxScore: number }}
 */
export function scoringConstants() {
  return {
    tagScores:  { ...TAG_SCORES },
    coverScores: { ...COVER_SCORES },
    maxScore:   MAX_STRUCTURE_SCORE,
  };
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Clear all precomputed index data.
 * FOR TESTING ONLY.
 */
export function _clear() {
  _index.clear();
}

// ---------------------------------------------------------------------------
// Dev-time mock seed — DOCK POI
// ---------------------------------------------------------------------------
// The full world generator is not yet connected, so candidatesForPoi('DOCK')
// would return [] on every boot. These three hand-crafted candidates give the
// Fish Finder (and the casting FSM) something concrete to work with until a
// real world is generated.
//
// Candidate schema matches _buildCandidate() output exactly so that fishFinder
// augmentation (spook / pressure overlay) works without modification.
// Remove or gate this block behind a flag when worldMap.rebuild() is wired.
// ---------------------------------------------------------------------------
_index.set('DOCK', [
  {
    tileId:         'DOCK_mock_pilings',
    coord:          { x: 0, y: 0 },
    offset:         { dx: 0, dy: -2 },
    depthM:         2.5,
    bottomType:     'GRAVEL',
    coverType:      'DOCK',
    coverDensity:   0.8,
    tags:           ['AMBUSH_POINT', 'SHADED_DAY'],
    snagRisk:       0.4,
    shadeFactor:    0.7,
    draftClass:     'SHALLOW',
    fromDockMin:    0,
    structureScore: _computeStructureScore({
      traits: {
        tags:    ['AMBUSH_POINT', 'SHADED_DAY'],
        cover:   { type: 'DOCK',    density: 0.8, snagRisk: 0.4, shadeFactor: 0.7 },
        depth:   { minM: 2.5 },
        bottom:  { primary: 'GRAVEL' },
        reach:   { draftClass: 'SHALLOW', fromDockMin: 0 },
      },
    }),
    label: 'Dock, 2.5m, gravel, ambush point',
  },
  {
    tileId:         'DOCK_mock_weedbed',
    coord:          { x: 3, y: 1 },
    offset:         { dx: 3, dy: 1 },
    depthM:         1.5,
    bottomType:     'SAND',
    coverType:      'WEEDBED',
    coverDensity:   0.6,
    tags:           ['WEEDBED_EDGE'],
    snagRisk:       0.3,
    shadeFactor:    0.2,
    draftClass:     'SHALLOW',
    fromDockMin:    2,
    structureScore: _computeStructureScore({
      traits: {
        tags:    ['WEEDBED_EDGE'],
        cover:   { type: 'WEEDBED', density: 0.6, snagRisk: 0.3, shadeFactor: 0.2 },
        depth:   { minM: 1.5 },
        bottom:  { primary: 'SAND' },
        reach:   { draftClass: 'SHALLOW', fromDockMin: 2 },
      },
    }),
    label: 'Weed bed, 1.5m, sand, weed edge',
  },
  {
    tileId:         'DOCK_mock_dropoff',
    coord:          { x: -2, y: 4 },
    offset:         { dx: -2, dy: 4 },
    depthM:         5.0,
    bottomType:     'ROCK',
    coverType:      'NONE',
    coverDensity:   0.0,
    tags:           ['DROP_OFF_EDGE', 'TRANSITION'],
    snagRisk:       0.1,
    shadeFactor:    0.0,
    draftClass:     'MEDIUM',
    fromDockMin:    5,
    structureScore: _computeStructureScore({
      traits: {
        tags:    ['DROP_OFF_EDGE', 'TRANSITION'],
        cover:   { type: 'NONE', density: 0.0, snagRisk: 0.1, shadeFactor: 0.0 },
        depth:   { minM: 5.0 },
        bottom:  { primary: 'ROCK' },
        reach:   { draftClass: 'MEDIUM', fromDockMin: 5 },
      },
    }),
    label: 'Open water, 5.0m, rock, drop-off edge',
  },
]);
