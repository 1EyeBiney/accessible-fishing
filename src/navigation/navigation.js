/**
 * AFish Navigation — src/navigation/navigation.js
 *
 * Public API Contract: requestTravel(poiId) / driftStep(dt) / station(mode)
 *
 * Sole owner of boat position. All updates to `state.session.player.microOffset`
 * and `state.session.player.currentPoiId` flow through this module and NOWHERE else.
 *
 * Responsibilities:
 *  1. POI fast-travel (`requestTravel`) — outboard-powered inter-POI movement.
 *  2. Frame-local micro-drift physics (`driftStep`) — the continuous vector pipeline (H-001).
 *  3. Station-keeping mode (`station`) — active oars vs passive trolling motor (D-003).
 *  4. D-040 Frame-Boundary Penalty — if integrated drift exceeds `frameRadius`, snap
 *     boat back and advance the tournament clock by exactly 5 in-game minutes.
 *  5. D-007 Shallow-Water Override — block high-speed outboard travel when the current
 *     tile's depth is below the active boat's `shallowDraftMin`.
 *
 * H-001 Vector Resolution Order (LOCKED — Red Team v1.13):
 *   The drift pipeline resolves forces in this strict sequence each driftStep():
 *     Step 1: WIND PUSH   — apply wind.sample(atMs) push vector (wind blows the boat)
 *     Step 2: CURRENT     — apply per-POI current vector (from worldMap tile or POI spec)
 *     Step 3: STATION     — subtract station-keeping force (oars or trolling motor)
 *     Step 4: INTEGRATE   — add net vector × dt to microOffset
 *     Step 5: BOUNDARY    — clamp to frameRadius and apply D-040 penalty if exceeded
 *   No module may reorder these steps. Changes require a brief amendment.
 *
 * State schema (in session partition per D-019):
 *   state.session.player.currentPoiId    — which POI the boat is at
 *   state.session.player.microOffset     — { dx, dy } from the POI's centerCoord
 *   state.session.player.anchored        — true when station(OARS) is engaged
 *
 * Additional tournament-scoped navigation state (not directly part of §9 session schema):
 *   state.tournament.nav.stationMode     — 'OARS' | 'TROLLING' | 'NONE'
 *   state.tournament.nav.travelling      — true while requestTravel is in progress
 *   state.tournament.nav.travelTarget    — poiId being travelled to (or null)
 *
 * Dispatch actions owned by this module:
 *   PLAYER_ARRIVED_AT_POI       { poiId, microOffset:{dx,dy}, anchored }
 *   PLAYER_MICRO_DRIFTED        { microOffset:{dx,dy} }
 *   REPOSITIONING_PENALTY       { penaltyMs, newOffset:{dx,dy}, atMs }
 *   TRAVEL_STARTED              { fromPoiId, toPoiId, distanceTiles, travelTimeMs, atMs }
 *   TRAVEL_COMPLETED            { poiId, atMs }
 *   TRAVEL_BLOCKED_SHALLOW      { fromPoiId, toPoiId, reason, atMs }
 *   TRAVEL_BLOCKED_NO_FUEL      { fromPoiId, toPoiId, atMs }
 *   STATION_MODE_CHANGED        { mode, atMs }
 *
 * Cross-folder dependencies (imports):
 *   core/clock.js        — clock.tick() for D-040 repositioning penalty; clock.nowMs()
 *   core/stateStore.js   — getState / dispatch / registerReducer
 *   core/eventBus.js     — bus.emit for navigation events
 *   navigation/wind.js   — wind.sample(atMs) — H-001 Step 1
 *   navigation/motor.js  — motor.consume() / motor.canUseOutboard() — D-007 / motor drain
 *   world/worldMap.js    — getTile() for tile-depth check (D-007); tilesByPoi() for current
 *   world/poiGraph.js    — edge() / getPoi() for route validation and travel-time math
 *   equipment/boats.js   — activeBoatStats() for draft, speed, windPenalty, stationForce
 *
 * Note on equipment/boats.js:
 *   boats.js is a Phase 3 file (§12 roadmap). It is imported defensively below —
 *   if the module is not yet available (during harness integration with Phase 2 only),
 *   navigation falls back to a ROWBOAT default stat block. Full boats.js is delivered
 *   as part of Phase 3 alongside this file.
 */

import * as clock      from '../core/clock.js';
import * as stateStore from '../core/stateStore.js';
import * as bus        from '../core/eventBus.js';
import * as wind       from './wind.js';
import * as motor      from './motor.js';
import * as worldMap   from '../world/worldMap.js';
import * as poiGraph   from '../world/poiGraph.js';
import * as boats      from '../equipment/boats.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * D-040: Repositioning penalty in in-game milliseconds.
 * Applied via clock.tick() when integrated drift exceeds the POI's frameRadius.
 * Fixed at 5 in-game minutes for v0.1 (not scaled by overshoot magnitude).
 */
const REPOSITIONING_PENALTY_MS = 5 * 60 * 1000;

/**
 * Station-keeping force in tile-units per in-game second.
 * Represents the maximum drift counteracted per second by active oars or trolling motor.
 * Tuned so a moderate wind (3 m/s) is fully countered by active oars.
 *
 * The effective force applied is:
 *   oars:     OARS_STATION_FORCE (full, no resource cost)
 *   trolling: boatStats.trollingStationForce (from stat block; partial if battery low)
 *   none:     0
 */
const OARS_STATION_FORCE = 3.0; // tile-units per second

/**
 * Scale factor: wind intensity (m/s) → tile-units per second of drift force.
 * At MAX_WIND_INTENSITY_MS = 6.0, boats drift at 6 * WIND_DRIFT_SCALE tile-units/s.
 * Tuned so even severe wind is manageable with the trolling motor engaged.
 */
const WIND_DRIFT_SCALE = 0.25;

/**
 * Scale factor: per-POI current intensity → tile-units per second.
 * Currents are weaker than wind; they provide directional pressure, not displacement.
 */
const CURRENT_DRIFT_SCALE = 0.12;

/**
 * Minimum tile depth in metres before D-007 Shallow Water Override fires.
 * Compared against the active boat's shallowDraftMin from its stat block.
 * This constant is the absolute floor — stat blocks may raise this per-boat.
 */
const SHALLOW_OVERRIDE_MIN_DEPTH_M = 0.3;

// ---------------------------------------------------------------------------
// State registration
// ---------------------------------------------------------------------------

stateStore.registerReducer('NAV_STATE_CHANGED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    nav: {
      stationMode:  payload.stationMode,
      travelling:   payload.travelling,
      travelTarget: payload.travelTarget,
    },
  },
}));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the navigation sub-state from the tournament partition.
 * Provides a safe default if the sub-state hasn't been initialised yet.
 *
 * @returns {{ stationMode: string, travelling: boolean, travelTarget: string|null }}
 */
function _navState() {
  const t = stateStore.getState().tournament;
  return t.nav ?? { stationMode: 'NONE', travelling: false, travelTarget: null };
}

/**
 * Returns the active player session state.
 *
 * @returns {{ currentPoiId: string|null, microOffset: {dx,dy}, anchored: boolean }}
 */
function _playerState() {
  return stateStore.getState().session.player;
}

/**
 * Commits a new microOffset to the store and emits PLAYER_MICRO_DRIFTED.
 * The SOLE writer of state.session.player.microOffset.
 *
 * @param {{ dx: number, dy: number }} newOffset
 */
function _setMicroOffset(newOffset) {
  stateStore.dispatch({
    type:    'PLAYER_MICRO_DRIFTED',
    payload: { microOffset: { dx: newOffset.dx, dy: newOffset.dy } },
  });
  bus.emit('PLAYER_MICRO_DRIFTED', { microOffset: { dx: newOffset.dx, dy: newOffset.dy } });
}

/**
 * Returns the active boat's stat block, with a safe ROWBOAT fallback.
 *
 * @returns {object}
 */
function _boatStats() {
  try {
    return boats.activeBoatStats();
  } catch {
    // Fallback for testing before boats.js is fully wired
    return {
      speedTilesPerMin:    4.0,
      shallowDraftMin:     0.30,
      windPenalty:         0.20,
      trollingStationForce: 2.0,
      fuelCapacityL:       20,
      fuelPerTile:         0.5,
      fuelType:            'GAS',
    };
  }
}

/**
 * Retrieve the current flow (current) vector for the active POI.
 * Per D-037, per-tile flow is removed from v0.1; flow is per-POI only.
 * The current vector is stored as `poi.flow` if provided by the lake generator.
 * Returns a zero vector if the POI has no flow data.
 *
 * @param {string} poiId
 * @returns {{ dx: number, dy: number, intensityMs: number }}
 */
function _poiCurrentVector(poiId) {
  const poi = poiGraph.getPoi(poiId);
  if (!poi || !poi.flow) {
    return { dx: 0, dy: 0, intensityMs: 0 };
  }
  return poi.flow;
}

/**
 * Apply the D-040 repositioning penalty.
 * Snaps the boat back to a safe offset (half the frameRadius toward origin)
 * and advances the tournament clock by exactly REPOSITIONING_PENALTY_MS.
 *
 * @param {number}                  frameRadius - POI's frameRadius in tiles
 * @param {{ dx: number, dy: number }} rawOffset  - the out-of-bounds offset
 * @param {number}                  atMs         - current clock.nowMs()
 * @returns {{ dx: number, dy: number }}          the snapped offset
 */
function _applyRepositioningPenalty(frameRadius, rawOffset, atMs) {
  // Snap to 50% of frameRadius toward origin, preserving direction
  const len = Math.hypot(rawOffset.dx, rawOffset.dy);
  const scale = len > 0 ? (frameRadius * 0.5) / len : 0;
  const snapped = { dx: rawOffset.dx * scale, dy: rawOffset.dy * scale };

  // Advance the tournament clock by the penalty (D-040).
  // clock.tick() drives the same callback path used in live play (H-008).
  clock.tick(REPOSITIONING_PENALTY_MS);

  bus.emit('REPOSITIONING_PENALTY', {
    penaltyMs:   REPOSITIONING_PENALTY_MS,
    newOffset:   snapped,
    rawOffset,
    atMs,
  });
  stateStore.dispatch({
    type:    'PLAYER_MICRO_DRIFTED',
    payload: { microOffset: snapped },
  });

  return snapped;
}

/**
 * Clamp the microOffset to the POI's frameRadius.
 * Returns the (potentially snapped) offset and a flag indicating a boundary was crossed.
 *
 * @param {{ dx: number, dy: number }} offset
 * @param {number}                    frameRadius
 * @returns {{ offset: { dx: number, dy: number }, exceeded: boolean }}
 */
function _clampToFrame(offset, frameRadius) {
  const dist = Math.hypot(offset.dx, offset.dy);
  if (dist <= frameRadius) {
    return { offset, exceeded: false };
  }
  // Clamp to the exact boundary circle
  const scale = frameRadius / dist;
  return {
    offset:   { dx: offset.dx * scale, dy: offset.dy * scale },
    exceeded: true,
  };
}

/**
 * Get the tile at the boat's current position (POI centerCoord + microOffset).
 * Returns undefined if no water tile exists at that coordinate.
 *
 * @param {string}               poiId
 * @param {{ dx: number, dy: number }} microOffset
 * @returns {object|undefined}
 */
function _currentTile(poiId, microOffset) {
  const poi = poiGraph.getPoi(poiId);
  if (!poi) return undefined;
  const x = Math.round(poi.centerCoord.x + microOffset.dx);
  const y = Math.round(poi.centerCoord.y + microOffset.dy);
  return worldMap.getTile({ x, y });
}

// ---------------------------------------------------------------------------
// Public API — station keeping
// ---------------------------------------------------------------------------

/**
 * Set the active station-keeping mode.
 *
 * Modes:
 *   'OARS'     — active oars; full counter-drift force; no resource cost.
 *                Sets state.session.player.anchored = true.
 *   'TROLLING' — passive trolling motor; drains battery; resource-limited force.
 *                Sets anchored = false (boat may still drift if battery dies).
 *   'NONE'     — no active station keeping; boat drifts freely.
 *                Sets anchored = false.
 *
 * H-010: station mode changes do NOT need to call inputAdapter.releaseAll() —
 * that is the modeRouter's responsibility on full mode transitions. Held movement
 * inputs are handled by the input subsystem independently.
 *
 * @param {'OARS'|'TROLLING'|'NONE'} mode
 * @throws {TypeError} if mode is not a valid station mode
 */
export function station(mode) {
  if (!['OARS', 'TROLLING', 'NONE'].includes(mode)) {
    throw new TypeError(`navigation.station: mode must be OARS, TROLLING, or NONE (got "${mode}")`);
  }

  const atMs     = clock.nowMs();
  const anchored = mode === 'OARS';

  stateStore.dispatch({
    type:    'NAV_STATE_CHANGED',
    payload: { ..._navState(), stationMode: mode },
  });
  stateStore.dispatch({
    type:    'PLAYER_ANCHOR_CHANGED',
    payload: { anchored },
  });
  bus.emit('STATION_MODE_CHANGED', { mode, anchored, atMs });
}

// ---------------------------------------------------------------------------
// Public API — driftStep (H-001 vector pipeline)
// ---------------------------------------------------------------------------

/**
 * Advance the boat's micro-drift position by one physics step.
 *
 * Must be called on a regular interval by the physics tick source.
 * In Phase 3, this is typically wired to `clock.every(DRIFT_TICK_MS, ...)` inside
 * a tournament-mode mount manifest. The mount manifest cancels the handle on unmount
 * (H-005), so driftStep stops automatically when leaving TOURNAMENT_ACTIVE.
 *
 * `dt` is the elapsed in-game time since the last driftStep call, in SECONDS.
 * Using dt (not a fixed frame rate) makes the physics frame-rate independent
 * and ensures identical results in manual (test) and realtime (live) clock modes.
 *
 * H-001 Pipeline (LOCKED):
 *   Step 1 — Wind push:    wind.sample(atMs) gives intensity and direction.
 *             The boat is pushed OPPOSITE the FROM direction (downwind drift).
 *             Force = intensityMs × WIND_DRIFT_SCALE × boatStats.windPenalty
 *   Step 2 — Current push: per-POI flow vector from poiGraph.
 *             Force = intensityMs × CURRENT_DRIFT_SCALE
 *   Step 3 — Station keeping: subtract counter-force based on stationMode.
 *             OARS: clamp net dx/dy toward zero by OARS_STATION_FORCE × dt
 *             TROLLING: same logic but force limited by boatStats.trollingStationForce;
 *               also calls motor.consume(drift, 'TROLLING', atMs) proportionally.
 *             NONE: no subtraction.
 *   Step 4 — Integrate:    newOffset = currentOffset + netVelocity × dt
 *   Step 5 — Boundary:     clamp to frameRadius; if exceeded, apply D-040 penalty.
 *
 * @param {number} dt - elapsed time in in-game SECONDS (positive, typically 0.05–1.0)
 */
export function driftStep(dt) {
  if (typeof dt !== 'number' || dt <= 0) return;

  const player = _playerState();
  const nav    = _navState();

  // Cannot drift while travelling between POIs
  if (nav.travelling || !player.currentPoiId) return;

  const poiId     = player.currentPoiId;
  const poi       = poiGraph.getPoi(poiId);
  if (!poi) return;

  const atMs      = clock.nowMs();
  const boatStats = _boatStats();
  let { dx, dy }  = player.microOffset;

  // ── Step 1: Wind Push ────────────────────────────────────────────────────
  // wind.sample() gives the FROM direction. The boat is pushed DOWNWIND (opposite).
  const w             = wind.sample(atMs);
  const windForceMag  = w.intensityMs * WIND_DRIFT_SCALE * (boatStats.windPenalty ?? 0.2);
  // Push direction is opposite of FROM vector: (-w.dx, -w.dy)
  const windDx        = -w.dx * windForceMag;
  const windDy        = -w.dy * windForceMag;

  // ── Step 2: Current Push ─────────────────────────────────────────────────
  const current       = _poiCurrentVector(poiId);
  const currentDx     = current.dx * current.intensityMs * CURRENT_DRIFT_SCALE;
  const currentDy     = current.dy * current.intensityMs * CURRENT_DRIFT_SCALE;

  // ── Step 3: Station Keeping ──────────────────────────────────────────────
  // Net velocity before station keeping (tile-units per second)
  let velDx = windDx + currentDx;
  let velDy = windDy + currentDy;

  if (nav.stationMode !== 'NONE') {
    let stationForce;
    if (nav.stationMode === 'OARS') {
      stationForce = OARS_STATION_FORCE;
    } else {
      // TROLLING
      if (motor.canUseTrolling()) {
        stationForce = boatStats.trollingStationForce ?? OARS_STATION_FORCE * 0.67;
        // Drain battery proportional to the actual drift distance being countered.
        // Use a normalised tile distance so the drain is frame-rate independent.
        const countered = Math.min(Math.hypot(velDx, velDy), stationForce) * dt;
        motor.consume(countered, 'TROLLING', atMs);
      } else {
        // Battery dead — trolling motor provides no force
        stationForce = 0;
      }
    }

    // Counter-force opposes the current velocity vector.
    // If stationForce > netVelocity magnitude, the boat is effectively stationary.
    const velMag = Math.hypot(velDx, velDy);
    if (velMag > 0 && stationForce > 0) {
      const reduction = Math.min(stationForce, velMag);
      const reduceScale = reduction / velMag;
      velDx -= velDx * reduceScale;
      velDy -= velDy * reduceScale;
    }
  }

  // ── Step 4: Integrate ────────────────────────────────────────────────────
  const newDx = dx + velDx * dt;
  const newDy = dy + velDy * dt;
  const rawNewOffset = { dx: newDx, dy: newDy };

  // ── Step 5: Boundary Check (D-040) ───────────────────────────────────────
  const { offset: clampedOffset, exceeded } = _clampToFrame(rawNewOffset, poi.frameRadius);

  if (exceeded) {
    const finalOffset = _applyRepositioningPenalty(poi.frameRadius, rawNewOffset, atMs);
    // Penalty dispatch already called _setMicroOffset via the penalty handler.
    // No need to call _setMicroOffset again; just return.
    void finalOffset;
    return;
  }

  // Normal drift — commit the new offset
  if (Math.abs(clampedOffset.dx - dx) > 0.0001 || Math.abs(clampedOffset.dy - dy) > 0.0001) {
    _setMicroOffset(clampedOffset);
  }
}

// ---------------------------------------------------------------------------
// Public API — POI fast travel
// ---------------------------------------------------------------------------

/**
 * Request high-speed travel to a destination POI via the outboard motor.
 *
 * Validation sequence:
 *   1. Target POI must be registered in poiGraph and different from current POI.
 *   2. An edge must exist between current POI and target POI.
 *   3. D-007 Shallow Water Override: if the current tile depth < boat.shallowDraftMin,
 *      the outboard is blocked (too shallow to safely power the motor).
 *   4. Edge traversability: poiGraph.canTraverseEdge(from, to, boatDraftM) must pass
 *      (see poiGraph.js D-022 bilateral draft filtering).
 *   5. Sufficient fuel: motor.canUseOutboard(edgeDistanceTiles) must be true.
 *
 * If all checks pass:
 *   - Dispatches TRAVEL_STARTED.
 *   - Consumes fuel for the full edge distance via motor.consume().
 *   - Advances the tournament clock by the calculated travel time.
 *   - Dispatches PLAYER_ARRIVED_AT_POI with zero microOffset (boat arrives at centre).
 *   - Dispatches TRAVEL_COMPLETED.
 *
 * Travel time calculation (D-022):
 *   baseTimeMs = edge.travelTimeMinBase × 60000
 *   boatSpeedFactor = boatStats.speedTilesPerMin / REFERENCE_SPEED_TILES_PER_MIN
 *   actualTimeMs = baseTimeMs / boatSpeedFactor
 *   (Faster boats = shorter actual time for the same route)
 *
 * @param {string} toPoiId - destination POI id
 * @returns {{ success: boolean, reason: string|null }} — result of the travel attempt
 */
export function requestTravel(toPoiId) {
  const player    = _playerState();
  const fromPoiId = player.currentPoiId;
  const atMs      = clock.nowMs();

  if (!fromPoiId) {
    return { success: false, reason: 'NO_ACTIVE_POI' };
  }
  if (fromPoiId === toPoiId) {
    return { success: false, reason: 'SAME_POI' };
  }
  if (!poiGraph.getPoi(toPoiId)) {
    return { success: false, reason: 'UNKNOWN_DESTINATION' };
  }

  const edgeObj = poiGraph.edge(fromPoiId, toPoiId);
  if (!edgeObj) {
    return { success: false, reason: 'NO_EDGE' };
  }

  const boatStats  = _boatStats();
  const boatDraftM = boatStats.shallowDraftMin ?? 0.3;

  // ── D-007 Shallow Water Override ─────────────────────────────────────────
  // Check the depth at the current tile before allowing outboard activation.
  const curTile = _currentTile(fromPoiId, player.microOffset);
  const curDepthM = curTile ? curTile.traits.depth.minM : SHALLOW_OVERRIDE_MIN_DEPTH_M;
  if (curDepthM < (boatStats.shallowDraftMin ?? SHALLOW_OVERRIDE_MIN_DEPTH_M)) {
    bus.emit('TRAVEL_BLOCKED_SHALLOW', {
      fromPoiId,
      toPoiId,
      reason:   'CURRENT_TILE_TOO_SHALLOW',
      depthM:   curDepthM,
      draftMin: boatStats.shallowDraftMin,
      atMs,
    });
    return { success: false, reason: 'SHALLOW_OVERRIDE' };
  }

  // ── D-022 Edge Traversability ─────────────────────────────────────────────
  if (!poiGraph.canTraverseEdge(fromPoiId, toPoiId, boatDraftM)) {
    bus.emit('TRAVEL_BLOCKED_SHALLOW', {
      fromPoiId,
      toPoiId,
      reason:   'EDGE_NOT_TRAVERSABLE',
      boatDraftM,
      atMs,
    });
    return { success: false, reason: 'EDGE_NOT_TRAVERSABLE' };
  }

  // ── Fuel Check ───────────────────────────────────────────────────────────
  if (!motor.canUseOutboard(edgeObj.distanceTiles)) {
    bus.emit('TRAVEL_BLOCKED_NO_FUEL', { fromPoiId, toPoiId, atMs });
    return { success: false, reason: 'INSUFFICIENT_FUEL' };
  }

  // ── Begin Travel ─────────────────────────────────────────────────────────
  // Reference speed for time calculation: 4 tiles/min = 240 tiles/hr
  // Actual time scales inversely with the boat's speedTilesPerMin.
  const REFERENCE_SPEED = 4.0; // tiles per minute (rowboat reference)
  const speedFactor     = (boatStats.speedTilesPerMin ?? REFERENCE_SPEED) / REFERENCE_SPEED;
  const baseTimeMs      = edgeObj.travelTimeMinBase * 60_000;
  const travelTimeMs    = Math.round(baseTimeMs / speedFactor);

  stateStore.dispatch({
    type:    'NAV_STATE_CHANGED',
    payload: { stationMode: _navState().stationMode, travelling: true, travelTarget: toPoiId },
  });

  bus.emit('TRAVEL_STARTED', {
    fromPoiId,
    toPoiId,
    distanceTiles: edgeObj.distanceTiles,
    travelTimeMs,
    atMs,
  });

  // Consume fuel for the trip
  motor.consume(edgeObj.distanceTiles, 'OUTBOARD', atMs);

  // Advance the tournament clock by travel time (D-001, H-008 same-path rule).
  // clock.tick() fires any scheduled callbacks that fire within the travel window —
  // this is correct behaviour (AI bots may catch fish while the player is travelling).
  clock.tick(travelTimeMs);

  const arrivalAtMs = clock.nowMs();

  // Arrive at destination with zero micro-offset (centre of the new POI frame)
  stateStore.dispatch({
    type:    'PLAYER_ARRIVED_AT_POI',
    payload: { poiId: toPoiId, microOffset: { dx: 0, dy: 0 }, anchored: false },
  });
  stateStore.dispatch({
    type:    'NAV_STATE_CHANGED',
    payload: { stationMode: 'NONE', travelling: false, travelTarget: null },
  });

  bus.emit('TRAVEL_COMPLETED', { fromPoiId, toPoiId, travelTimeMs, atMs: arrivalAtMs });
  bus.emit('PLAYER_ARRIVED_AT_POI', { poiId: toPoiId, microOffset: { dx: 0, dy: 0 }, atMs: arrivalAtMs });

  return { success: true, reason: null };
}

// ---------------------------------------------------------------------------
// Public API — micro-offset manual override (numpad input, D-002)
// ---------------------------------------------------------------------------

/**
 * Apply a manual directional nudge to the boat's micro-offset.
 *
 * Called by the input handler when the player presses a numpad direction key
 * (D-002: 8-way numpad micro-drifting). This is the oars-active path — the player
 * is explicitly repositioning within the POI frame.
 *
 * The nudge is expressed as a unit-vector direction and a magnitude in tiles.
 * The frame boundary check (D-040) applies — if the nudge would push the boat
 * outside frameRadius, the penalty fires.
 *
 * @param {number} dx       - directional component in tile units (e.g. -1, 0, +1)
 * @param {number} dy       - directional component in tile units
 * @param {number} magnitude - distance in tiles to nudge (default 1.0)
 */
export function nudge(dx, dy, magnitude = 1.0) {
  const player    = _playerState();
  const poiId     = player.currentPoiId;
  if (!poiId) return;

  const poi = poiGraph.getPoi(poiId);
  if (!poi) return;

  const atMs = clock.nowMs();

  // Normalise the direction vector
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const normDx = (dx / len) * magnitude;
  const normDy = (dy / len) * magnitude;

  const rawOffset = {
    dx: player.microOffset.dx + normDx,
    dy: player.microOffset.dy + normDy,
  };

  const { offset: clampedOffset, exceeded } = _clampToFrame(rawOffset, poi.frameRadius);

  if (exceeded) {
    _applyRepositioningPenalty(poi.frameRadius, rawOffset, atMs);
    return;
  }

  _setMicroOffset(clampedOffset);
}

// ---------------------------------------------------------------------------
// Public API — query helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current microOffset of the boat within the active POI frame.
 *
 * @returns {{ dx: number, dy: number }}
 */
export function currentOffset() {
  return { ..._playerState().microOffset };
}

/**
 * Returns the currently active POI id, or null if no POI is active.
 *
 * @returns {string|null}
 */
export function currentPoiId() {
  return _playerState().currentPoiId;
}

/**
 * Returns true if the boat is currently mid-travel between POIs.
 *
 * @returns {boolean}
 */
export function isTravelling() {
  return _navState().travelling;
}

/**
 * Teleport the boat to a POI without travel time or fuel cost.
 * FOR TESTING / TOURNAMENT START ONLY.
 * In production, only `tournament.js` calls this to place the player at the start
 * dock when a tournament begins. Callers must hold responsibility for its effects.
 *
 * @param {string}               poiId
 * @param {{ dx: number, dy: number }} [microOffset={ dx: 0, dy: 0 }]
 */
export function placeAt(poiId, microOffset = { dx: 0, dy: 0 }) {
  if (!poiGraph.getPoi(poiId)) {
    throw new Error(`navigation.placeAt: unknown POI "${poiId}"`);
  }
  stateStore.dispatch({
    type:    'PLAYER_ARRIVED_AT_POI',
    payload: { poiId, microOffset, anchored: false },
  });
  stateStore.dispatch({
    type:    'NAV_STATE_CHANGED',
    payload: { stationMode: 'NONE', travelling: false, travelTarget: null },
  });
  bus.emit('PLAYER_ARRIVED_AT_POI', { poiId, microOffset, atMs: clock.nowMs() });
}
