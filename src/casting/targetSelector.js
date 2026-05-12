/**
 * AFish Target Selector — src/casting/targetSelector.js
 *
 * Public API Contract: (no exported functions — purely event-driven menu FSM)
 *
 * Bridges Fish Finder scan results to the cast pipeline (D-041).
 * Consumes FISH_FINDER_RESULTS, presents a navigable candidate list to the player
 * via bus events (for TTS and audio), and emits TARGET_LOCKED when the player
 * confirms a selection.
 *
 * Lifecycle:
 *   Mounted in TOURNAMENT_ACTIVE via modeRouter mount manifest.
 *   All bus subscriptions are cancelled on onUnmount (H-005).
 *
 * Consumed bus events (onMount → onUnmount only):
 *   FISH_FINDER_RESULTS   { candidates, tier, poiId, atMs }
 *     → opens the selection menu; resets cursor to best-ranked (index 0).
 *   INPUT_ARROW_UP        → move cursor toward index 0 (best-ranked candidate).
 *   INPUT_ARROW_DOWN      → move cursor toward last candidate (lower-ranked).
 *   INPUT_SPACEBAR        → confirm the focused candidate → emit TARGET_LOCKED.
 *
 * Emitted bus events:
 *   SELECTION_OPENED      { count, tier, poiId, atMs }
 *     → TTS announces "N spots found" and the focused candidate.
 *   SELECTION_CURSOR_MOVED { candidate, idx, count, atMs }
 *     → TTS and audio/synthGraph.playFinderPing read candidate fields.
 *   SELECTION_CLOSED      { reason: 'CONFIRMED'|'CLEARED'|'UNMOUNT', atMs }
 *     → signals that the candidate list has been dismissed.
 *   SELECTION_BLOCKED     { reason: string, atMs }
 *     → emitted when the player tries to confirm but the action is blocked
 *       (e.g., no candidates, or scanLocked).
 *   TARGET_LOCKED         { poiId, offset, candidateId, lockedAtMs, finderTier }
 *     → consumed by castPipeline as the Tap-1 anchoring trigger (D-041, D-011, D-012).
 *
 * D-043 scan-lock guard:
 *   If state.tournament.scanLocked is true when SPACEBAR fires, TARGET_LOCKED is
 *   suppressed and SELECTION_BLOCKED is emitted instead. This prevents a new cast
 *   from starting while one is already in flight.
 *
 * H-014 boundary:
 *   This module does NOT import fishFinder.js or any other casting/* module.
 *   Communication is bus-only in both directions.
 *
 * Candidate list lifecycle:
 *   FISH_FINDER_RESULTS → menu opens with new candidates.
 *   FISH_FINDER_RESULTS (subsequent) → replaces the current list (new scan supersedes).
 *   TARGET_LOCKED emitted → list cleared immediately so arrow/spacebar events flow
 *     through to castPipeline without triggering any selector handler.
 *
 * Empty-list handling:
 *   If FISH_FINDER_RESULTS carries zero candidates (no spots detected at this tier),
 *   SELECTION_OPENED fires with count=0, cursor is reset, and input events are
 *   silently ignored until a new FISH_FINDER_RESULTS arrives. The player must re-scan.
 */

import * as bus        from '../core/eventBus.js';
import * as clock      from '../core/clock.js';
import * as stateStore from '../core/stateStore.js';
import * as modeRouter from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * The candidate list from the most recent FISH_FINDER_RESULTS.
 * Each entry is a frozen candidate object with at minimum: { id, offset }.
 * @type {Array<object>}
 */
let _candidates = [];

/**
 * Active cursor position within _candidates.
 * Index 0 = best-ranked candidate (highest structureScore after tier filtering).
 * @type {number}
 */
let _cursorIdx = 0;

/** Finder tier string from the most recent FISH_FINDER_RESULTS. @type {string|null} */
let _finderTier = null;

/** POI id from the most recent FISH_FINDER_RESULTS. @type {string|null} */
let _poiId = null;

/**
 * Whether the selection menu is currently open.
 * True between FISH_FINDER_RESULTS (with ≥1 candidate) and TARGET_LOCKED / clear.
 * @type {boolean}
 */
let _menuOpen = false;

/**
 * Bus unsubscribe functions acquired in onMount.
 * All must be called in onUnmount to satisfy H-005.
 * @type {Array<Function>}
 */
let _unsubs = [];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the candidate at the current cursor position, or null if empty.
 * @returns {object|null}
 */
function _focused() {
  if (_candidates.length === 0) return null;
  return _candidates[_cursorIdx] ?? null;
}

/**
 * Emit SELECTION_CURSOR_MOVED for the currently focused candidate.
 * Allows audio/synthGraph to play the finder ping and TTS to read the label.
 *
 * @param {number} atMs
 */
function _announceCurrentCandidate(atMs) {
  const candidate = _focused();
  if (!candidate) return;

  bus.emit('SELECTION_CURSOR_MOVED', {
    candidate,
    idx:   _cursorIdx,
    count: _candidates.length,
    atMs,
  });

  // TTS read-out for the focused candidate (D-042 accessibility).
  // Format: "<label>. <coverType>, <depthM>m deep. <idx+1> of <count>."
  const coverLabel = (candidate.coverType ?? 'Open water')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, c => c.toUpperCase());
  const depth = typeof candidate.depthM === 'number'
    ? `${candidate.depthM.toFixed(1)} metres deep`
    : '';
  const position = `${_cursorIdx + 1} of ${_candidates.length}`;
  const parts = [candidate.label ?? coverLabel];
  if (depth) parts.push(depth);
  parts.push(position);
  bus.emit('UI_ANNOUNCE', { text: parts.join('. ') + '.' });
}

/**
 * Open (or replace) the selection menu with a new candidate list.
 * Resets the cursor to index 0 (best-ranked candidate) and emits SELECTION_OPENED.
 * Immediately announces the focused candidate so the player hears the first entry.
 *
 * @param {Array<object>} candidates
 * @param {string}        tier
 * @param {string|null}   poiId
 * @param {number}        atMs
 */
function _openMenu(candidates, tier, poiId, atMs) {
  _candidates = candidates;
  _cursorIdx  = 0;
  _finderTier = tier;
  _poiId      = poiId;
  _menuOpen   = candidates.length > 0;

  bus.emit('SELECTION_OPENED', {
    count: candidates.length,
    tier,
    poiId,
    atMs,
  });

  if (candidates.length === 0) {
    bus.emit('UI_ANNOUNCE', { text: 'No fishing spots detected. Re-scan to try again.' });
    return;
  }

  // Announce the count + controls so the player knows how to navigate the list.
  bus.emit('UI_ANNOUNCE', {
    text: `${candidates.length} location${candidates.length === 1 ? '' : 's'} found. ` +
          'Use up and down arrows to browse. Press Spacebar to lock a target.',
  });

  // Announce cursor position immediately so the player knows where focus lands.
  _announceCurrentCandidate(atMs);
}

/**
 * Close the selection menu and clear candidate state.
 * Emits SELECTION_CLOSED so TTS/audio can dismiss any active announcement.
 *
 * No-op if the menu is already closed and the list is empty.
 *
 * @param {'CONFIRMED'|'CLEARED'|'UNMOUNT'} reason
 */
function _closeMenu(reason) {
  if (!_menuOpen && _candidates.length === 0) return;

  _candidates = [];
  _cursorIdx  = 0;
  _menuOpen   = false;

  bus.emit('SELECTION_CLOSED', { reason, atMs: clock.nowMs() });
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

/**
 * FISH_FINDER_RESULTS handler.
 * Opens or replaces the candidate menu.
 *
 * @param {{ candidates: Array, tier: string, poiId: string, atMs: number }} evt
 */
function _onFinderResults(evt) {
  const atMs       = evt.atMs ?? clock.nowMs();
  const candidates = Array.isArray(evt.candidates) ? evt.candidates : [];
  const tier       = typeof evt.tier   === 'string' ? evt.tier   : 'INTUITION';
  const poiId      = typeof evt.poiId  === 'string' ? evt.poiId  : null;

  _openMenu(candidates, tier, poiId, atMs);
}

/**
 * INPUT_ARROW_UP tap handler.
 * Moves the cursor toward index 0 (best-ranked candidate).
 * No-op when no candidates are available.
 *
 * @param {{ atMs?: number }} evt
 */
function _onArrowUp(evt) {
  if (!_menuOpen || _candidates.length === 0) return;

  const atMs = evt.atMs ?? clock.nowMs();
  _cursorIdx = Math.max(0, _cursorIdx - 1);
  _announceCurrentCandidate(atMs);
}

/**
 * INPUT_ARROW_DOWN tap handler.
 * Moves the cursor toward the last candidate (lower-ranked).
 * No-op when no candidates are available.
 *
 * @param {{ atMs?: number }} evt
 */
function _onArrowDown(evt) {
  if (!_menuOpen || _candidates.length === 0) return;

  const atMs = evt.atMs ?? clock.nowMs();
  _cursorIdx = Math.min(_candidates.length - 1, _cursorIdx + 1);
  _announceCurrentCandidate(atMs);
}

/**
 * INPUT_SPACEBAR tap handler.
 * Confirms the focused candidate and emits TARGET_LOCKED.
 *
 * D-043 guard: suppresses TARGET_LOCKED and emits SELECTION_BLOCKED if
 * state.tournament.scanLocked is true.
 *
 * @param {{ atMs?: number }} evt
 */
function _onSpacebar(evt) {
  if (!_menuOpen) return;

  const atMs      = evt.atMs ?? clock.nowMs();
  const candidate = _focused();

  if (!candidate) {
    // Menu is flagged open but list is empty — defensive close.
    _closeMenu('CLEARED');
    return;
  }

  // D-043: check scan-lock flag before committing.
  const scanLocked = stateStore.getState().tournament?.scanLocked ?? false;
  if (scanLocked) {
    bus.emit('SELECTION_BLOCKED', { reason: 'SCAN_LOCKED', atMs });
    return;
  }

  // Close the menu BEFORE emitting TARGET_LOCKED.
  // This ensures that subsequent INPUT events (e.g., the Tap-1 arrow for castPipeline)
  // are not intercepted by the (now-empty) selector handlers.
  _closeMenu('CONFIRMED');

  // Announce the locked target so the screen reader confirms the selection
  // before the cast sequence begins (D-042 accessibility).
  bus.emit('UI_ANNOUNCE', { text: `Target locked: ${candidate.label}` });

  // D-041, D-011: emit TARGET_LOCKED — the new Tap-1 anchoring trigger.
  // castPipeline samples the wind vector at this moment (D-012).
  bus.emit('TARGET_LOCKED', {
    poiId:       _poiId,
    offset:      candidate.offset,      // POI-frame { dx, dy } from structureIndex
    candidateId: candidate.id,
    lockedAtMs:  atMs,
    finderTier:  _finderTier,
  });
}

// ---------------------------------------------------------------------------
// Mount manifest (H-005)
// ---------------------------------------------------------------------------

modeRouter.registerMountManifest({
  id:    'targetSelector',
  modes: ['TOURNAMENT_ACTIVE'],

  /**
   * Acquire bus subscriptions when entering TOURNAMENT_ACTIVE.
   * All subscriptions are stored in _unsubs for cleanup in onUnmount.
   */
  onMount(_nextMode, _prevMode) {
    _candidates = [];
    _cursorIdx  = 0;
    _finderTier = null;
    _poiId      = null;
    _menuOpen   = false;

    _unsubs = [
      bus.on('FISH_FINDER_RESULTS', _onFinderResults),
      bus.on('INPUT_ARROW_UP',      _onArrowUp),
      bus.on('INPUT_ARROW_DOWN',    _onArrowDown),
      bus.on('INPUT_SPACEBAR',      _onSpacebar),
    ];
  },

  /**
   * Release all bus subscriptions and clear state when leaving TOURNAMENT_ACTIVE.
   * H-005: every handle acquired in onMount must be released here.
   */
  onUnmount(_prevMode, _nextMode) {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];

    _closeMenu('UNMOUNT');
    _finderTier = null;
    _poiId      = null;
  },
});
