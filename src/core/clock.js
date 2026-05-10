/**
 * AFish Clock — src/core/clock.js
 *
 * Public API Contract: start / pause / reset / tick / every / schedule / cancel / nowMs / isRunning
 *
 * Single time authority for the entire engine (§5e, D-013, D-018).
 *
 * Design notes:
 *  - ONLY modeRouter may call pause() / reset() / start() for mode-transition reasons (D-018).
 *    All other subsystems call every() / schedule() / cancel() only.
 *  - Supports two operating modes:
 *      'manual'   — time advances only via explicit tick(deltaMs) calls.
 *                   Used in tests and for the D-026 weigh-in fast-forward path (H-008).
 *      'realtime' — setInterval drives automatic advancement at ~REALTIME_TICK_MS.
 *                   Used during live TOURNAMENT_ACTIVE play.
 *  - Callbacks fired by _advanceTo() run in strictly ascending fireAtMs order (H-004).
 *    A recurring callback that spans multiple intervals fires multiple times per tick.
 *  - schedule() and every() return integer handles. cancel(handle) prevents future fires.
 *    Subsystems MUST cancel all handles in their onUnmount() (H-005).
 *  - Callback errors are caught and logged so one bad subscriber cannot halt the clock.
 */

import * as bus from './eventBus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Real-time polling interval in wall-clock milliseconds (~60 fps). */
const REALTIME_TICK_MS = 16;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _nowMs      = 0;
let _running    = false;
let _mode       = 'manual'; // 'manual' | 'realtime'
let _realtimeHandle = null;
let _lastWallMs = null;

/**
 * @typedef {object} ScheduleEntry
 * @property {number}        id
 * @property {number}        fireAtMs   - next (or only) time to fire
 * @property {number|null}   intervalMs - null for one-shots; positive int for recurring
 * @property {Function}      cb         - called with (atMs: number)
 * @property {boolean}       cancelled
 */

/** @type {ScheduleEntry[]} */
let _schedules = [];
let _nextId    = 1;

// ---------------------------------------------------------------------------
// Core: advance internal time and fire callbacks
// ---------------------------------------------------------------------------

/**
 * Advance the clock to targetMs, firing all pending callbacks in ascending fireAtMs order.
 * Recurring callbacks whose interval fits multiple times within the advance range
 * will fire multiple times (e.g. every(1000) and tick(3000) → fires 3×).
 *
 * Never moves the clock backwards. Safe to call with targetMs === _nowMs (no-op).
 *
 * @param {number} targetMs
 */
function _advanceTo(targetMs) {
  if (targetMs <= _nowMs) return;

  // Iteration guard: prevents infinite loops if a callback re-schedules at the
  // same time. In practice callbacks schedule future events so this is a safety net.
  let iterations = 0;

  while (true) {
    // Find the earliest non-cancelled callback whose fireAtMs falls in (_nowMs, targetMs]
    let earliestIdx = -1;
    let earliestMs  = Infinity;

    for (let i = 0; i < _schedules.length; i++) {
      const s = _schedules[i];
      if (!s.cancelled && s.fireAtMs > _nowMs && s.fireAtMs <= targetMs) {
        if (s.fireAtMs < earliestMs) {
          earliestIdx = i;
          earliestMs  = s.fireAtMs;
        }
      }
    }

    if (earliestIdx === -1) break; // nothing left in range

    iterations++;
    if (iterations > 100000) {
      console.error('[clock] _advanceTo: iteration guard triggered — possible callback loop');
      break;
    }

    const s = _schedules[earliestIdx];

    // Advance internal time to the callback's scheduled moment
    _nowMs = s.fireAtMs;

    const cb = s.cb;

    if (s.intervalMs !== null) {
      // Recurring: advance fireAtMs BEFORE calling so the callback can safely cancel
      // its own handle without affecting the current fire.
      s.fireAtMs += s.intervalMs;
    } else {
      // One-shot: mark cancelled before calling (re-entrant emit safety)
      s.cancelled = true;
    }

    try {
      cb(_nowMs);
    } catch (err) {
      console.error('[clock] callback threw:', err);
    }
  }

  // Settle at targetMs and purge completed one-shots
  _nowMs = targetMs;
  _schedules = _schedules.filter(s => !s.cancelled);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the clock.
 * In 'realtime' mode a setInterval drives automatic advancement.
 * In 'manual' mode time only moves via explicit tick() calls.
 * No-op if already running.
 *
 * ONLY modeRouter should call this for mode reasons (D-018).
 *
 * @param {object}  [opts]
 * @param {'manual'|'realtime'} [opts.mode='manual']
 */
function start(opts = {}) {
  if (_running) return;

  _mode    = opts.mode ?? 'manual';
  _running = true;

  bus.emit('CLOCK_STARTED', { atMs: _nowMs, mode: _mode });

  if (_mode === 'realtime') {
    _lastWallMs     = Date.now();
    _realtimeHandle = setInterval(() => {
      const now   = Date.now();
      const delta = now - _lastWallMs;
      _lastWallMs = now;
      if (delta > 0) _advanceTo(_nowMs + delta);
    }, REALTIME_TICK_MS);
  }
}

/**
 * Pause the clock.
 * In realtime mode: cancels the setInterval.
 * In manual mode: sets _running = false so isRunning() returns false.
 * No-op if already paused.
 *
 * ONLY modeRouter should call this for mode reasons (D-018).
 */
function pause() {
  if (!_running) return;
  _running = false;

  if (_realtimeHandle !== null) {
    clearInterval(_realtimeHandle);
    _realtimeHandle = null;
  }

  bus.emit('CLOCK_PAUSED', { atMs: _nowMs });
}

/**
 * Reset the clock to t=0 and clear all pending scheduled callbacks.
 * Implies pause() if running.
 *
 * Subsystems MUST cancel their own handles in onUnmount() (H-005) before this is called.
 * reset() is a belt-and-suspenders safety net, not the primary cancellation path.
 *
 * ONLY modeRouter should call this (D-018), immediately before start() on
 * TOURNAMENT_ACTIVE entry so each tournament begins at a fresh t=0.
 */
function reset() {
  if (_running) pause();

  _nowMs     = 0;
  _schedules = [];
  _nextId    = 1;

  bus.emit('CLOCK_RESET', { atMs: 0 });
}

/**
 * Manually advance the clock by deltaMs.
 *
 * This is the primary advancement mechanism in manual mode (H-004 determinism).
 * It is also used by the D-026 weigh-in fast-forward path (H-008): the same
 * code path as real-time play, driving identical scheduled-callback execution.
 *
 * Safe to call in realtime mode (e.g. for deterministic fast-forward mid-tournament).
 *
 * @param {number} deltaMs - must be > 0; values ≤ 0 are silently ignored
 */
function tick(deltaMs) {
  if (deltaMs <= 0) return;
  _advanceTo(_nowMs + deltaMs);
}

/**
 * Schedule a one-shot callback after delayMs from the current clock time.
 *
 * @param {number}   delayMs - must be ≥ 0
 * @param {Function} cb      - called with (atMs: number) when fired
 * @returns {number} handle — pass to cancel() to prevent firing
 * @throws {TypeError}  if cb is not a function
 * @throws {RangeError} if delayMs < 0
 */
function schedule(delayMs, cb) {
  if (typeof cb !== 'function') {
    throw new TypeError('clock.schedule: cb must be a function');
  }
  if (delayMs < 0) {
    throw new RangeError(`clock.schedule: delayMs must be ≥ 0 (got ${delayMs})`);
  }

  const id = _nextId++;
  _schedules.push({
    id,
    fireAtMs:   _nowMs + delayMs,
    intervalMs: null,
    cb,
    cancelled:  false,
  });
  return id;
}

/**
 * Schedule a recurring callback every intervalMs.
 * First fire occurs at nowMs() + intervalMs.
 *
 * AI bot cooldowns (D-060), fight ticks (D-034), and bite timers (D-032)
 * all use this API. Each must cancel their handle in onUnmount() (H-005).
 *
 * @param {number}   intervalMs - must be > 0
 * @param {Function} cb         - called with (atMs: number) on each fire
 * @returns {number} handle — pass to cancel() to stop recurrence
 * @throws {TypeError}  if cb is not a function
 * @throws {RangeError} if intervalMs ≤ 0
 */
function every(intervalMs, cb) {
  if (typeof cb !== 'function') {
    throw new TypeError('clock.every: cb must be a function');
  }
  if (intervalMs <= 0) {
    throw new RangeError(`clock.every: intervalMs must be > 0 (got ${intervalMs})`);
  }

  const id = _nextId++;
  _schedules.push({
    id,
    fireAtMs:   _nowMs + intervalMs,
    intervalMs,
    cb,
    cancelled:  false,
  });
  return id;
}

/**
 * Cancel a scheduled one-shot or recurring callback by handle.
 * Safe to call with a handle that has already been cancelled or fired.
 * Safe to call from within the callback being cancelled.
 *
 * @param {number} handle - returned by schedule() or every()
 */
function cancel(handle) {
  const s = _schedules.find(s => s.id === handle);
  if (s) s.cancelled = true;
}

/**
 * Returns the current tournament-clock time in milliseconds.
 * This is the single authoritative time source for all subsystems (§5e).
 * Use this instead of Date.now() everywhere in the engine.
 *
 * @returns {number}
 */
function nowMs() {
  return _nowMs;
}

/**
 * Returns whether the clock is currently running.
 *
 * @returns {boolean}
 */
function isRunning() {
  return _running;
}

/**
 * Returns the number of currently pending (non-cancelled) scheduled entries.
 * Used by H-005 tests to verify subsystems cleaned up their handles.
 *
 * @returns {number}
 */
function pendingCount() {
  return _schedules.filter(s => !s.cancelled).length;
}

export { start, pause, reset, tick, every, schedule, cancel, nowMs, isRunning, pendingCount };
