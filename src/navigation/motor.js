/**
 * AFish Motor Model — src/navigation/motor.js
 *
 * Public API Contract: consume(distance) / fuelRemaining() / batteryRemaining()
 *
 * Owns the fuel and battery state for the active boat's two propulsion systems:
 *   - Outboard Motor: fuel-powered, high-speed travel between POIs (D-001).
 *   - Trolling Motor: battery-powered, low-speed station keeping (D-003).
 *
 * Motor state is held in the tournament state partition (D-019) so it resets
 * between tournaments. Fuel and battery are not persistently drained to Hub —
 * returning to dock (entering HUB mode) implicitly refills both (D-020 forbids
 * mid-tournament saves anyway, so session-end refill is the only correct timing).
 *
 * Multi-consumer (§9 Public API Contract):
 *   - navigation.js:  calls consume() for both outboard travel and trolling drift.
 *   - economy.js:     may award a "Fuel Saver" perk that reduces fuelPerTile.
 *   - audio/audioBus.js: subscribes to MOTOR_STATE_CHANGED for engine-sound transitions
 *     (fuel-low alarm, trolling hum intensity, etc.).
 *
 * Stat blocks:
 *   Fuel capacity and consumption rate live in `equipment/boats.js` (D-022).
 *   Motor reads the active boat's stat block via `boats.activeBoatStats()`.
 *   The motor module itself owns NO boat-schema knowledge — all it stores is the
 *   current level vs. capacity. This keeps motor.js isolated from equipment.js
 *   changes and prevents a cross-folder import cycle.
 *
 * State schema (stored inside state.tournament.motor via MOTOR_STATE_CHANGED):
 *   {
 *     fuelLitres:     number,   // current fuel level (outboard)
 *     fuelCapacity:   number,   // max fuel (from boat stat block at tournament start)
 *     fuelPerTile:    number,   // litres consumed per tile (from boat stat block)
 *     batteryPct:     number,   // current battery level [0, 100]
 *     batteryDrainPct:number,   // % drained per tile of trolling drift
 *     outboardActive: boolean,  // is the outboard currently in use?
 *     trollingActive: boolean,  // is the trolling motor currently active?
 *   }
 *
 * Dispatch actions owned by this module:
 *   MOTOR_STATE_CHANGED  { fuel, fuelCapacity, battery, outboardActive, trollingActive }
 *   MOTOR_FUEL_LOW       { fuelLitres, fuelCapacity, pct }  — fired at <= 20%
 *   MOTOR_BATTERY_LOW    { batteryPct }                     — fired at <= 15%
 *   MOTOR_FUEL_EMPTY     { atMs }                           — fired when fuel hits 0
 *   MOTOR_BATTERY_DEAD   { atMs }                           — fired when battery hits 0
 *
 * Thresholds for low warnings fire ONCE per crossing (not on every tick).
 * The module tracks whether the low-warning has been emitted so repeated small
 * consume() calls do not spam the bus.
 */

import * as stateStore from '../core/stateStore.js';
import * as bus        from '../core/eventBus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fuel level at or below which MOTOR_FUEL_LOW fires (fraction of capacity). */
const FUEL_LOW_THRESHOLD_PCT   = 0.20;

/** Battery percentage at or below which MOTOR_BATTERY_LOW fires. */
const BATTERY_LOW_THRESHOLD_PCT = 15;

/** Battery drain in percentage points per in-game tile of trolling drift. */
const TROLLING_DRAIN_PCT_PER_TILE = 0.5;

// ---------------------------------------------------------------------------
// Module-level warning sentinels (prevent duplicate low-warning events)
// These live at module scope (not in stateStore) because they are ephemeral
// UI concerns — losing them on a reset is correct behaviour.
// ---------------------------------------------------------------------------

let _fuelLowFired    = false;
let _batteryLowFired = false;

// ---------------------------------------------------------------------------
// State registration — stateStore reducers
// ---------------------------------------------------------------------------

stateStore.registerReducer('MOTOR_STATE_CHANGED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    motor: {
      fuelLitres:      payload.fuelLitres,
      fuelCapacity:    payload.fuelCapacity,
      fuelPerTile:     payload.fuelPerTile,
      batteryPct:      payload.batteryPct,
      batteryDrainPct: payload.batteryDrainPct,
      outboardActive:  payload.outboardActive,
      trollingActive:  payload.trollingActive,
    },
  },
}));

stateStore.registerReducer('MOTOR_INITIALISED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    motor: {
      fuelLitres:      payload.fuelCapacity,   // start full
      fuelCapacity:    payload.fuelCapacity,
      fuelPerTile:     payload.fuelPerTile,
      batteryPct:      100,                    // start full
      batteryDrainPct: TROLLING_DRAIN_PCT_PER_TILE,
      outboardActive:  false,
      trollingActive:  false,
    },
  },
}));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current motor state from the store.
 * If the motor partition hasn't been initialised yet (pre-tournament), returns a
 * safe zero-state so queries before initialisation don't throw.
 *
 * @returns {object}
 */
function _motorState() {
  const t = stateStore.getState().tournament;
  return t.motor ?? {
    fuelLitres:      0,
    fuelCapacity:    0,
    fuelPerTile:     0,
    batteryPct:      0,
    batteryDrainPct: TROLLING_DRAIN_PCT_PER_TILE,
    outboardActive:  false,
    trollingActive:  false,
  };
}

/**
 * Commit a motor state update to the store and conditionally fire low-warning events.
 *
 * @param {object} next - the full motor state object after consumption
 * @param {number} atMs - current tournament clock time (for event payloads)
 */
function _commitState(next, atMs) {
  stateStore.dispatch({ type: 'MOTOR_STATE_CHANGED', payload: next });
  bus.emit('MOTOR_STATE_CHANGED', {
    fuelLitres:     next.fuelLitres,
    fuelCapacity:   next.fuelCapacity,
    fuelPct:        next.fuelCapacity > 0 ? next.fuelLitres / next.fuelCapacity : 0,
    batteryPct:     next.batteryPct,
    outboardActive: next.outboardActive,
    trollingActive: next.trollingActive,
    atMs,
  });

  // Fuel low warning
  const fuelPct = next.fuelCapacity > 0 ? next.fuelLitres / next.fuelCapacity : 0;
  if (!_fuelLowFired && fuelPct <= FUEL_LOW_THRESHOLD_PCT && next.fuelLitres > 0) {
    _fuelLowFired = true;
    bus.emit('MOTOR_FUEL_LOW', { fuelLitres: next.fuelLitres, fuelCapacity: next.fuelCapacity, pct: fuelPct, atMs });
  }

  // Fuel empty
  if (next.fuelLitres <= 0) {
    bus.emit('MOTOR_FUEL_EMPTY', { atMs });
  }

  // Battery low warning
  if (!_batteryLowFired && next.batteryPct <= BATTERY_LOW_THRESHOLD_PCT && next.batteryPct > 0) {
    _batteryLowFired = true;
    bus.emit('MOTOR_BATTERY_LOW', { batteryPct: next.batteryPct, atMs });
  }

  // Battery dead
  if (next.batteryPct <= 0) {
    bus.emit('MOTOR_BATTERY_DEAD', { atMs });
  }
}

// ---------------------------------------------------------------------------
// Public API — initialisation (called by tournament.js on TOURNAMENT_ENTERED)
// ---------------------------------------------------------------------------

/**
 * Initialise motor state at the start of a tournament.
 * Must be called by `tournament.js` after the tournament is entered, providing
 * the fuel capacity and consumption rate from the active boat's stat block.
 *
 * Resets both warning sentinels so a fresh tournament always starts with the
 * correct low-fuel / low-battery warning behaviour.
 *
 * @param {object} boatStats - the boat stat block from `boats.activeBoatStats()`
 * @param {number} boatStats.fuelCapacityL     - tank size in litres (outboard)
 * @param {number} boatStats.fuelPerTile       - litres consumed per distance tile
 * @throws {TypeError} if boatStats is missing required fields
 */
export function initialise(boatStats) {
  if (!boatStats || typeof boatStats.fuelCapacityL !== 'number' || boatStats.fuelCapacityL < 0) {
    throw new TypeError('motor.initialise: boatStats.fuelCapacityL must be a non-negative number');
  }
  if (typeof boatStats.fuelPerTile !== 'number' || boatStats.fuelPerTile < 0) {
    throw new TypeError('motor.initialise: boatStats.fuelPerTile must be a non-negative number');
  }

  _fuelLowFired    = false;
  _batteryLowFired = false;

  stateStore.dispatch({
    type: 'MOTOR_INITIALISED',
    payload: {
      fuelCapacity: boatStats.fuelCapacityL,
      fuelPerTile:  boatStats.fuelPerTile,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API — consumption
// ---------------------------------------------------------------------------

/**
 * Consume resources for a given travel distance.
 *
 * `motorKind` determines which resource is consumed:
 *   'OUTBOARD'  — burns fuel for high-speed POI travel (D-001).
 *   'TROLLING'  — drains battery for station keeping / drift resistance (D-003).
 *   'OARS'      — no resource consumed; this call is a no-op (D-003 active oars).
 *
 * If there is insufficient fuel for a full outboard leg, the outboard cuts out
 * early: the boat travels only as far as the remaining fuel permits and then
 * switches to OARS automatically. The caller (navigation.js) is responsible for
 * detecting the shortfall via the returned `actualDistance` field and handling
 * the D-007 shallow-water partial-travel scenario.
 *
 * If the trolling motor's battery is dead, this call for 'TROLLING' is a no-op
 * (the motor cannot fight drift without power — the boat drifts freely).
 *
 * @param {number}                  distance  - tiles to travel (positive number)
 * @param {'OUTBOARD'|'TROLLING'|'OARS'} motorKind - which propulsion system to charge
 * @param {number}                  atMs      - current clock.nowMs() (for event payloads)
 * @returns {{
 *   actualDistance: number,   // tiles actually covered (may be < distance if fuel ran out)
 *   fuelUsed:       number,   // litres consumed (0 for TROLLING/OARS)
 *   batteryUsed:    number,   // percentage points consumed (0 for OUTBOARD/OARS)
 *   outOfFuel:      boolean,  // true if outboard ran dry mid-leg
 *   outOfBattery:   boolean,  // true if trolling battery hit 0
 * }}
 * @throws {TypeError} on invalid arguments
 */
export function consume(distance, motorKind, atMs) {
  if (typeof distance !== 'number' || distance < 0) {
    throw new TypeError('motor.consume: distance must be a non-negative number');
  }
  if (!['OUTBOARD', 'TROLLING', 'OARS'].includes(motorKind)) {
    throw new TypeError(`motor.consume: motorKind must be OUTBOARD, TROLLING, or OARS (got "${motorKind}")`);
  }
  if (typeof atMs !== 'number') {
    throw new TypeError('motor.consume: atMs must be a number');
  }

  if (motorKind === 'OARS' || distance === 0) {
    return { actualDistance: distance, fuelUsed: 0, batteryUsed: 0, outOfFuel: false, outOfBattery: false };
  }

  const cur = _motorState();

  if (motorKind === 'OUTBOARD') {
    if (cur.fuelLitres <= 0) {
      // Outboard already empty — cannot move at outboard speed
      return { actualDistance: 0, fuelUsed: 0, batteryUsed: 0, outOfFuel: true, outOfBattery: false };
    }

    const fuelNeeded    = distance * cur.fuelPerTile;
    const fuelAvailable = cur.fuelLitres;
    const fuelUsed      = Math.min(fuelNeeded, fuelAvailable);
    const actualDistance = cur.fuelPerTile > 0
      ? Math.min(distance, fuelAvailable / cur.fuelPerTile)
      : distance;
    const outOfFuel     = fuelUsed < fuelNeeded;

    const next = {
      ...cur,
      fuelLitres:     Math.max(0, fuelAvailable - fuelUsed),
      outboardActive: !outOfFuel, // motor cuts out if it ran dry
      trollingActive: false,
    };

    _commitState(next, atMs);
    return { actualDistance: parseFloat(actualDistance.toFixed(4)), fuelUsed, batteryUsed: 0, outOfFuel, outOfBattery: false };
  }

  // motorKind === 'TROLLING'
  if (cur.batteryPct <= 0) {
    return { actualDistance: distance, fuelUsed: 0, batteryUsed: 0, outOfFuel: false, outOfBattery: true };
  }

  const drainNeeded    = distance * cur.batteryDrainPct;
  const batteryUsed    = Math.min(drainNeeded, cur.batteryPct);
  const outOfBattery   = batteryUsed < drainNeeded;

  const next = {
    ...cur,
    batteryPct:     Math.max(0, cur.batteryPct - batteryUsed),
    trollingActive: !outOfBattery,
    outboardActive: false,
  };

  _commitState(next, atMs);
  return { actualDistance: distance, fuelUsed: 0, batteryUsed, outOfFuel: false, outOfBattery };
}

// ---------------------------------------------------------------------------
// Public API — state queries
// ---------------------------------------------------------------------------

/**
 * Returns the current fuel level in litres.
 *
 * @returns {number}
 */
export function fuelRemaining() {
  return _motorState().fuelLitres;
}

/**
 * Returns the current fuel level as a fraction of capacity [0, 1].
 * Returns 0 if the motor has not been initialised (no active tournament).
 *
 * @returns {number}
 */
export function fuelFraction() {
  const m = _motorState();
  return m.fuelCapacity > 0 ? m.fuelLitres / m.fuelCapacity : 0;
}

/**
 * Returns the current battery level as a percentage [0, 100].
 *
 * @returns {number}
 */
export function batteryRemaining() {
  return _motorState().batteryPct;
}

/**
 * Returns true if the outboard motor has enough fuel to travel `distanceTiles`.
 * Used by navigation.js before dispatching a high-speed travel request.
 *
 * @param {number} distanceTiles
 * @returns {boolean}
 */
export function canUseOutboard(distanceTiles) {
  const m = _motorState();
  if (m.fuelLitres <= 0) return false;
  return m.fuelLitres >= distanceTiles * m.fuelPerTile;
}

/**
 * Returns true if the trolling motor has remaining battery charge.
 * Used by navigation.js to decide whether passive drift resistance is possible.
 *
 * @returns {boolean}
 */
export function canUseTrolling() {
  return _motorState().batteryPct > 0;
}

/**
 * Returns the full motor state snapshot.
 * For display in HUB menus, TTS announcements, and audio level monitoring.
 *
 * @returns {object}
 */
export function snapshot() {
  const m = _motorState();
  return {
    fuelLitres:     m.fuelLitres,
    fuelCapacity:   m.fuelCapacity,
    fuelPct:        m.fuelCapacity > 0 ? m.fuelLitres / m.fuelCapacity : 0,
    batteryPct:     m.batteryPct,
    outboardActive: m.outboardActive,
    trollingActive: m.trollingActive,
  };
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Reset the low-warning sentinels.
 * FOR TESTING ONLY — simulates a fresh tournament entry without calling initialise().
 */
export function _resetWarnings() {
  _fuelLowFired    = false;
  _batteryLowFired = false;
}
