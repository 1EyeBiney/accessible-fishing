/**
 * AFish Dev Diagnostics — src/dev/diagnostics.js
 *
 * D-084 X-Ray Vision / Dev Diagnostics (LOCKED v1.83)
 *
 * Non-blocking, read-only diagnostic shortcuts for live gameplay inspection
 * during design and balance work. Active ONLY when `init(true)` is called
 * (i.e. `opts.dev === true` in engine.boot()). Production builds never call
 * `init(true)` so this module is fully dormant in shipped code.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Architecture Boundaries (D-084 — LOCKED)
 * ═══════════════════════════════════════════════════════════════════════════
 *   • This file imports ONLY from '../core/eventBus.js', '../core/stateStore.js',
 *     '../casting/castSpookModel.js', '../world/worldMap.js', and
 *     '../world/poiGraph.js' (all read-only).
 *   • It is initialised ONLY by engine.boot() (D-021 boundary).
 *   • It NEVER mutates stateStore.
 *   • It NEVER calls rngStream().next() (H-015 RNG determinism preserved).
 *   • It NEVER ticks clock (D-013 tournament clock preserved).
 *   • The math in FSMs runs unconditionally; the _verbose flag gates only the
 *     trace emission so toggling F3 cannot change game outcomes (H-004).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * F2 — Inspect Target (one-shot)
 * ═══════════════════════════════════════════════════════════════════════════
 *   Reads state.tournament.lastTarget (D-073). Derives the absolute tile coord
 *   from the stored poiId + offset, queries worldMap.getTile() for depth/cover,
 *   and calls castSpookModel.readSpookDetail() for the live decayed spook.
 *   Output format:
 *     [F2] poi=DOCK depth=4.2m cover=WEEDBED spookBase=2 spookNow=1 (age 8400ms, hl 12000ms)
 *   Delivered via BOTH UI_ANNOUNCE (so the screen reader speaks it) AND
 *   accessibleConsole.append() (so it is visible in the dev panel).
 *   If lastTarget is null: announces "[F2] No target locked." only.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * F3 — Verbose Math Toggle (sticky, session-scoped)
 * ═══════════════════════════════════════════════════════════════════════════
 *   Flips the local _verbose boolean. Exports isVerbose() so FSMs can read
 *   the flag and emit DIAG_MATH events when true. Toggle state is confirmed
 *   to accessibleConsole.append() ONLY — NOT via UI_ANNOUNCE, to avoid
 *   masking gameplay TTS (H-022).
 *   DIAG_MATH payload: { source, vars, result, atMs }
 *   The diagnostics subscriber renders received DIAG_MATH events to the
 *   accessible console panel.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Node.js Safety
 * ═══════════════════════════════════════════════════════════════════════════
 *   All window.accessibleConsole calls are guarded by _hasConsole().
 *   All bus.emit('UI_ANNOUNCE') calls still fire in Node.js (they are logged
 *   by the test harness or engine stdout path, not dropped).
 */

import * as bus             from '../core/eventBus.js';
import * as stateStore      from '../core/stateStore.js';
import * as castSpookModel  from '../casting/castSpookModel.js';
import * as worldMap        from '../world/worldMap.js';
import * as poiGraph        from '../world/poiGraph.js';
import * as clock           from '../core/clock.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module State
// ═══════════════════════════════════════════════════════════════════════════

/** Whether verbose math tracing is currently active. */
let _verbose = false;

/** Bus unsubscribe handles. */
const _unsubs = [];

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * True when window.accessibleConsole with an append method is available.
 * False in Node.js headless environments and in production builds where
 * diagnostics.init was never called with dev=true.
 */
function _hasConsole() {
  return (
    typeof window !== 'undefined' &&
    typeof window.accessibleConsole?.append === 'function'
  );
}

/**
 * Write a diagnostic line to the accessible console panel.
 * In Node.js (headless), falls back to console.log with a [DIAG] prefix.
 *
 * @param {string} line
 */
function _toConsole(line) {
  if (_hasConsole()) {
    window.accessibleConsole.append(line);
  } else {
    console.log(`[DIAG] ${line}`);
  }
}

/**
 * Derive the absolute tile coordinate from a lastTarget object.
 * Mirrors the private _getTargetAbsCoord logic in castPipeline.js (D-084 D-010
 * boundary: diagnostics never imports castPipeline).
 *
 * @param {{ poiId: string, offset: { dx: number, dy: number } }} lastTarget
 * @returns {{ x: number, y: number } | null}
 */
function _resolveTargetCoord(lastTarget) {
  if (!lastTarget) return null;
  try {
    const poi = poiGraph.getPoi(lastTarget.poiId);
    const center = poi?.centerCoord;
    if (!center) return null;
    return {
      x: Math.round(center.x + (lastTarget.offset?.dx ?? 0)),
      y: Math.round(center.y + (lastTarget.offset?.dy ?? 0)),
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F2 — Inspect Target
// ═══════════════════════════════════════════════════════════════════════════

function _handleF2() {
  const atMs       = clock.nowMs();
  const state      = stateStore.getState();
  const lastTarget = state.tournament?.lastTarget ?? null;

  if (!lastTarget) {
    bus.emit('UI_ANNOUNCE', { text: '[F2] No target locked.', atMs });
    _toConsole('[F2] No target locked.');
    return;
  }

  const coord = _resolveTargetCoord(lastTarget);
  if (!coord) {
    const msg = `[F2] Target ${lastTarget.poiId} — coord unavailable.`;
    bus.emit('UI_ANNOUNCE', { text: msg, atMs });
    _toConsole(msg);
    return;
  }

  // ── Tile traits ──────────────────────────────────────────────────────────
  let depthM    = '?';
  let coverType = '?';
  try {
    const tile = worldMap.getTile(coord);
    if (tile) {
      depthM    = tile.traits?.depth?.bottomM != null
        ? tile.traits.depth.bottomM.toFixed(1)
        : '?';
      coverType = tile.traits?.cover?.type ?? '?';
    }
  } catch {
    // Tile read failure is non-fatal — output what we have.
  }

  // ── Spook detail ─────────────────────────────────────────────────────────
  const detail    = castSpookModel.readSpookDetail(coord, atMs);
  const spookBase = detail?.baseSpook   ?? 0;
  const spookNow  = detail?.decayedSpook ?? 0;
  const ageMs     = detail?.ageMs        ?? 0;
  const hlMs      = castSpookModel.SPOOK_DECAY_MS_PER_LEVEL;

  const line = [
    `[F2] poi=${lastTarget.poiId}`,
    `depth=${depthM}m`,
    `cover=${coverType}`,
    `spookBase=${spookBase}`,
    `spookNow=${spookNow}`,
    `(age ${ageMs}ms, hl ${hlMs}ms)`,
  ].join(' ');

  bus.emit('UI_ANNOUNCE', { text: line, atMs });
  _toConsole(line);
}

// ═══════════════════════════════════════════════════════════════════════════
// F3 — Verbose Math Toggle
// ═══════════════════════════════════════════════════════════════════════════

function _handleF3() {
  _verbose = !_verbose;
  const state = _verbose ? 'ON' : 'OFF';
  _toConsole(`[F3] Verbose math logging ${state}.`);
  // F3 toggle state goes to accessibleConsole ONLY — NOT UI_ANNOUNCE (H-022).
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAG_MATH renderer
// ═══════════════════════════════════════════════════════════════════════════

function _handleDiagMath(evt) {
  if (!_verbose) return;
  const { source = '?', vars = {}, result, atMs } = evt ?? {};
  const varStr = Object.entries(vars)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`)
    .join(' ');
  _toConsole(`[DIAG:${source}] ${varStr} → ${result} (atMs=${atMs})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether verbose math tracing is currently active.
 * FSMs read this flag to gate DIAG_MATH emission — toggling it never
 * alters their computation paths (H-004 replay determinism preserved).
 *
 * @returns {boolean}
 */
export function isVerbose() {
  return _verbose;
}

/**
 * Initialize the diagnostics module.
 *
 * Must be called once from engine.boot(). If devMode is false (production),
 * this is a no-op — no bus subscriptions are registered, no F2/F3 mappings
 * are armed, and isVerbose() always returns false.
 *
 * @param {boolean} devMode - true only when opts.dev === true in boot()
 */
export function init(devMode) {
  if (!devMode) return;

  _unsubs.push(bus.on('INPUT_F2', _handleF2));
  _unsubs.push(bus.on('INPUT_F3', _handleF3));
  _unsubs.push(bus.on('DIAG_MATH', _handleDiagMath));

  _toConsole('[diagnostics] Dev mode active. F2 = Inspect Target, F3 = Verbose Math Toggle.');
}
