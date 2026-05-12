/**
 * AFish State Store — src/core/stateStore.js
 *
 * Public API Contract: getState / dispatch / subscribe
 *
 * The single mutation path for all engine state (D-019, §5).
 * Direct property writes on objects returned by getState() are FORBIDDEN.
 * All state changes must flow through dispatch({ type, payload }).
 *
 * State partitions (D-019):
 *   profile    — persistent on-disk player data (serialised by profileStore)
 *   hub        — carried between tournaments (wallet, owned gear, owned boat)
 *   tournament — disposable per-run state (reset on each TOURNAMENT_ENTERED)
 *   session    — ephemeral UI/focus state (never persisted)
 *
 * Design notes:
 *  - Reducer pattern: dispatch finds a registered reducer for action.type, calls it
 *    with (state, payload), and replaces _state with the result.
 *  - Reducers must be pure: (state, payload) => newState. No side effects.
 *  - Subscribers are called synchronously after each state change, before the
 *    STATE_CHANGED bus event fires. This ordering ensures internal subscribers
 *    (e.g. modeRouter) see the new state before audio subscribers do.
 *  - registerReducer() is the extension point for later phases. Phase 0 provides
 *    reducers for all infrastructure action types the harness exercises.
 *  - _reset() is a test-only helper to restore initial state between harness runs.
 */

import * as bus from './eventBus.js';

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

/**
 * Returns a fresh initial state object.
 * Called once at module load and by _reset() in tests.
 *
 * @returns {object}
 */
function _initialState() {
  return {
    /** Current game mode (D-017). ONLY modeRouter mutates this via 'MODE_CHANGED'. */
    mode: 'BOOT',

    /**
     * Persistent profile — serialised to/from disk by profileStore (D-024).
     * globalSeed is used by rng.seed() on session start.
     */
    profile: {
      id:          null,
      displayName: null,
      settings: {
        ttsRate: 1.0,
        volume:  1.0,
      },
      globalSeed: 42, // overwritten by PROFILE_LOADED
    },

    /**
     * Hub partition — carried between tournaments (D-019).
     * activeTackle is set during TOURNAMENT_BRIEFING via ACTIVE_TACKLE_SET,
     * then frozen into tournament.activeTackle on TOURNAMENT_ENTERED (H-017).
     */
    hub: {
      money:      0,
      activeBoat: null, // string boat-id, e.g. 'ROWBOAT'
      inventory: {
        rods:  [], // [{ id: string, durability: number }]
        lures: [], // [{ id: string, durability: number }]
        bait:  [], // [{ id: string, count: number, vigor: number }]
      },
      activeTackle: null, // { rods: [...], lures: [...], bait: [...] } — set in BRIEFING
    },

    /**
     * Tournament partition — reset on each TOURNAMENT_ENTERED (D-019).
     * activeTackle here is a frozen deep-copy of hub.activeTackle (H-017).
     * Set-membership of activeTackle is read-only during TOURNAMENT_ACTIVE;
     * per-item state (durability, vigor) writes continue via ITEM_DAMAGED (H-017).
     *
     * lastTarget (D-073): the most recently locked cast target. Survives CAST_LANDED
     * so castPipeline can offer a re-cast shortcut. Cleared on new TARGET_LOCKED,
     * FISH_FINDER_SCAN_STARTED, PLAYER_ARRIVED_AT_POI, and tournament end.
     */
    tournament: {
      id:           null,
      spec:         null,  // snapshot of the tournament spec at entry time
      scanLocked:   false, // D-043 — set by castPipeline/fightLoop; read by fishFinder/targetSelector
      cast:         null,  // active 5-tap cast phase state managed by castPipeline
      activeTackle: null,  // frozen copy of hub.activeTackle (H-017 set-membership frozen)
      lastTarget:   null,  // D-073 — { poiId, offset, candidateId, lockedAtMs, finderTier, recastCount }
    },

    /**
     * Session partition — ephemeral, never persisted (D-019).
     * Tracks live player position for navigation feedback.
     *
     * currentPoiId defaults to 'DOCK' so that scan() and other POI-bound
     * subsystems do not silently fail before navigation/tournament code
     * has had a chance to seed a real starting POI. The HUB→TOURNAMENT
     * transition (Phase 7) will overwrite this via PLAYER_ARRIVED_AT_POI
     * with the tournament's actual launch POI.
     */
    session: {
      player: {
        currentPoiId: 'DOCK',
        microOffset:  { dx: 0, dy: 0 },
        anchored:     false,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Reducer registry
// ---------------------------------------------------------------------------

/** @type {Map<string, (state: object, payload: *) => object>} */
const _reducers = new Map();

/**
 * Register a reducer for a specific action type.
 *
 * Called by Phase 0 for infrastructure actions, and by later phases to own
 * their slice's action types. Last registration for a given type wins.
 *
 * Reducer signature: (currentState, payload) => nextState
 * The reducer MUST be pure — no side effects, no mutation of currentState.
 *
 * @param {string}   actionType
 * @param {Function} reducerFn  - (state: object, payload: *) => object
 * @throws {TypeError} if arguments are invalid
 */
function registerReducer(actionType, reducerFn) {
  if (typeof actionType !== 'string' || actionType.length === 0) {
    throw new TypeError('stateStore.registerReducer: actionType must be a non-empty string');
  }
  if (typeof reducerFn !== 'function') {
    throw new TypeError('stateStore.registerReducer: reducerFn must be a function');
  }
  _reducers.set(actionType, reducerFn);
}

// ---------------------------------------------------------------------------
// Phase 0 reducers — infrastructure actions
// ---------------------------------------------------------------------------

// --- Mode ---
// ONLY modeRouter dispatches this (D-017).
registerReducer('MODE_CHANGED', (state, payload) => ({
  ...state,
  mode: payload.mode,
}));

// --- Profile ---
registerReducer('PROFILE_LOADED', (state, payload) => ({
  ...state,
  profile: {
    ...state.profile,
    ...payload.profile,
  },
}));

registerReducer('SETTINGS_UPDATED', (state, payload) => ({
  ...state,
  profile: {
    ...state.profile,
    settings: {
      ...state.profile.settings,
      ...payload.settings,
    },
  },
}));

// --- Session: player position ---
// Also clears tournament.lastTarget on POI travel (D-073 rule c).
registerReducer('PLAYER_ARRIVED_AT_POI', (state, payload) => ({
  ...state,
  session: {
    ...state.session,
    player: {
      currentPoiId: payload.poiId,
      microOffset:  payload.microOffset ?? { dx: 0, dy: 0 },
      anchored:     payload.anchored    ?? false,
    },
  },
  tournament: state.tournament
    ? { ...state.tournament, lastTarget: null }
    : state.tournament,
}));

registerReducer('PLAYER_MICRO_DRIFTED', (state, payload) => ({
  ...state,
  session: {
    ...state.session,
    player: {
      ...state.session.player,
      microOffset: payload.microOffset,
    },
  },
}));

registerReducer('PLAYER_ANCHOR_CHANGED', (state, payload) => ({
  ...state,
  session: {
    ...state.session,
    player: {
      ...state.session.player,
      anchored: payload.anchored,
    },
  },
}));

// --- Hub: wallet (D-027) ---
// economy.js dispatches these; stateStore enforces the non-negative floor.
registerReducer('WALLET_CREDITED', (state, payload) => ({
  ...state,
  hub: {
    ...state.hub,
    money: state.hub.money + payload.amount,
  },
}));

registerReducer('WALLET_DEBITED', (state, payload) => ({
  ...state,
  hub: {
    ...state.hub,
    money: Math.max(0, state.hub.money - payload.amount),
  },
}));

// --- Hub: inventory ---
registerReducer('ITEM_PURCHASED', (state, payload) => {
  const inv = state.hub.inventory;
  const key = payload.itemType; // 'rods' | 'lures' | 'bait'
  if (!Object.prototype.hasOwnProperty.call(inv, key)) {
    console.warn(`[stateStore] ITEM_PURCHASED: unknown itemType "${key}"`);
    return state;
  }
  return {
    ...state,
    hub: {
      ...state.hub,
      inventory: {
        ...inv,
        [key]: [...inv[key], payload.item],
      },
    },
  };
});

registerReducer('ITEM_SOLD', (state, payload) => {
  const inv = state.hub.inventory;
  const key = payload.itemType;
  if (!Object.prototype.hasOwnProperty.call(inv, key)) {
    console.warn(`[stateStore] ITEM_SOLD: unknown itemType "${key}"`);
    return state;
  }
  return {
    ...state,
    hub: {
      ...state.hub,
      inventory: {
        ...inv,
        [key]: inv[key].filter(item => item.id !== payload.itemId),
      },
    },
  };
});

// --- Hub: boat ---
registerReducer('BOAT_PURCHASED', (state, payload) => ({
  ...state,
  hub: {
    ...state.hub,
    activeBoat: payload.boatId,
    inventory: {
      ...state.hub.inventory,
    },
  },
}));

// --- Hub: active tackle (D-067, D-069) ---
// Dispatched by tournament.js during TOURNAMENT_BRIEFING; mutable until TOURNAMENT_ENTERED.
registerReducer('ACTIVE_TACKLE_SET', (state, payload) => ({
  ...state,
  hub: {
    ...state.hub,
    activeTackle: payload.activeTackle, // { rods: [...], lures: [...], bait: [...] }
  },
}));

// --- Tournament lifecycle ---
registerReducer('TOURNAMENT_ENTERED', (state, payload) => ({
  ...state,
  tournament: {
    id:           payload.id,
    spec:         payload.spec,
    scanLocked:   false,
    cast:         null,
    lastTarget:   null, // D-073
    // Freeze a deep copy of hub.activeTackle into the tournament partition (H-017).
    // Set-membership is now read-only for the duration of TOURNAMENT_ACTIVE.
    activeTackle: JSON.parse(JSON.stringify(
      state.hub.activeTackle ?? { rods: [], lures: [], bait: [] }
    )),
  },
}));

registerReducer('TOURNAMENT_RESOLVED', (state) => ({
  ...state,
  tournament: {
    id:           null,
    spec:         null,
    scanLocked:   false,
    cast:         null,
    activeTackle: null,
    lastTarget:   null, // D-073
  },
}));

// --- Target retention (D-073) ---
// TARGET_LOCKED sets lastTarget; it persists across CAST_LANDED so castPipeline
// can offer a re-cast shortcut via TARGET_RETAINED. Cleared on: new TARGET_LOCKED
// (replaced), FISH_FINDER_SCAN_STARTED, PLAYER_ARRIVED_AT_POI, tournament end.
//
// payload: { poiId, offset, candidateId, lockedAtMs, finderTier }
// recastCount is NOT stored here — it is computed by castPipeline and included
// in TARGET_RETAINED events for TTS coalescing only (D-073).
registerReducer('TARGET_LOCKED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    lastTarget: payload, // replaces any previous value (D-073 rule a)
  },
}));

// FISH_FINDER_SCAN_STARTED clears lastTarget (D-073 rule b).
registerReducer('FISH_FINDER_SCAN_STARTED', (state) => ({
  ...state,
  tournament: {
    ...state.tournament,
    lastTarget: null,
  },
}));

// --- Cast sub-state: active rod and lure selection (D-071, D-072) ---
// These are AUTO-SELECT writes into the cast object, NOT set-membership mutations.
// H-017a (frozen activeTackle set-membership) is fully preserved — neither action
// adds, removes, or reorders items in activeTackle.rods / activeTackle.lures.
//
// CAST_ROD_SELECTED (D-071): castPipeline picks the lightest rod in activeTackle
// that satisfies the target's rodClassRequired after TARGET_LOCKED.
// payload: { rodId: string }
registerReducer('CAST_ROD_SELECTED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    cast: {
      ...(state.tournament.cast ?? {}),
      activeRodId: payload.rodId,
    },
  },
}));

// LURE_LOCKED (D-072): emitted by castPipeline after the LURE_SELECT FSM sub-state
// completes (player confirms a lure from activeTackle.lures, or default is accepted).
// Transitions the cast FSM from LURE_SELECT → ARMED.
// payload: { lureId: string }
registerReducer('LURE_LOCKED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    cast: {
      ...(state.tournament.cast ?? {}),
      activeLureId: payload.lureId,
    },
  },
}));

// --- Scan lock (D-043) ---
// castPipeline and fightLoop set this; fishFinder and targetSelector read it.
registerReducer('SCAN_LOCKED', (state) => ({
  ...state,
  tournament: { ...state.tournament, scanLocked: true },
}));

registerReducer('SCAN_UNLOCKED', (state) => ({
  ...state,
  tournament: { ...state.tournament, scanLocked: false },
}));

// --- Cast phase state ---
registerReducer('CAST_PHASE_CHANGED', (state, payload) => ({
  ...state,
  tournament: {
    ...state.tournament,
    cast: payload.cast, // null when idle, or a { phase, ... } object
  },
}));

// --- Per-item durability / vigor writes (H-017) ---
// Allowed during TOURNAMENT_ACTIVE (per-item state mutation, NOT set-membership mutation).
// payload: { partition: 'hub'|'tournament', itemType: 'rods'|'lures'|'bait', itemId, field, delta }
registerReducer('ITEM_DAMAGED', (state, payload) => {
  const { partition, itemType, itemId, field, delta } = payload;

  if (partition !== 'hub' && partition !== 'tournament') {
    console.warn(`[stateStore] ITEM_DAMAGED: unknown partition "${partition}"`);
    return state;
  }

  const partitionState = state[partition];
  const tackle = partition === 'tournament'
    ? partitionState.activeTackle
    : partitionState.inventory;

  if (!tackle || !tackle[itemType]) {
    console.warn(`[stateStore] ITEM_DAMAGED: no "${itemType}" in ${partition} tackle/inventory`);
    return state;
  }

  const updatedItems = tackle[itemType].map(item =>
    item.id === itemId
      ? { ...item, [field]: Math.max(0, (item[field] ?? 0) + delta) }
      : item
  );

  if (partition === 'tournament') {
    return {
      ...state,
      tournament: {
        ...state.tournament,
        activeTackle: {
          ...state.tournament.activeTackle,
          [itemType]: updatedItems,
        },
      },
    };
  } else {
    return {
      ...state,
      hub: {
        ...state.hub,
        inventory: {
          ...state.hub.inventory,
          [itemType]: updatedItems,
        },
      },
    };
  }
});

// ---------------------------------------------------------------------------
// Store internals
// ---------------------------------------------------------------------------

let _state = _initialState();

/** @type {Set<Function>} internal subscribers called before the bus event */
const _subscribers = new Set();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current state tree.
 * Do NOT mutate the returned object — all mutations must go through dispatch().
 * The reference is replaced on every successful dispatch; do not hold it across ticks.
 *
 * @returns {object}
 */
function getState() {
  return _state;
}

/**
 * Dispatch an action to update state.
 *
 * Finds the registered reducer for action.type, computes next state, updates
 * the store, notifies internal subscribers, then emits STATE_CHANGED on the bus.
 *
 * No-op (with a warning) if no reducer is registered for action.type.
 * No-op if the reducer returns the same reference (no state change).
 *
 * @param {{ type: string, payload?: * }} action
 * @throws {TypeError} if action is not an object with a string .type
 */
function dispatch(action) {
  if (!action || typeof action.type !== 'string') {
    throw new TypeError('stateStore.dispatch: action must be an object with a string .type');
  }

  const reducer = _reducers.get(action.type);
  if (!reducer) {
    console.warn(`[stateStore] No reducer registered for action type: "${action.type}"`);
    return;
  }

  const payload   = action.payload !== undefined ? action.payload : null;
  const nextState = reducer(_state, payload);

  if (nextState === _state) return; // pure no-op — nothing changed

  _state = nextState;

  // Notify internal subscribers (synchronous, before bus)
  for (const subscriber of _subscribers) {
    try {
      subscriber(_state, action);
    } catch (err) {
      console.error('[stateStore] subscriber threw:', err);
    }
  }

  // Notify bus — downstream audio, UI, and AI consumers react here
  bus.emit('STATE_CHANGED', { actionType: action.type, payload });
}

/**
 * Subscribe to state changes.
 * The subscriber is called synchronously after each successful dispatch,
 * before the STATE_CHANGED bus event, with (nextState, action).
 *
 * @param {Function} subscriber - (nextState: object, action: object) => void
 * @returns {Function} unsubscribe function
 * @throws {TypeError} if subscriber is not a function
 */
function subscribe(subscriber) {
  if (typeof subscriber !== 'function') {
    throw new TypeError('stateStore.subscribe: subscriber must be a function');
  }
  _subscribers.add(subscriber);
  return () => _subscribers.delete(subscriber);
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Reset the store to the initial state and clear all subscribers.
 * FOR TESTING ONLY — not for production use.
 * The harness calls this between test sections to prevent state leakage.
 */
function _reset() {
  _state = _initialState();
  _subscribers.clear();
}

export { getState, dispatch, subscribe, registerReducer, _reset };
