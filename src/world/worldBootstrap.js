/**
 * AFish World Bootstrap — src/world/worldBootstrap.js
 *
 * v1.90 — Ghost Map Fix.
 *
 * Seeds poiGraph and worldMap with the Phase-2 stub lake so that every
 * subsystem that derives absolute tile coordinates (castPipeline._getPoiCenter,
 * diagnostics._resolveTargetCoord, castSpookModel.applySplash, fishBehavior
 * pressure reads) has a physical world to operate against.
 *
 * This module is the production analogue of the test harness's buildTestWorld()
 * helper. It is called ONCE by engine.boot(), immediately after diagnostics.init()
 * and before registerUiManifests().
 *
 * Phase 4 plan: Replace the static literal data in bootstrap() with a call to a
 * real lake generator. Do NOT embed this data into poiGraph.js or worldMap.js —
 * those modules are pure registries with no knowledge of specific lake content.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Architecture Boundaries (LOCKED)
 * ═══════════════════════════════════════════════════════════════════════════
 *   • Imports ONLY from './poiGraph.js' and './worldMap.js' (both same dir).
 *   • Registers data only — no bus subscriptions, no clock handles, no rng calls.
 *   • Idempotent: exits silently if poiGraph already has ≥ 1 POI registered.
 *     This keeps it safe to import from test harnesses that build their own world
 *     via _clear() + custom registerPoi/registerTile calls.
 */

import * as poiGraph from './poiGraph.js';
import * as worldMap from './worldMap.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed the poiGraph and worldMap with the Phase-2 stub lake.
 *
 * Idempotent — silently no-ops if poiGraph already has at least one registered
 * POI. Call from engine.boot() only.
 *
 * World layout
 * ────────────
 * DOCK  centerCoord (50, 50)   frameRadius 10   draftClass SHALLOW
 *
 * Tiles (absolute coords = centerCoord + structureIndex mock offset):
 *   (50, 48)  DOCK_mock_pilings  — dock pilings, 2.5 m, GRAVEL, DOCK cover
 *   (53, 51)  DOCK_mock_weedbed  — shallow weed bed, 1.5 m, SAND, WEEDBED cover
 *   (48, 54)  DOCK_mock_dropoff  — deep drop-off, 5.0 m, ROCK, no cover
 *
 * All numeric values (coverDensity, snagRisk, shadeFactor, fromDockMin, draftClass)
 * match the structureIndex.js mock candidates verbatim so that F2 diagnostics and
 * structureIndex candidate reads agree on every field.
 */
export function bootstrap() {
  if (poiGraph.poiCount() > 0) return;

  // ── POI: DOCK ─────────────────────────────────────────────────────────────
  poiGraph.registerPoi({
    id:          'DOCK',
    label:       'Main Dock',
    centerCoord: { x: 50, y: 50 },
    frameRadius: 10,
    draftClass:  'SHALLOW',
    description: 'Wooden pilings and shaded structure along the south shore.',
  });

  // ── Tiles for DOCK ────────────────────────────────────────────────────────
  // (50, 48)  offset (0, −2)   — dock pilings, ambush point
  worldMap.registerTile({
    id:    'DOCK_mock_pilings',
    coord: { x: 50, y: 48 },
    traits: {
      depth:  { bottomM: 2.5,  minM: 2.0, maxM: 3.0, slopeDeg: 10 },
      bottom: { primary: 'GRAVEL', secondary: null, hardness: 0.7 },
      cover:  { type: 'DOCK',    density: 0.8, canopyDepthM: 0.5, snagRisk: 0.4, shadeFactor: 0.7 },
      tags:   ['AMBUSH_POINT', 'SHADED_DAY'],
      reach:  { fromDockMin: 0, draftClass: 'SHALLOW' },
    },
  });

  // (53, 51)  offset (3, 1)    — shallow weed bed
  worldMap.registerTile({
    id:    'DOCK_mock_weedbed',
    coord: { x: 53, y: 51 },
    traits: {
      depth:  { bottomM: 1.5,  minM: 1.0, maxM: 2.0, slopeDeg: 5 },
      bottom: { primary: 'SAND',   secondary: null, hardness: 0.3 },
      cover:  { type: 'WEEDBED', density: 0.6, canopyDepthM: 0.8, snagRisk: 0.3, shadeFactor: 0.2 },
      tags:   ['WEEDBED_EDGE'],
      reach:  { fromDockMin: 2, draftClass: 'SHALLOW' },
    },
  });

  // (48, 54)  offset (−2, 4)   — deep rock drop-off
  worldMap.registerTile({
    id:    'DOCK_mock_dropoff',
    coord: { x: 48, y: 54 },
    traits: {
      depth:  { bottomM: 5.0,  minM: 3.0, maxM: 6.0, slopeDeg: 45 },
      bottom: { primary: 'ROCK',   secondary: null, hardness: 0.9 },
      cover:  { type: 'NONE',    density: 0.0, canopyDepthM: 0.0, snagRisk: 0.1, shadeFactor: 0.0 },
      tags:   ['DROP_OFF_EDGE', 'TRANSITION'],
      reach:  { fromDockMin: 5, draftClass: 'MEDIUM' },
    },
  });

  // ── POI Zone association ──────────────────────────────────────────────────
  // Wire the three tiles to the DOCK zone so worldMap.tilesByPoi('DOCK') returns
  // them. This is consumed by structureIndex.rebuild() (H-002) and by any future
  // lake-generator tooling.
  worldMap.registerPoiZone('DOCK', ['50,48', '53,51', '48,54']);
}
