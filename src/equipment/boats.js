/**
 * AFish Boats — src/equipment/boats.js
 *
 * Phase 4 stub (full implementation deferred to Phase 4 per §12 roadmap).
 *
 * Provides the stat blocks for all playable boats and the `activeBoatStats()`
 * entry point consumed by navigation.js, motor.js, and UI layers.
 *
 * Stat block schema (D-022):
 *  {
 *    id:                   string,  // canonical boat identifier
 *    label:                string,  // human-readable name for TTS
 *    speedTilesPerMin:     number,  // tiles traversed per in-game minute at full throttle
 *    shallowDraftMin:      number,  // minimum water depth (m) for outboard operation (D-007)
 *    windPenalty:          number,  // multiplier [0,1] — how much wind affects this boat's drift
 *    trollingStationForce: number,  // tile-units/s the trolling motor can counter drift
 *    fuelCapacityL:        number,  // outboard fuel tank size in litres
 *    fuelPerTile:          number,  // litres consumed per tile of outboard travel
 *    fuelType:             string,  // 'GAS' | 'NONE'
 *    stabilityForCasting:  number,  // [0,1] — platform steadiness while casting
 *    noiseProfile:         string,  // 'LOW' | 'MEDIUM' | 'HIGH' — fish disturbance
 *    upgradeSlots:         number,  // number of equipment upgrade slots
 *  }
 *
 * HUB_ACTIVE_BOAT_SET dispatch action:
 *   payload: { boatId: string }
 *   Sets hub.activeBoat and causes activeBoatStats() to return that boat's stat block.
 *   Dispatched by hubMenu.js when the player changes boats at the dock.
 */

import * as stateStore from '../core/stateStore.js';

// ---------------------------------------------------------------------------
// Stat blocks
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, object>>} */
const BOAT_STATS = Object.freeze({
  ROWBOAT: Object.freeze({
    id:                   'ROWBOAT',
    label:                'Row Boat',
    speedTilesPerMin:     4.0,
    shallowDraftMin:      0.30,
    windPenalty:          0.30,
    trollingStationForce: 0,       // no trolling motor; use OARS for station keeping
    fuelCapacityL:        0,
    fuelPerTile:          0,
    fuelType:             'NONE',
    stabilityForCasting:  0.70,
    noiseProfile:         'LOW',
    upgradeSlots:         1,
  }),

  BASS_BOAT: Object.freeze({
    id:                   'BASS_BOAT',
    label:                'Bass Boat',
    speedTilesPerMin:     8.0,
    shallowDraftMin:      0.70,
    windPenalty:          0.15,
    trollingStationForce: 2.5,
    fuelCapacityL:        40,
    fuelPerTile:          1.0,
    fuelType:             'GAS',
    stabilityForCasting:  0.85,
    noiseProfile:         'MEDIUM',
    upgradeSlots:         3,
  }),

  TOURNAMENT_BOAT: Object.freeze({
    id:                   'TOURNAMENT_BOAT',
    label:                'Tournament Boat',
    speedTilesPerMin:     12.0,
    shallowDraftMin:      1.20,
    windPenalty:          0.10,
    trollingStationForce: 3.0,
    fuelCapacityL:        60,
    fuelPerTile:          1.5,
    fuelType:             'GAS',
    stabilityForCasting:  0.95,
    noiseProfile:         'HIGH',
    upgradeSlots:         5,
  }),
});

// ---------------------------------------------------------------------------
// State registration
// ---------------------------------------------------------------------------

stateStore.registerReducer('HUB_ACTIVE_BOAT_SET', (state, payload) => ({
  ...state,
  hub: {
    ...state.hub,
    activeBoat: payload.boatId,
  },
}));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the stat block for the currently active boat.
 *
 * Reads `state.hub.activeBoat` from the store. Throws if no boat is selected
 * (which causes navigation.js's `_boatStats()` try/catch to use the fallback
 * rowboat defaults — safe for pre-Hub gameplay and test harness phases).
 *
 * @returns {object} boat stat block (frozen)
 * @throws {Error} if hub.activeBoat is null or not a known boat id
 */
export function activeBoatStats() {
  const boatId = stateStore.getState().hub.activeBoat;
  if (!boatId || !BOAT_STATS[boatId]) {
    throw new Error(
      `boats.activeBoatStats: no active boat selected (hub.activeBoat="${boatId}")`,
    );
  }
  return BOAT_STATS[boatId];
}

/**
 * Returns the stat block for a given boat id, regardless of active selection.
 * Used by hubMenu.js for comparison displays and by motor.initialise().
 *
 * @param {string} boatId
 * @returns {object} boat stat block (frozen)
 * @throws {Error} if boatId is not a registered boat
 */
export function statsFor(boatId) {
  const stats = BOAT_STATS[boatId];
  if (!stats) {
    throw new Error(`boats.statsFor: unknown boat "${boatId}"`);
  }
  return stats;
}

/** All registered boat ids, in definition order. */
export const ALL_BOAT_IDS = Object.freeze(Object.keys(BOAT_STATS));
