/**
 * AFish Cast Spook Model — src/casting/castSpookModel.js
 *
 * Public API Contract: readSpook(coord, atMs) / applySplash(coord, kind, atMs)
 *
 * Compute-on-read service for tile spook state (D-038, LOCKED).
 * SOLE WRITER of tile.state.spook (H-003). No other module may mutate this field.
 *
 * Consumers:
 *   castPipeline.js — calls applySplash on CAST_LANDED to record the splash.
 *   fish/fishBehavior.js — calls readSpook in strikeModel to check whether
 *     the landing tile is spooked before scheduling a bite timer.
 *   equipment/fishFinder.js — has its OWN independent compute-on-read
 *     implementation (mirror of the formula below) so it does NOT import
 *     this module (H-014 compliance). Any change to the formula here MUST
 *     be mirrored there and vice versa.
 *
 * Math (D-038, LOCKED — do not change without a brief amendment):
 *   MAX_SPOOK                  = 5
 *   SPOOK_DECAY_MS_PER_LEVEL   = 12 000ms (one level per 12 in-game seconds)
 *   Splash increments:
 *     SILENT → +0  (extremely accurate entry; spook not registered)
 *     NORMAL → +1  (standard cast)
 *     LOUD   → +3  (sloppy, noisy entry; major spook spike)
 *   Compute-on-read:
 *     currentSpook(atMs) = max(0, storedLevel − floor((atMs − updatedAtMs) / 12 000))
 *
 * Design notes:
 *   · Zero per-tick bus traffic. Decay is computed lazily on each read.
 *   · The stored level is the ABSOLUTE level at the moment applySplash writes it —
 *     NOT a delta. The compute-on-read formula subtracts elapsed decay on every
 *     read, so writing the full current value is always correct.
 *   · applySplash first calls readSpook to get the live effective level, then adds
 *     the increment, then writes the clamped result. This ensures the stored level
 *     never exceeds MAX_SPOOK even if multiple splashes land close together.
 *   · SILENT splashes are a complete no-op: no tile mutation, no bus event, no
 *     processing cost. This is intentional — a perfect cast has zero signature.
 *
 * Events emitted:
 *   SPOOK_APPLIED  { coord, kind, increment, storedLevel, atMs }
 *     — fired whenever a non-SILENT splash increments a tile's stored spook level.
 *     — audio/synthGraph.js may consume this to play a water-disturb sound.
 */

import * as bus      from '../core/eventBus.js';
import * as worldMap from '../world/worldMap.js';

// ---------------------------------------------------------------------------
// Constants (D-038, LOCKED)
// ---------------------------------------------------------------------------

/** Maximum storable spook level. Reads may never exceed this. */
export const MAX_SPOOK = 5;

/** In-game milliseconds required for one stored spook level to decay. */
export const SPOOK_DECAY_MS_PER_LEVEL = 12_000;

/**
 * Spook increment for each splash kind (D-038, LOCKED).
 * @readonly
 */
const SPLASH_INCREMENT = Object.freeze({
  SILENT: 0,
  NORMAL: 1,
  LOUD:   3,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute-on-read: returns the current effective spook level at the given tile
 * coordinate for the given tournament-clock time.
 *
 * Decay formula (D-038):
 *   currentSpook = max(0, storedLevel − floor((atMs − updatedAtMs) / SPOOK_DECAY_MS_PER_LEVEL))
 *
 * Returns 0 for unknown tiles or tiles with no spook state.
 *
 * @param {{ x: number, y: number } | string} coord — tile coord object or "x,y" key
 * @param {number}                            atMs  — current tournament-clock time in ms
 * @returns {number} integer in [0, MAX_SPOOK]
 */
export function readSpook(coord, atMs) {
  let tile;
  try {
    tile = worldMap.getTile(coord);
  } catch {
    return 0;
  }
  if (!tile) return 0;

  const spook = tile.state?.spook;
  if (!spook || typeof spook.level !== 'number' || spook.level <= 0) return 0;

  const updatedAtMs = spook.updatedAtMs ?? 0;
  const elapsed     = Math.max(0, atMs - updatedAtMs);
  const decayed     = Math.floor(elapsed / SPOOK_DECAY_MS_PER_LEVEL);

  return Math.max(0, spook.level - decayed);
}

/**
 * Diagnostic variant of readSpook (D-084).
 * Returns a detail object with the raw stored level, the decayed effective level,
 * the age of the last write, and the configured half-life — WITHOUT mutating tile
 * state. Called exclusively by src/dev/diagnostics.js for F2 inspection output.
 *
 * Read-only invariant: this function NEVER calls worldMap.mutateTileState,
 * NEVER emits bus events, and NEVER advances the RNG (H-004, H-015 safe).
 *
 * @param {{ x: number, y: number } | string} coord — tile coord object or "x,y" key
 * @param {number}                            atMs  — current tournament-clock time in ms
 * @returns {{ baseSpook: number, decayedSpook: number, decayHalfLifeMs: number, ageMs: number }}
 */
export function readSpookDetail(coord, atMs) {
  let tile;
  try {
    tile = worldMap.getTile(coord);
  } catch {
    return { baseSpook: 0, decayedSpook: 0, decayHalfLifeMs: SPOOK_DECAY_MS_PER_LEVEL, ageMs: 0 };
  }

  if (!tile) {
    return { baseSpook: 0, decayedSpook: 0, decayHalfLifeMs: SPOOK_DECAY_MS_PER_LEVEL, ageMs: 0 };
  }

  const spook       = tile.state?.spook;
  const baseSpook   = (spook && typeof spook.level === 'number') ? spook.level : 0;
  const updatedAtMs = spook?.updatedAtMs ?? 0;
  const ageMs       = Math.max(0, atMs - updatedAtMs);
  const decayed     = Math.floor(ageMs / SPOOK_DECAY_MS_PER_LEVEL);
  const decayedSpook = Math.max(0, baseSpook - decayed);

  return {
    baseSpook,
    decayedSpook,
    decayHalfLifeMs: SPOOK_DECAY_MS_PER_LEVEL,
    ageMs,
  };
}

/**
 * Apply a cast splash to the given tile, adding the appropriate spook increment
 * and persisting the new stored level via worldMap.mutateTileState (H-003).
 *
 * SILENT splashes are a complete no-op: no tile write, no bus event.
 * For NORMAL or LOUD, the effective current level (compute-on-read) is read
 * first, the increment is added, and the result is clamped to MAX_SPOOK.
 *
 * H-003: This is the ONLY path that may write tile.state.spook.
 *        No other module — including castPipeline, fishBehavior, or fishFinder —
 *        may call worldMap.mutateTileState for spook fields directly.
 *
 * @param {{ x: number, y: number } | string} coord  — tile coord object or "x,y" key
 * @param {'SILENT'|'NORMAL'|'LOUD'}           kind   — splash kind from castPipeline
 * @param {number}                             atMs   — current tournament-clock time in ms
 */
export function applySplash(coord, kind, atMs) {
  const increment = SPLASH_INCREMENT[kind];
  if (increment === undefined) {
    console.warn(`[castSpookModel] applySplash: unknown kind "${kind}"; treating as SILENT`);
    return;
  }
  if (increment === 0) return; // SILENT: pure no-op

  let tile;
  try {
    tile = worldMap.getTile(coord);
  } catch {
    return;
  }
  if (!tile) return; // unknown tile: no-op, not an error

  // Read the CURRENT effective spook (post-decay) so we add on top of the
  // real live value, not the stale stored level.
  const currentEffective = readSpook(coord, atMs);
  const newLevel         = Math.min(MAX_SPOOK, currentEffective + increment);

  // H-003: only write through the worldMap mutation surface.
  worldMap.mutateTileState(coord, (s) => ({
    ...s,
    spook: {
      level:         newLevel,
      updatedAtMs:   atMs,
      // sourceEventId is populated by future event-tracking (replay / diagnostics).
      // Set to null until that system is implemented (Phase 9).
      sourceEventId: null,
    },
  }));

  bus.emit('SPOOK_APPLIED', {
    coord,
    kind,
    increment,
    storedLevel: newLevel,
    atMs,
  });
}
