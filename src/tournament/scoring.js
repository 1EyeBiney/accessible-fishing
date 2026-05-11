/**
 * AFish Tournament Scoring — src/tournament/scoring.js
 *
 * Public API Contract (§9 — TOURNAMENT):
 *   computeImpact(catchSpec)  → leaderboardImpact   (read-only; NO mutation)
 *   commit(catchSpec)         → void                 (mutates leaderboard)
 *   standings()               → AnglerStanding[]     (sorted by win condition)
 *   getLeaderboard()          → alias for standings()
 *   reset(tournamentSpec)     → void                 (clears state; called by onMount)
 *
 * Decisions implemented:
 *   D-061 — leaderboardImpact pre-computed by the emitter BEFORE bus.emit (H-016).
 *            This module provides computeImpact() as the read-only preview step and
 *            commit() as the mutation step. competitorAI.js calls them in order:
 *              1. impact = scoring.computeImpact(catchSpec)
 *              2. scoring.commit(catchSpec)
 *              3. bus.emit('AI_FISH_LANDED', { ...catchSpec, leaderboardImpact: impact })
 *            Player catches (FIGHT_RESOLVED { outcome: 'FISH_LANDED' }) are committed
 *            reactively — no leaderboardImpact pre-computation is required for them
 *            because fightLoop does not consume the leaderboard (H-016 applies to
 *            AI_FISH_LANDED emissions only; brief calls this event SIMULATED_CATCH).
 *   D-063 — Win-condition scoring (LOCKED):
 *              HEAVIEST_BAG      — top-5 fish by weight; rank by bag weight sum.
 *              BIGGEST_FISH      — single heaviest fish ever; rank by that weight.
 *              TOTAL_CATCH_COUNT — all fish count; rank by count then weight tiebreaker.
 *
 * Lifecycle (H-005):
 *   Mounted in TOURNAMENT_ACTIVE. onMount resets state and subscribes to FIGHT_RESOLVED.
 *   onUnmount cancels the bus subscription. Leaderboard state is retained through
 *   TOURNAMENT_RESULTS (read-only there); reset() fires on the next TOURNAMENT_ACTIVE
 *   entry to clear it for a new run.
 *
 * Events consumed:
 *   FIGHT_RESOLVED { outcome: 'FISH_LANDED', fishInstance, atMs } — player catch path.
 *   (AI catches are committed directly via scoring.commit() by competitorAI.js per H-016.
 *    scoring.js does NOT subscribe to AI_FISH_LANDED — that would cause double-commits.)
 *
 * Bag limit: BAG_LIMIT = 5 fish for HEAVIEST_BAG; 1 for BIGGEST_FISH; unlimited for COUNT.
 */

import * as bus        from '../core/eventBus.js';
import * as stateStore from '../core/stateStore.js';
import { MODES, registerMountManifest } from '../core/modeRouter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum fish in an angler's scoring bag (HEAVIEST_BAG win condition). */
export const BAG_LIMIT = 5;

/** Canonical win-condition identifiers (D-063, LOCKED). */
export const WIN_CONDITIONS = Object.freeze(['HEAVIEST_BAG', 'BIGGEST_FISH', 'TOTAL_CATCH_COUNT']);

// ---------------------------------------------------------------------------
// Type definitions (JSDoc only — no runtime cost)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CatchEntry
 * @property {string} speciesId
 * @property {number} weightKg
 * @property {number} atMs
 */

/**
 * @typedef {object} AnglerRecord
 * @property {string}       anglerId
 * @property {string}       displayName
 * @property {CatchEntry[]} fish        - ALL fish landed, chronological (never truncated)
 * @property {CatchEntry[]} bag         - active scoring bag (top-5, best-1, or all)
 * @property {number}       totalWeight - sum of bag weights or best weight; 0 for COUNT primary
 * @property {number}       catchCount  - total fish landed (primary key for TOTAL_CATCH_COUNT)
 */

/**
 * @typedef {object} LeaderboardImpact
 * @property {number}      newRank        - 1-based rank after committing this catch
 * @property {number}      previousRank   - 1-based rank before committing
 * @property {number}      newBagWeightKg - angler's total scoring weight after commit
 * @property {boolean}     tookTheLead    - true if angler moves to (or stays at) rank 1 for the first time with this catch
 * @property {string|null} knockedOff     - displayName of angler displaced from first, or null
 */

/**
 * @typedef {object} AnglerStanding
 * @property {number}       rank
 * @property {string}       anglerId
 * @property {string}       displayName
 * @property {number}       totalWeight
 * @property {number}       catchCount
 * @property {CatchEntry[]} bag
 */

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Map<string, AnglerRecord>} anglerId → live record */
let _leaderboard  = new Map();

/** @type {'HEAVIEST_BAG'|'BIGGEST_FISH'|'TOTAL_CATCH_COUNT'} */
let _winCondition = 'HEAVIEST_BAG';

/** Unsubscribe function returned by bus.on('FIGHT_RESOLVED', ...). */
let _unsubFightResolved = null;

// ---------------------------------------------------------------------------
// Private: bag state computation
// ---------------------------------------------------------------------------

/**
 * Ensure an angler record exists inside the given map.
 * Mutates `map`. Returns the (possibly new) record.
 *
 * @param {Map<string,AnglerRecord>} map
 * @param {string}                   anglerId
 * @param {string}                   displayName
 * @returns {AnglerRecord}
 */
function _ensureAngler(map, anglerId, displayName) {
  if (!map.has(anglerId)) {
    map.set(anglerId, {
      anglerId,
      displayName: displayName || anglerId,
      fish:        [],
      bag:         [],
      totalWeight: 0,
      catchCount:  0,
    });
  }
  return map.get(anglerId);
}

/**
 * Compute the next bag state for a record after adding `newCatch`.
 * DOES NOT mutate the record — returns a fresh snapshot.
 *
 * @param {AnglerRecord}                                           record
 * @param {CatchEntry}                                             newCatch
 * @param {'HEAVIEST_BAG'|'BIGGEST_FISH'|'TOTAL_CATCH_COUNT'}     winCondition
 * @returns {{ bag: CatchEntry[], totalWeight: number, catchCount: number }}
 */
function _computeNewBagState(record, newCatch, winCondition) {
  const allFish    = [...record.fish, newCatch];
  const catchCount = allFish.length;

  switch (winCondition) {
    case 'HEAVIEST_BAG': {
      // Top BAG_LIMIT fish by weight; total = bag weight sum.
      const sorted      = allFish.slice().sort((a, b) => b.weightKg - a.weightKg);
      const bag         = sorted.slice(0, BAG_LIMIT);
      const totalWeight = bag.reduce((sum, f) => sum + f.weightKg, 0);
      return { bag, totalWeight, catchCount };
    }

    case 'BIGGEST_FISH': {
      // Single-best discard logic (D-063): bag holds exactly the one heaviest fish.
      let best = allFish[0];
      for (const f of allFish) {
        if (f.weightKg > best.weightKg) best = f;
      }
      return { bag: [best], totalWeight: best.weightKg, catchCount };
    }

    case 'TOTAL_CATCH_COUNT': {
      // All fish count. catchCount is the primary rank key; totalWeight is tiebreaker.
      const totalWeight = allFish.reduce((sum, f) => sum + f.weightKg, 0);
      return { bag: allFish.slice(), totalWeight, catchCount };
    }

    default:
      throw new RangeError(`scoring._computeNewBagState: unknown winCondition "${winCondition}"`);
  }
}

// ---------------------------------------------------------------------------
// Private: standings sort
// ---------------------------------------------------------------------------

/**
 * Sort a leaderboard map into ranked standings.
 * Pure read — does NOT mutate the map.
 *
 * Sort keys (D-063):
 *   HEAVIEST_BAG / BIGGEST_FISH  — totalWeight desc, then catchCount desc.
 *   TOTAL_CATCH_COUNT            — catchCount desc, then totalWeight desc.
 *
 * @param {Map<string,AnglerRecord>} map
 * @returns {AnglerStanding[]}
 */
function _sortedStandings(map) {
  const records = [...map.values()];

  records.sort((a, b) => {
    switch (_winCondition) {
      case 'HEAVIEST_BAG':
      case 'BIGGEST_FISH':
        if (b.totalWeight !== a.totalWeight) return b.totalWeight - a.totalWeight;
        return b.catchCount - a.catchCount;

      case 'TOTAL_CATCH_COUNT':
        if (b.catchCount !== a.catchCount) return b.catchCount - a.catchCount;
        return b.totalWeight - a.totalWeight;

      default:
        return 0;
    }
  });

  return records.map((rec, idx) => ({
    rank:        idx + 1,
    anglerId:    rec.anglerId,
    displayName: rec.displayName,
    totalWeight: rec.totalWeight,
    catchCount:  rec.catchCount,
    bag:         rec.bag.slice(),  // snapshot; caller may not mutate
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reset leaderboard state for a new tournament run.
 *
 * Called automatically by the mount manifest onMount. May be called directly
 * in tests without needing to enter TOURNAMENT_ACTIVE mode.
 *
 * Pre-seeds the PLAYER record so the player always appears in standings from
 * the tournament start, even before landing their first fish.
 *
 * @param {object} [tournamentSpec] - snapshot from state.tournament.spec (D-019)
 * @param {string} [tournamentSpec.winCondition] - 'HEAVIEST_BAG' | 'BIGGEST_FISH' | 'TOTAL_CATCH_COUNT'
 */
function reset(tournamentSpec) {
  _leaderboard = new Map();

  _winCondition = WIN_CONDITIONS.includes(tournamentSpec?.winCondition)
    ? tournamentSpec.winCondition
    : 'HEAVIEST_BAG';

  // Pre-seed the player record.
  const playerName = stateStore.getState().profile.displayName ?? 'Player';
  _ensureAngler(_leaderboard, 'PLAYER', playerName);
}

/**
 * Compute the leaderboard impact of adding a catch, WITHOUT mutating the leaderboard.
 *
 * This is the read-only half of the H-016 atomic sequence.
 * Call this BEFORE commit() and BEFORE bus.emit():
 *
 *   const impact = scoring.computeImpact(catchSpec);  // read-only
 *   scoring.commit(catchSpec);                         // mutate
 *   bus.emit('AI_FISH_LANDED', { ...payload, leaderboardImpact: impact }); // emit
 *
 * The three steps must execute synchronously in one call-stack frame to
 * preserve H-016 (emit carries correct post-commit state) and H-018 (no
 * interleaving between concurrent same-tick bot catches).
 *
 * @param {object} catchSpec
 * @param {string} catchSpec.anglerId
 * @param {string} catchSpec.displayName
 * @param {string} catchSpec.speciesId
 * @param {number} catchSpec.weightKg
 * @param {number} catchSpec.atMs
 * @returns {LeaderboardImpact}
 */
function computeImpact(catchSpec) {
  const { anglerId, displayName, speciesId, weightKg, atMs } = catchSpec;

  // ── Clone the leaderboard (shallow clone of each record is sufficient) ───
  const cloneMap = new Map();
  for (const [id, rec] of _leaderboard) {
    cloneMap.set(id, { ...rec, fish: rec.fish.slice(), bag: rec.bag.slice() });
  }

  // Ensure the catcher exists in the clone (they may be a new entrant).
  _ensureAngler(cloneMap, anglerId, displayName);

  // ── Standings and leader BEFORE applying this catch ──────────────────────
  const beforeStandings = _sortedStandings(cloneMap);
  const leaderBefore    = beforeStandings[0] ?? null;
  const previousRank    = beforeStandings.find(s => s.anglerId === anglerId)?.rank
                          ?? beforeStandings.length + 1;

  // ── Apply the catch to the clone ─────────────────────────────────────────
  const clonedRec = cloneMap.get(anglerId);
  const newCatch  = { speciesId, weightKg, atMs };
  const newState  = _computeNewBagState(clonedRec, newCatch, _winCondition);
  cloneMap.set(anglerId, {
    ...clonedRec,
    fish:        [...clonedRec.fish, newCatch],
    bag:         newState.bag,
    totalWeight: newState.totalWeight,
    catchCount:  newState.catchCount,
  });

  // ── Standings AFTER ───────────────────────────────────────────────────────
  const afterStandings = _sortedStandings(cloneMap);
  const newRank        = afterStandings.find(s => s.anglerId === anglerId)?.rank
                         ?? afterStandings.length;
  const anglerAfter    = afterStandings.find(s => s.anglerId === anglerId);

  // tookTheLead: moved to rank 1 and was NOT rank 1 before this catch.
  const tookTheLead = newRank === 1 && leaderBefore?.anglerId !== anglerId;
  const knockedOff  = (tookTheLead && leaderBefore != null)
                      ? leaderBefore.displayName
                      : null;

  return {
    newRank,
    previousRank,
    newBagWeightKg: anglerAfter?.totalWeight ?? 0,
    tookTheLead,
    knockedOff,
  };
}

/**
 * Commit a catch to the live leaderboard (mutates module state).
 *
 * Per H-016: call computeImpact() BEFORE this, then bus.emit() AFTER this.
 * All three steps must be synchronous (no await, no setImmediate) to satisfy
 * the atomic ordering contract.
 *
 * @param {object} catchSpec
 * @param {string} catchSpec.anglerId
 * @param {string} catchSpec.displayName
 * @param {string} catchSpec.speciesId
 * @param {number} catchSpec.weightKg
 * @param {number} catchSpec.atMs
 */
function commit(catchSpec) {
  const { anglerId, displayName, speciesId, weightKg, atMs } = catchSpec;

  const record   = _ensureAngler(_leaderboard, anglerId, displayName);
  const newCatch = { speciesId, weightKg, atMs };
  const newState = _computeNewBagState(record, newCatch, _winCondition);

  // Apply in-place (the AnglerRecord object is the same reference callers may hold).
  record.fish.push(newCatch);
  record.bag         = newState.bag;
  record.totalWeight = newState.totalWeight;
  record.catchCount  = newState.catchCount;
}

/**
 * Return the current sorted leaderboard standings.
 *
 * Each element is a snapshot: mutating the returned array or its bag arrays
 * has no effect on the live leaderboard.
 *
 * Sort order is determined by the active win condition (D-063).
 *
 * @returns {AnglerStanding[]}
 */
function standings() {
  return _sortedStandings(_leaderboard);
}

/**
 * Alias for standings() — matches the user-facing method name.
 * @returns {AnglerStanding[]}
 */
function getLeaderboard() {
  return standings();
}

// ---------------------------------------------------------------------------
// Mount Manifest — TOURNAMENT_ACTIVE (H-005)
// ---------------------------------------------------------------------------

registerMountManifest({
  id:    'scoring',
  modes: [MODES.TOURNAMENT_ACTIVE],

  /**
   * Reset leaderboard for the new tournament and subscribe to FIGHT_RESOLVED
   * so player catches are committed automatically.
   *
   * AI catches (competitorAI.js) enter via direct scoring.commit() calls
   * BEFORE bus.emit('AI_FISH_LANDED'), satisfying H-016.
   * scoring.js does NOT subscribe to AI_FISH_LANDED — that would double-commit.
   */
  onMount(/* nextMode, prevMode */) {
    const spec = stateStore.getState().tournament.spec;
    reset(spec);

    _unsubFightResolved = bus.on('FIGHT_RESOLVED', (evt) => {
      // Only commit successful landings (D-036: LINE_SNAPPED / HOOK_SHAKEN are not catches).
      if (evt.outcome !== 'FISH_LANDED' || !evt.fishInstance) return;

      const playerName = stateStore.getState().profile.displayName ?? 'Player';
      commit({
        anglerId:    'PLAYER',
        displayName: playerName,
        speciesId:   evt.fishInstance.speciesId,
        weightKg:    evt.fishInstance.weightKg,
        atMs:        evt.atMs,
      });
    });
  },

  /**
   * Cancel the FIGHT_RESOLVED subscription (H-005 mount-manifest cleanup).
   * The leaderboard itself is NOT cleared here — it remains readable during
   * TOURNAMENT_RESULTS. reset() will clear it on the next onMount.
   */
  onUnmount(/* prevMode, nextMode */) {
    if (_unsubFightResolved) {
      _unsubFightResolved();
      _unsubFightResolved = null;
    }
  },
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { computeImpact, commit, standings, getLeaderboard, reset };
