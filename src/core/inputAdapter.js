/**
 * AFish Input Adapter — src/core/inputAdapter.js
 *
 * Public API Contract: keyDown / keyUp / tap / isHeld / heldDuration / lock / unlock / releaseAll / getLockout
 *
 * All input flows through this module (D-010, §5f).
 * No subsystem reads raw keyboard, switch, voice, or controller input directly.
 * Platform adapters (keyboard, gamepad, switch access) call keyDown() / keyUp()
 * with normalised type strings; this module handles all routing and event emission.
 *
 * Edge model (D-029):
 *   keyDown(type) → emits INPUT_<TYPE>_DOWN
 *   keyUp(type)   → emits INPUT_<TYPE>_UP
 *                   if heldMs < TAP_THRESHOLD_MS → also emits INPUT_<TYPE> (tap) + INPUT (generic tap)
 *
 * Lockout (D-015, D-030):
 *   lock(reason, durationMs) — blocks all input; INPUT_BLOCKED emitted for each attempt.
 *   If any inputs are held when lock() is called, synthetic INPUT_<TYPE>_UP events are
 *   emitted for each with reason: 'LOCKOUT_FORCED_RELEASE' (D-030).
 *
 * Mode transitions (H-010, D-030):
 *   releaseAll() — emits synthetic UP for every held input, called by modeRouter on
 *   every mode transition. Does NOT clear lockout state.
 *
 * tap(type) convenience:
 *   Calls keyDown then keyUp at the same clock time (heldMs = 0 → always produces a
 *   tap event). Useful for accessibility adapters and the test harness.
 *
 * Key-binding lock (D-081 v1.17):
 *   In addition to the generic INPUT_<TYPE> tap events, three logical types have
 *   special domain-event bindings wired here (per D-010, so all consumers are
 *   decoupled from raw key codes):
 *     R     → INPUT_R (Soft Retrieve — consumed by castPipeline, D-081)
 *     Q     → INPUT_Q (Power Rip   — consumed by castPipeline, D-081)
 *     F     → INPUT_F (one of two Sonar Request keys; see REQUEST_SCAN below)
 *   Dual-bind: both F-tap and ENTER-tap emit a REQUEST_SCAN bus event (D-041).
 *   REQUEST_SCAN is blocked at the fishFinder level while scanLocked is set (D-043),
 *   so no guard is needed here — the adapter emits unconditionally.
 *
 * Lockout and tap interaction:
 *   If keyDown is blocked by lockout, no hold is recorded. A subsequent keyUp with no
 *   hold record and an active lockout silently no-ops (the DOWN was already blocked;
 *   emitting a second INPUT_BLOCKED for the paired UP would be spurious noise).
 */

import * as bus   from './eventBus.js';
import * as clock from './clock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Held duration below this threshold → UP event also emits a tap (D-029). */
const TAP_THRESHOLD_MS = 150;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Currently held inputs.
 * @type {Map<string, { downAtMs: number }>}
 */
const _held = new Map();

/**
 * Active lockout, or null if unlocked.
 * @type {{ reason: string, unlockAtMs: number } | null}
 */
let _lockout = null;

/** clock.schedule handle for automatic unlock, or null. */
let _unlockHandle = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the lockout has naturally expired at the current clock time.
 * If so, clears the lockout state and emits INPUT_UNLOCKED.
 */
function _clearExpiredLockout() {
  if (_lockout !== null && clock.nowMs() >= _lockout.unlockAtMs) {
    const reason = _lockout.reason;
    _lockout = null;
    if (_unlockHandle !== null) {
      clock.cancel(_unlockHandle);
      _unlockHandle = null;
    }
    bus.emit('INPUT_UNLOCKED', { reason, atMs: clock.nowMs() });
  }
}

/**
 * Emit INPUT_<TYPE>_DOWN edge event.
 */
function _emitDown(type, payload, source, atMs) {
  bus.emit(`INPUT_${type}_DOWN`, { type, payload, atMs, source });
}

/**
 * Emit INPUT_<TYPE>_UP edge event.
 * @param {string|null} reason - present only for synthetic releases (D-030)
 */
function _emitUp(type, payload, source, atMs, reason = null) {
  const evt = { type, payload, atMs, source };
  if (reason !== null) evt.reason = reason;
  bus.emit(`INPUT_${type}_UP`, evt);
}

/**
 * Emit the tap events (INPUT_<TYPE> + generic INPUT) after a short hold.
 *
 * Dual-bind (D-041, D-081 v1.17):
 *   F-tap   → also emits REQUEST_SCAN
 *   ENTER-tap → also emits REQUEST_SCAN
 * Both bindings are unconditional here; fishFinder enforces the scanLocked
 * mutex (D-043) so no guard is needed in the adapter layer.
 */
function _emitTap(type, payload, source, atMs) {
  const evt = { type, payload, atMs, source };
  bus.emit(`INPUT_${type}`, evt);
  bus.emit('INPUT',         evt);

  // REQUEST_SCAN dual-bind: F key and Enter key both request a sonar scan (D-041).
  if (type === 'F' || type === 'ENTER') {
    bus.emit('REQUEST_SCAN', { atMs, source });
  }
}

// ---------------------------------------------------------------------------
// Public API — input injection
// ---------------------------------------------------------------------------

/**
 * Signal that an input started (key pressed, switch activated).
 *
 * If locked:
 *   - Emits INPUT_BLOCKED and returns. No hold is recorded.
 * If unlocked:
 *   - Records the hold start time.
 *   - Emits INPUT_<TYPE>_DOWN.
 *
 * @param {string} type    - normalised input type, e.g. 'SPACEBAR', 'ARROW_UP', 'NUMPAD_8'
 * @param {*}      [payload=null]
 * @param {string} [source='keyboard'] - input source identifier
 */
function keyDown(type, payload = null, source = 'keyboard') {
  const atMs = clock.nowMs();

  // Clear any naturally-expired lockout first
  _clearExpiredLockout();

  if (_lockout !== null) {
    bus.emit('INPUT_BLOCKED', {
      type, payload, atMs, source,
      reason:      _lockout.reason,
      unlockAtMs:  _lockout.unlockAtMs,
    });
    return;
  }

  // Record hold start (even if already held — debounce is the platform's concern)
  _held.set(type, { downAtMs: atMs });
  _emitDown(type, payload, source, atMs);
}

/**
 * Signal that an input ended (key released, switch deactivated).
 *
 * Cases:
 *   A) Active hold + no lockout → normal UP + conditional tap.
 *   B) Active hold + lockout    → INPUT_BLOCKED + clear hold.
 *      (lockout() should have called releaseAll(), so this is a defensive edge case.)
 *   C) No hold record + lockout → silent no-op.
 *      (DOWN was blocked; emitting a second INPUT_BLOCKED would be spurious.)
 *   D) No hold record + no lockout → silent no-op (orphaned UP, safe to ignore).
 *
 * @param {string} type
 * @param {*}      [payload=null]
 * @param {string} [source='keyboard']
 */
function keyUp(type, payload = null, source = 'keyboard') {
  const atMs      = clock.nowMs();
  const holdRecord = _held.get(type);

  // Case C/D — no active hold
  if (!holdRecord) {
    // Case C: silently swallow the UP; the blocked DOWN already emitted INPUT_BLOCKED
    return;
  }

  // Case B: hold exists but lockout is now active (lock() was called mid-hold without
  // catching this particular key in releaseAll — defensive guard)
  _clearExpiredLockout();
  if (_lockout !== null) {
    _held.delete(type);
    bus.emit('INPUT_BLOCKED', {
      type, payload, atMs, source,
      reason:     _lockout.reason,
      unlockAtMs: _lockout.unlockAtMs,
    });
    return;
  }

  // Case A: normal release
  const heldMs = atMs - holdRecord.downAtMs;
  _held.delete(type);

  _emitUp(type, payload, source, atMs);

  // Tap: UP within TAP_THRESHOLD_MS of DOWN (D-029)
  if (heldMs < TAP_THRESHOLD_MS) {
    _emitTap(type, payload, source, atMs);
  }
}

/**
 * Convenience: inject a complete tap (DOWN + immediate UP) at the current clock time.
 * Held duration = 0 → always produces a tap event when unlocked.
 * When locked: emits one INPUT_BLOCKED (from keyDown); keyUp is a silent no-op.
 *
 * Used by the test harness and accessibility platform adapters that deliver
 * logical taps rather than physical edge pairs.
 *
 * @param {string} type
 * @param {*}      [payload=null]
 * @param {string} [source='keyboard']
 */
function tap(type, payload = null, source = 'keyboard') {
  keyDown(type, payload, source);
  keyUp(type, payload, source);
}

// ---------------------------------------------------------------------------
// Public API — queries
// ---------------------------------------------------------------------------

/**
 * Returns whether the given input type is currently held down.
 * Used by fightLoop's `clock.every(60ms)` tick to read SPACEBAR / ARROW_DOWN hold state
 * without subscribing to bus events (D-034).
 *
 * @param {string} type
 * @returns {boolean}
 */
function isHeld(type) {
  return _held.has(type);
}

/**
 * Returns the number of milliseconds the input has been held, measured against the
 * current clock time. Returns 0 if the input is not currently held.
 *
 * @param {string} type
 * @returns {number}
 */
function heldDuration(type) {
  const record = _held.get(type);
  if (!record) return 0;
  return clock.nowMs() - record.downAtMs;
}

// ---------------------------------------------------------------------------
// Public API — lockout control
// ---------------------------------------------------------------------------

/**
 * Engage an input lockout for durationMs.
 *
 * During the lockout window all input attempts emit INPUT_BLOCKED instead of
 * their normal events.
 *
 * If any inputs are currently held when lock() is called:
 *   - Synthetic INPUT_<TYPE>_UP events are emitted for each with reason: 'LOCKOUT_FORCED_RELEASE'.
 *   - The hold records are cleared.
 *   (D-030 — prevents consumers from leaking hold state across a lockout.)
 *
 * Replaces any previously active lockout. Schedules an automatic INPUT_UNLOCKED via clock.
 *
 * @param {string} reason    - e.g. 'BIRDS_NEST', 'FIGHT_LOCKOUT'
 * @param {number} durationMs - lockout duration in tournament-clock milliseconds
 */
function lock(reason, durationMs) {
  const atMs       = clock.nowMs();
  const unlockAtMs = atMs + durationMs;

  // Cancel any previous auto-unlock schedule
  if (_unlockHandle !== null) {
    clock.cancel(_unlockHandle);
    _unlockHandle = null;
  }

  // Forced release for all currently held inputs (D-030)
  for (const [heldType] of _held.entries()) {
    _emitUp(heldType, null, 'system', atMs, 'LOCKOUT_FORCED_RELEASE');
  }
  _held.clear();

  _lockout = { reason, unlockAtMs };

  bus.emit('INPUT_LOCKED', { reason, atMs, unlockAtMs, durationMs });

  // Schedule automatic unlock at the exact tournament-clock moment
  _unlockHandle = clock.schedule(durationMs, (fireAtMs) => {
    // Guard: only unlock if this schedule belongs to the current lockout
    if (_lockout && _lockout.reason === reason && _lockout.unlockAtMs === unlockAtMs) {
      _lockout      = null;
      _unlockHandle = null;
      bus.emit('INPUT_UNLOCKED', { reason, atMs: fireAtMs });
    }
  });
}

/**
 * Immediately clear any active lockout.
 * Emits INPUT_UNLOCKED. Safe to call when no lockout is active.
 */
function unlock() {
  if (_unlockHandle !== null) {
    clock.cancel(_unlockHandle);
    _unlockHandle = null;
  }
  const reason = _lockout ? _lockout.reason : null;
  _lockout = null;
  bus.emit('INPUT_UNLOCKED', { reason, atMs: clock.nowMs() });
}

/**
 * Release all currently held inputs, emitting synthetic INPUT_<TYPE>_UP with
 * reason: 'MODE_CHANGED' for each.
 *
 * Called by modeRouter on EVERY mode transition (H-010, D-030).
 * Does NOT clear lockout state — lockout lifecycle is managed separately by lock/unlock.
 */
function releaseAll() {
  const atMs = clock.nowMs();
  for (const [type] of _held.entries()) {
    _emitUp(type, null, 'system', atMs, 'MODE_CHANGED');
  }
  _held.clear();
}

/**
 * Returns a copy of the current lockout state, or null if unlocked.
 * Used by targetSelector and fightLoop to read lockout without subscribing to bus events.
 *
 * @returns {{ reason: string, unlockAtMs: number } | null}
 */
function getLockout() {
  _clearExpiredLockout();
  return _lockout ? { ..._lockout } : null;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Reset all internal state.
 * FOR TESTING ONLY — clears held inputs and lockout without emitting events.
 */
function _reset() {
  _held.clear();
  if (_unlockHandle !== null) {
    clock.cancel(_unlockHandle);
    _unlockHandle = null;
  }
  _lockout = null;
}

export {
  // Injection
  keyDown, keyUp, tap,
  // Queries
  isHeld, heldDuration,
  // Lockout
  lock, unlock, releaseAll, getLockout,
  // Test
  _reset,
};
