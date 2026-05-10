/**
 * AFish Event Bus — src/core/eventBus.js
 *
 * Public API Contract: emit / on / off
 *
 * Sole cross-module communication surface (§5f, §9).
 * No subsystem may import another subsystem directly to pass messages.
 * All cross-folder communication flows through this bus or declared Public API entries.
 *
 * Design notes:
 *  - Fan-out is fully synchronous: all handlers for an event type complete before
 *    emit() returns. This preserves the H-016 atomic ordering contract (leaderboard
 *    commit → emit) and makes replay deterministic (H-004).
 *  - Handlers are snapshotted before iteration so a handler calling off() mid-emit
 *    does not corrupt the iteration.
 *  - listenerCount / totalListenerCount are testing helpers for the H-005 boot leak
 *    assertion: "zero stray subscriptions after a HUB↔TOURNAMENT round-trip."
 */

/** @type {Map<string, Set<Function>>} eventType → set of handlers */
const _listeners = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to an event type.
 *
 * @param {string}   eventType - non-empty event name, e.g. 'CLOCK_STARTED'
 * @param {Function} handler   - called with (payload) whenever the event fires
 * @returns {Function} unsubscribe shortcut — call it to remove this handler
 * @throws {TypeError} if eventType is not a non-empty string or handler is not a function
 */
function on(eventType, handler) {
  if (typeof eventType !== 'string' || eventType.length === 0) {
    throw new TypeError('eventBus.on: eventType must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new TypeError('eventBus.on: handler must be a function');
  }

  if (!_listeners.has(eventType)) {
    _listeners.set(eventType, new Set());
  }
  _listeners.get(eventType).add(handler);

  return () => off(eventType, handler);
}

/**
 * Unsubscribe a handler from an event type.
 * No-op if the handler was never registered for that event type.
 *
 * @param {string}   eventType
 * @param {Function} handler
 */
function off(eventType, handler) {
  const handlers = _listeners.get(eventType);
  if (!handlers) return;

  handlers.delete(handler);

  // Clean up empty sets so totalListenerCount() stays accurate
  if (handlers.size === 0) {
    _listeners.delete(eventType);
  }
}

/**
 * Emit an event synchronously to all registered handlers for that type.
 * Handlers are called in insertion order.
 * Handlers added or removed during emission are not affected by the current dispatch.
 *
 * @param {string} eventType
 * @param {*}      [payload]  - any serialisable value; no mutation of payload by handlers
 */
function emit(eventType, payload) {
  const handlers = _listeners.get(eventType);
  if (!handlers || handlers.size === 0) return;

  // Snapshot before iteration: guards against off() calls mid-dispatch
  for (const handler of [...handlers]) {
    handler(payload);
  }
}

// ---------------------------------------------------------------------------
// Testing / Introspection helpers (H-005 boot leak test)
// ---------------------------------------------------------------------------

/**
 * Returns the number of active handlers registered for a given event type.
 * Used by the H-005 engine boot test.
 *
 * @param {string} eventType
 * @returns {number}
 */
function listenerCount(eventType) {
  const handlers = _listeners.get(eventType);
  return handlers ? handlers.size : 0;
}

/**
 * Returns the total number of active handlers across all event types.
 * The H-005 engine boot test asserts this is 0 after a full HUB↔TOURNAMENT round-trip
 * (all subsystems must cancel their subscriptions in onUnmount).
 *
 * @returns {number}
 */
function totalListenerCount() {
  let total = 0;
  for (const handlers of _listeners.values()) {
    total += handlers.size;
  }
  return total;
}

/**
 * Returns a snapshot of all currently registered event types and their handler counts.
 * Useful for diagnosing which subscriptions are leaking in failed H-005 tests.
 *
 * @returns {Record<string, number>}
 */
function debugSnapshot() {
  const out = {};
  for (const [eventType, handlers] of _listeners.entries()) {
    out[eventType] = handlers.size;
  }
  return out;
}

export { on, off, emit, listenerCount, totalListenerCount, debugSnapshot };
