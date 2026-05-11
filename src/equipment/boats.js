/**
 * AFish Boats — src/equipment/boats.js
 *
 * Phase 4 — full implementation (D-022 stat blocks + D-067 loadout capacity).
 *
 * Public API Contract (§9 — BOATS):
 *   activeBoatStats()  → frozen stat block for the currently selected boat
 *   statsFor(boatId)   → frozen stat block for any registered boat by id
 *   canReach(poiId)    → boolean: can the active boat access this POI by draft?
 *   ALL_BOAT_IDS       → readonly array of all registered boat ids
 *
 * Multi-consumer: navigation.js, motor.js, hubShops.js, equipment.js (loadout
 * validation), fishFinder.js (finderTier), tournament.js (TOURNAMENT_BRIEFING
 * rigging surface per D-069).
 *
 * Stat block schema (D-022 + D-067):
 *  {
 *    id:                   string,  // canonical boat identifier
 *    label:                string,  // human-readable name for TTS
 *    speedTilesPerMin:     number,  // tiles/in-game-min at full outboard throttle
 *    shallowDraftMin:      number,  // minimum water depth (m) required (D-007)
 *    noiseProfile:         string,  // 'LOW' | 'MEDIUM' | 'HIGH' — fish disturbance on approach
 *    fuelType:             string,  // 'GAS' | 'NONE'
 *    fuelCapacityL:        number,  // outboard fuel tank capacity (litres)
 *    fuelPerTile:          number,  // litres consumed per tile of outboard travel
 *    windPenalty:          number,  // [0,1] fraction of wind vector applied to drift
 *    stabilityForCasting:  number,  // [0,1] platform steadiness; used by castPipeline scatter math
 *    upgradeSlots:         number,  // equipment upgrade slot count (finder, livescope, etc.)
 *    trollingStationForce: number,  // tile-units/s the trolling motor counters drift
 *    maxRods:              number,  // D-067 max rod entries in activeTackle for this boat
 *    maxLures:             number,  // D-067 max lure entries in activeTackle for this boat
 *    finderTier:           string,  // base finder tier: 'INTUITION'|'BASIC'|'MID'|'PRO'|'ELITE'
 *  }
 *
 * D-022 design tradeoff:
 *   Rowboat         — only boat that reaches SHALLOW POIs (draft 0.30 ≤ 0.50m water).
 *   Bass Boat       — cannot reach SHALLOW; opens MEDIUM POIs and faster travel.
 *   Tournament Boat — fastest + highest capacity; locked out of SHALLOW + MEDIUM POIs.
 *
 * D-067 loadout constraints:
 *   maxRods/maxLures are enforced by tournament.js during TOURNAMENT_BRIEFING rigging.
 *   Over-cap activeTackle BLOCKS modeRouter.transitionTo(TOURNAMENT_ACTIVE). (D-069)
 *
 * H-017: This module is READ-ONLY. Set-membership boundary enforcement lives in
 *   equipment.js. boats.js surfaces capacity limits only.
 */

import * as stateStore from '../core/stateStore.js';
import { getPoi, POI_DRAFT_DEPTH_M } from '../world/poiGraph.js';

// ---------------------------------------------------------------------------
// Stat blocks
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, Readonly<object>>>} */
const BOAT_STATS = Object.freeze({

  ROWBOAT: Object.freeze({
    id:                   'ROWBOAT',
    label:                'Row Boat',
    speedTilesPerMin:     4.0,
    shallowDraftMin:      0.30,   // shallowest — reaches SHALLOW POIs (≥0.50m water depth)
    noiseProfile:         'LOW',
    fuelType:             'NONE',
    fuelCapacityL:        0,
    fuelPerTile:          0,
    windPenalty:          0.30,   // most susceptible to wind drift
    stabilityForCasting:  0.70,
    upgradeSlots:         1,
    trollingStationForce: 0,      // no trolling motor; oars only
    maxRods:              2,      // D-067
    maxLures:             5,      // D-067
    finderTier:           'INTUITION', // no finder installed; Angler's Intuition baseline
  }),

  BASS_BOAT: Object.freeze({
    id:                   'BASS_BOAT',
    label:                'Bass Boat',
    speedTilesPerMin:     8.0,
    shallowDraftMin:      0.70,   // cannot reach SHALLOW POIs; opens MEDIUM POIs (≥1.00m)
    noiseProfile:         'MEDIUM',
    fuelType:             'GAS',
    fuelCapacityL:        40,
    fuelPerTile:          1.0,
    windPenalty:          0.15,
    stabilityForCasting:  0.85,
    upgradeSlots:         3,
    trollingStationForce: 2.5,
    maxRods:              6,      // D-067
    maxLures:             20,     // D-067
    finderTier:           'BASIC', // entry-level finder installed
  }),

  TOURNAMENT_BOAT: Object.freeze({
    id:                   'TOURNAMENT_BOAT',
    label:                'Tournament Boat',
    speedTilesPerMin:     12.0,
    shallowDraftMin:      1.20,   // deepest — SHALLOW + MEDIUM POIs unreachable
    noiseProfile:         'HIGH',
    fuelType:             'GAS',
    fuelCapacityL:        60,
    fuelPerTile:          1.5,
    windPenalty:          0.10,   // low-profile hull; most wind-resistant
    stabilityForCasting:  0.95,
    upgradeSlots:         5,
    trollingStationForce: 3.0,
    maxRods:              10,     // D-067
    maxLures:             40,     // D-067
    finderTier:           'ELITE', // top-tier finder pre-installed
  }),

});

// ---------------------------------------------------------------------------
// State registration
// ---------------------------------------------------------------------------

/**
 * HUB_ACTIVE_BOAT_SET — sets hub.activeBoat.
 *
 * Payload: { boatId: string }
 * Dispatched by hubShops.js on boat purchase and hubMenu.js on dock confirmation.
 * Returns state unchanged if boatId is not a registered boat (guard against
 * corrupt save data or stale references).
 */
stateStore.registerReducer('HUB_ACTIVE_BOAT_SET', (state, payload) => {
  if (!BOAT_STATS[payload.boatId]) return state;
  return {
    ...state,
    hub: {
      ...state.hub,
      activeBoat: payload.boatId,
    },
  };
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the stat block for the currently active boat.
 *
 * Reads `state.hub.activeBoat`. Throws if no boat has been selected.
 * Callers that require a safe fallback (e.g., navigation.js at cold boot)
 * should catch this and substitute ROWBOAT defaults.
 *
 * @returns {Readonly<object>} Frozen boat stat block.
 * @throws {Error} if hub.activeBoat is null or an unregistered id.
 */
export function activeBoatStats() {
  const boatId = stateStore.getState().hub.activeBoat;
  const stats   = boatId ? BOAT_STATS[boatId] : undefined;
  if (!stats) {
    throw new Error(
      `boats.activeBoatStats: no active boat selected (hub.activeBoat="${boatId}")`,
    );
  }
  return stats;
}

/**
 * Returns the stat block for a given boat id, regardless of active selection.
 * Used by hubMenu for comparison displays and by motor.initialise().
 *
 * @param {string} boatId
 * @returns {Readonly<object>} Frozen boat stat block.
 * @throws {Error} if boatId is not a registered boat.
 */
export function statsFor(boatId) {
  const stats = BOAT_STATS[boatId];
  if (!stats) {
    throw new Error(`boats.statsFor: unknown boat "${boatId}"`);
  }
  return stats;
}

/**
 * Returns whether the currently active boat can physically access a given POI.
 *
 * Accessibility is determined solely by draft: the boat may enter a POI if
 * the POI's minimum water depth >= boat.shallowDraftMin (D-022, D-007).
 *
 *   ROWBOAT (0.30m)         → SHALLOW (0.50m)? 0.30 ≤ 0.50 ✓
 *   BASS_BOAT (0.70m)       → SHALLOW (0.50m)? 0.70 > 0.50 ✗
 *   BASS_BOAT (0.70m)       → MEDIUM  (1.00m)? 0.70 ≤ 1.00 ✓
 *   TOURNAMENT_BOAT (1.20m) → MEDIUM  (1.00m)? 1.20 > 1.00 ✗
 *   TOURNAMENT_BOAT (1.20m) → DEEP    (2.00m)? 1.20 ≤ 2.00 ✓
 *
 * Returns false for unknown poiId rather than throwing; safe for list-filtering.
 * Navigation path validation (edge traversal) is handled by navigation.js.
 *
 * @param {string} poiId
 * @returns {boolean}
 */
export function canReach(poiId) {
  let stats;
  try { stats = activeBoatStats(); } catch { return false; }

  const poi = getPoi(poiId);
  if (!poi) return false;

  const waterDepthM = POI_DRAFT_DEPTH_M[poi.draftClass];
  // POI with no declared draftClass is treated as open water — all boats can reach it.
  if (waterDepthM === undefined) return true;

  return stats.shallowDraftMin <= waterDepthM;
}

/** All registered boat ids, in definition order. @readonly */
export const ALL_BOAT_IDS = Object.freeze(Object.keys(BOAT_STATS));
