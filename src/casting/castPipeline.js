/**
 * AFish Cast Pipeline — src/casting/castPipeline.js
 *
 * Public API Contract: (no exported functions — purely event-driven FSM)
 *
 * Owns the full 5-tap "Accessible Golf" casting sequence from TARGET_LOCKED
 * through CAST_LANDED (D-014 v1.14 revision).  Implements Bird's Nest
 * penalty for ARROW whiffs only (D-015 v1.14), Spool Wall boundary clamping
 * (D-016), mismatched-lure scatter penalty (D-052), scan mutual exclusion
 * (D-043), and the D-070 2500 ms accessibility floor on metronome phases.
 *
 * Lifecycle:
 *   Mounted in TOURNAMENT_ACTIVE via modeRouter mount manifest.
 *   All bus subscriptions and clock handles are released on onUnmount (H-005).
 *
 * ── Cast FSM Phases (D-014 v1.14 — Accessible Golf) ─────────────────────────
 *
 *   IDLE
 *     Waiting for TARGET_LOCKED (emitted by targetSelector after player confirms).
 *     All input events are ignored in this phase.
 *
 *   LURE_SELECT  (entered on TARGET_LOCKED — D-072)
 *     Wind vector sampled and held for the cast's lifetime (D-012).
 *     D-071 rod auto-select writes cast.activeRodId (AUTO-SELECT ONLY).
 *     state.tournament.scanLocked set → blocks new scans (D-043).
 *     LURE_OPTIONS emitted; player cycles with ARROW_UP/DOWN, confirms with
 *     SPACEBAR (→ LURE_LOCKED → ARMED), cancels with ESC (→ IDLE, scan unlocked).
 *     No whiff timer in this phase.
 *
 *   ARMED  (entered on LURE_LOCKED)
 *     Awaiting Tap 1 — ARROW_UP.  No whiff timer (D-015 v1.14: player may
 *     sit here indefinitely before the backswing).
 *
 *   PHASE_1_METRONOME  (entered on Tap 1 ARROW_UP)
 *     Records _tap1AtMs = phase1StartAtMs.  Fixed-duration metronome runs
 *     for CAST_PHASE_MIN_MS (D-070).  Emits AUDIO_METRONOME_TICK on each
 *     beat (D-021 addendum).  Player MAY tap SPACEBAR once during this
 *     window — _tap2AtMs is recorded for wind-mitigation math.  Missing
 *     the Spacebar yields 0% mitigation but does NOT Bird's Nest the cast
 *     (D-014 rev, D-015 rev).  Whiff timer is OFF during this phase.
 *     Transitions to PHASE_2_ACCURACY automatically when the metronome ends.
 *
 *   PHASE_2_ACCURACY  (auto-entered when PHASE_1 metronome ends)
 *     Records phase2StartAtMs.  Emits AUDIO_PITCH_SWEEP {direction:'UP'} so
 *     synthGraph runs a rising pitch ramp.  Awaiting Tap 3 — ARROW_UP.
 *     Arrow whiff timer running.  Tap 3 instantly locks accuracy (computes
 *     scatter radius from Phase-2 reaction time) and starts PHASE_3.
 *
 *   PHASE_3_METRONOME  (entered on Tap 3 ARROW_UP)
 *     Records _tap3AtMs = phase3StartAtMs.  Fixed-duration metronome runs
 *     for CAST_PHASE_MIN_MS.  Emits AUDIO_METRONOME_TICK on each beat.
 *     Player MAY tap SPACEBAR once — _tap4AtMs recorded for mitigation math.
 *     Whiff timer is OFF.  Transitions to PHASE_4_IMPACT when metronome ends.
 *
 *   PHASE_4_IMPACT  (auto-entered when PHASE_3 metronome ends)
 *     Records phase4StartAtMs.  Emits AUDIO_PITCH_SWEEP {direction:'DOWN'}.
 *     Awaiting Tap 5 — ARROW_DOWN.  Arrow whiff timer running.
 *
 *   → CAST_LANDED  (on Tap 5 ARROW_DOWN)
 *     Computes mitigation factor from Spacebar timing match across the two
 *     metronomes (0 if either Spacebar was missed).  Computes final landing
 *     offset: target + wind drift (mitigated) + scatter.
 *     D-016 Spool Wall: clamps landing to POI frameRadius if exceeded.
 *     Determines splash kind (SILENT / NORMAL / LOUD) from cast accuracy.
 *     Calls castSpookModel.applySplash on the landing tile.
 *     Emits CAST_LANDED bus event (consumed by fishBehavior Phase 6).
 *     Dispatches CAST_PHASE_CHANGED({ cast: null }) and SCAN_UNLOCKED.
 *     Returns to IDLE.
 *
 * ── Whiff / Bird's Nest (D-015 v1.14) ────────────────────────────────────────
 *
 *   The arrow whiff timer runs ONLY during ARROW-expecting phases:
 *     ARMED            (awaiting Tap 1 ARROW_UP)
 *     PHASE_2_ACCURACY (awaiting Tap 3 ARROW_UP)
 *     PHASE_4_IMPACT   (awaiting Tap 5 ARROW_DOWN)
 *
 *   If the player fails to deliver the expected arrow within ARROW_WHIFF_TIMEOUT_MS
 *   the cast is voided:
 *     1. inputAdapter.lock('BIRDS_NEST', nestDurationMs) — physical lockout.
 *        nestDurationMs is random in [BIRDS_NEST_MIN_MS, BIRDS_NEST_MAX_MS].
 *     2. CAST_BIRDS_NEST bus event emitted { nestDurationMs, phase, atMs }.
 *     3. CAST_PHASE_CHANGED({ cast: null }) dispatched.
 *     4. SCAN_UNLOCKED dispatched.
 *     5. State reset to IDLE.
 *
 *   Spacebar misses are SILENT (D-015 rev) — they do not Bird's Nest.
 *   The world clock CONTINUES to run during the lockout (D-015, D-013).
 *
 * ── Scatter Math (D-014 rev: Phase-2 reaction-based) ─────────────────────────
 *
 *   reactionMs   = _tap3AtMs − phase2StartAtMs
 *   deviation    = |reactionMs − IDEAL_REACTION_MS|
 *   quality      = clamp(1 − deviation / SCATTER_QUALITY_WINDOW, 0, 1)
 *   baseScatter  = lerp(MAX_SCATTER_TILES, MIN_SCATTER_TILES, quality)
 *   After D-052 lure-weight mismatch check: scatter *= MISMATCH_SCATTER_MULTIPLIER.
 *
 * ── Mitigation Math (D-014 rev: metronome-anchored) ──────────────────────────
 *
 *   relTap2 = _tap2AtMs − phase1StartAtMs   (offset into Phase-1 metronome)
 *   relTap4 = _tap4AtMs − phase3StartAtMs   (offset into Phase-3 metronome)
 *   If either Spacebar was missed → mitigation = 0 (D-014 rev).
 *   Otherwise:
 *     deviation    = |relTap4 − relTap2|
 *     quality      = clamp(1 − deviation / MITIGATION_MATCH_WINDOW_MS, 0, 1)
 *     mitigFactor  = quality       (0 = no reduction, 1 = full 80% reduction)
 *   Wind reduction applied = mitigFactor × 0.80 (D-014: perfect = 80%, not 100%).
 *
 * ── Splash Kind → Spook (D-014, D-038) ──────────────────────────────────────
 *
 *   accuracy = 1 − clamp(scatterRadius / MAX_SCATTER_TILES, 0, 1)
 *   SILENT : accuracy > SPLASH_SILENT_THRESHOLD  (0.75) → spook increment = 0
 *   NORMAL : accuracy ≥ SPLASH_NORMAL_THRESHOLD  (0.35) → spook increment = +1
 *   LOUD   : accuracy < SPLASH_NORMAL_THRESHOLD          → spook increment = +3
 *
 * ── Audio Events (D-021 v1.14 addendum) ──────────────────────────────────────
 *
 *   AUDIO_METRONOME_TICK { phase, beatIndex, totalBeats, atMs }
 *     — emitted on each beat of PHASE_1 and PHASE_3 metronomes.
 *     Consumed exclusively by audio/synthGraph.js.
 *
 *   AUDIO_PITCH_SWEEP { phase, direction: 'UP'|'DOWN', durationMs, atMs }
 *     — emitted on entry to PHASE_2 (UP) and PHASE_4 (DOWN).
 *     Sweep duration is the whiff window (ARROW_WHIFF_TIMEOUT_MS).
 *
 *   castPipeline NEVER imports any audio module.  All audio coupling is bus-only.
 *
 * ── Spool Wall (D-016) ───────────────────────────────────────────────────────
 *
 *   If |landing| > poi.frameRadius: landing is scaled to exactly frameRadius.
 *   The lure drops straight down at the boundary.  Spook is applied at the
 *   clamped coordinate, not the intended landing.
 *
 * ── Scan Lock (D-043) ────────────────────────────────────────────────────────
 *
 *   SCAN_LOCKED dispatched on TARGET_LOCKED received (entering LURE_SELECT).
 *   SCAN_UNLOCKED dispatched on CAST_LANDED, CAST_BIRDS_NEST, and ESC from LURE_SELECT.
 *   SCAN_UNLOCKED also dispatched in onUnmount if the pipeline was mid-cast.
 *
 * ── Events Emitted ───────────────────────────────────────────────────────────
 *
 *   CAST_PHASE_CHANGED   { cast: { phase, ...extra } | null, atMs }
 *   AUDIO_METRONOME_TICK { phase, beatIndex, totalBeats, atMs }
 *   AUDIO_PITCH_SWEEP    { phase, direction, durationMs, atMs }
 *   AUDIO_STOP_SWEEP     { atMs }
 *   CAST_BIRDS_NEST      { nestDurationMs, phase, atMs }
 *   CAST_LANDED          { poiId, candidateId, finderTier, landing, target,
 *                          splashKind, scatterRadius, mitigationFactor, atMs }
 *   CAST_ABORTED         { mode: 'SOFT'|'RIP', clockPenaltyMs, atMs }  (D-081)
 *   LURE_OPTIONS         { lures, recommendedLureId, atMs }  (D-072)
 *   LURE_LOCKED          { lureId, atMs }  (D-072)
 *   TARGET_RETAINED      { poiId, offset, candidateId, lockedAtMs, finderTier,
 *                          recastCount, atMs }  (D-073)
 *   STATE_ANNOUNCE       { token: 'TIME_TO_CAST'|'TIME_TO_FISH'|'LURE_RETRIEVED'|'LINE_RIPPED', atMs }  (D-080)
 *
 * ── Cast Abortion / Retrieve Actions (D-081 v1.17) ───────────────────────────
 *
 *   Available in ARMED state (pre-cast) or in IDLE state when a previous cast
 *   has landed (indicated by _lastLandingCoord being non-null).
 *   Both actions preserve state.tournament.lastTarget (D-073 camping intact).
 *   Neither action is available during the metronome / impact phases — those
 *   phases use the Bird's Nest whiff timer as their only abort path (D-015).
 *
 *   INPUT_R — Soft Retrieve:
 *     Clock penalty: SOFT_RETRIEVE_CLOCK_PENALTY_MS (5000 ms)
 *     Spook: none applied (lure exits cleanly)
 *     Emits: STATE_ANNOUNCE { token: 'LURE_RETRIEVED' }
 *     Emits: CAST_ABORTED { mode: 'SOFT', clockPenaltyMs: 5000, atMs }
 *     Then:  clock.tick(5000)  (after CAST_ABORTED so fishBehavior cancels
 *            pending bite timers before the tick can fire them)
 *
 *   INPUT_Q — Power Rip:
 *     Clock penalty: POWER_RIP_CLOCK_PENALTY_MS (2000 ms)
 *     Spook: castSpookModel.applySplash at lure's last known position, kind=NORMAL (+1 D-038)
 *            (uses _lastLandingCoord if available; uses target coord from ARMED state)
 *     Emits: STATE_ANNOUNCE { token: 'LINE_RIPPED' }
 *     Emits: CAST_ABORTED { mode: 'RIP', clockPenaltyMs: 2000, atMs }
 *     Then:  clock.tick(2000)
 *
 * ── Mode-Aware State Announcer (D-080 v1.17) ─────────────────────────────────
 *
 *   castPipeline emits STATE_ANNOUNCE at four narrative transitions:
 *     TIME_TO_CAST   — on LURE_LOCKED → ARMED (player is about to cast)
 *     TIME_TO_FISH   — on CAST_LANDED (lure is in the water)
 *     LURE_RETRIEVED — on Soft Retrieve abort
 *     LINE_RIPPED    — on Power Rip abort
 *   Consumed by audio/ttsQueue.js at NORMAL priority (D-062) with 3s coalescing.
 *   H-022: STATE_ANNOUNCE is preemptable by BITE_NIBBLE/BITE_THUD/FIGHT events.
 *
 * H-005 note: All _unsubs, _whiffHandle, _metronomeEndHandle, and _metronomeTickHandle
 *             are cancelled in onUnmount.
 * H-014 note: This module does NOT import fishFinder.js or targetSelector.js.
 * H-020 note: LURE_SELECT sub-state is owned here (castPipeline), NOT targetSelector
 *             (D-072a). targetSelector remains target-only.
 * D-021 note: This module does NOT import any audio module.
 */

import * as bus            from '../core/eventBus.js';
import * as clock          from '../core/clock.js';
import * as rng            from '../core/rng.js';
import * as stateStore     from '../core/stateStore.js';
import * as inputAdapter   from '../core/inputAdapter.js';
import * as modeRouter     from '../core/modeRouter.js';
import * as wind           from '../navigation/wind.js';
import * as poiGraph       from '../world/poiGraph.js';
import * as equipment      from '../equipment/equipment.js';
import * as castSpookModel from './castSpookModel.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bird's Nest fires if the expected ARROW tap does not arrive within this
 * window (D-015 v1.14). Active only during ARMED, PHASE_2_ACCURACY,
 * and PHASE_4_IMPACT. Spacebar misses do NOT consult this timer.
 * 2 400 ms = 120% of the 2 000 ms ideal window (legacy Accessible Golf pacing).
 */
const ARROW_WHIFF_TIMEOUT_MS = 2_400;

/** Minimum Bird's Nest lockout duration in ms (D-015). */
const BIRDS_NEST_MIN_MS = 10_000;

/** Maximum Bird's Nest lockout duration in ms (D-015). */
const BIRDS_NEST_MAX_MS = 15_000;

/**
 * Fixed-duration metronome length for PHASE_1 and PHASE_3 (D-014 v1.14).
 * D-070 mandates a 2500 ms accessibility floor for cognitive reaction time.
 */
const CAST_PHASE_MIN_MS = 2_500;

/** Total metronome beats emitted across CAST_PHASE_MIN_MS (4 beats = 625 ms apart). */
const METRONOME_BEAT_COUNT = 4;

/**
 * Ideal Phase-2 reaction time in ms. Tapping ARROW_UP exactly 2 000 ms after
 * the rising pitch sweep starts yields 100% power/accuracy (legacy Accessible
 * Golf engine match).  The whiff fires at 2 400 ms (120% overswing).
 */
const IDEAL_REACTION_MS = 2_000;

/**
 * Maximum deviation from IDEAL_REACTION_MS before scatter quality hits 0.
 * Tuned wider than the original free-rhythm window because the player is
 * reacting to an audio cue rather than internal timing.
 */
const SCATTER_QUALITY_WINDOW = 1_500;

/** Minimum scatter radius in tiles (perfect timing, no mismatch penalty). */
const MIN_SCATTER_TILES = 0.05;

/** Maximum scatter radius in tiles (worst timing or max mismatch penalty). */
const MAX_SCATTER_TILES = 2.5;

/**
 * Maximum deviation between (Tap2 offset into Phase-1 metronome) and
 * (Tap4 offset into Phase-3 metronome) before mitigation quality hits 0.
 */
const MITIGATION_MATCH_WINDOW_MS = 600;

/**
 * Scatter multiplier applied when lure weight is outside the rod's rated
 * range (D-052). Accuracy-only penalty; no distance penalty, no Bird's Nest.
 */
const MISMATCH_SCATTER_MULTIPLIER = 2.0;

/** Wind drift scale: tiles of drift per (m/s of wind) at 0% mitigation. */
const WIND_DRIFT_SCALE = 0.25;

/**
 * Tournament-clock penalty for Soft Retrieve (D-081, v1.17).
 * Player manually retrieves the lure — a deliberate time cost.
 */
const SOFT_RETRIEVE_CLOCK_PENALTY_MS = 5_000;

/**
 * Tournament-clock penalty for Power Rip (D-081, v1.17).
 * Player violently rips the lure — shorter penalty but creates +1 NORMAL spook.
 */
const POWER_RIP_CLOCK_PENALTY_MS = 2_000;

/** Accuracy threshold above which the splash is SILENT (spook +0, D-038). */
const SPLASH_SILENT_THRESHOLD = 0.75;

/** Accuracy threshold above which the splash is NORMAL (+1 spook); below = LOUD (+3). */
const SPLASH_NORMAL_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Current FSM phase.
 * @type {'IDLE'|'LURE_SELECT'|'ARMED'|'PHASE_1_METRONOME'|'PHASE_2_ACCURACY'|'PHASE_3_METRONOME'|'PHASE_4_IMPACT'}
 */
let _phase = 'IDLE';

/**
 * Target committed at TARGET_LOCKED (D-011 anchoring).
 * @type {{ poiId: string, offset: {dx:number, dy:number}, candidateId: string, finderTier: string } | null}
 */
let _target = null;

/**
 * Wind vector sampled at TARGET_LOCKED time (D-012, held constant for flight).
 * @type {{ dx: number, dy: number, intensityMs: number } | null}
 */
let _windAtCast = null;

/** Tap 1 — ARROW_UP that starts PHASE_1 metronome. Equals phase1StartAtMs. */
let _tap1AtMs = null;
/** Tap 2 — optional SPACEBAR during PHASE_1.  null if missed (→ 0% mitigation). */
let _tap2AtMs = null;
/** Tap 3 — ARROW_UP that locks accuracy and starts PHASE_3 metronome. Equals phase3StartAtMs. */
let _tap3AtMs = null;
/** Tap 4 — optional SPACEBAR during PHASE_3.  null if missed (→ 0% mitigation). */
let _tap4AtMs = null;

/** When PHASE_2_ACCURACY started (basis for reaction-based scatter math). */
let _phase2StartAtMs = null;
/** When PHASE_4_IMPACT started (recorded for diagnostic completeness). */
let _phase4StartAtMs = null;

/** Computed scatter radius in tiles, set at Tap 3. */
let _scatterRadius = 0;

/** Computed mitigation factor [0,1], set at Tap 5 just before landing. */
let _mitigationFactor = 0;

/** Clock handle for the arrow whiff (Bird's Nest) timer.  Null when inactive. */
let _whiffHandle = null;

/** Clock handle for the end-of-metronome auto-transition.  Null when inactive. */
let _metronomeEndHandle = null;

/** Array of clock handles for per-beat AUDIO_METRONOME_TICK emissions. */
let _metronomeTickHandles = [];

/**
 * Lazy-initialised RNG stream for cast scatter and Bird's Nest duration (§5d).
 * Created on first use after engine.boot() has called rng.seed().
 * @type {{ next():number, int(min:number,max:number):number } | null}
 */
let _castRng = null;

/**
 * Lure options list built for the LURE_SELECT phase (D-072).
 * @type {Array<{ lureId:string, category:string, tier:number, matchScore:number, sweetWeightOk:boolean }>}
 */
let _lureOptions = [];

/** Current cursor index within _lureOptions during LURE_SELECT. */
let _selectedLureIdx = 0;

/**
 * How many times the player has re-cast at the current retained target (D-073).
 * For TTS coalescing only — NOT a math input (D-073 explicit).
 */
let _recastCount = 0;

/**
 * Absolute tile coordinate where the lure most recently splashed down.
 * Set on CAST_LANDED; cleared in _resetToIdle.
 * Used by Soft Retrieve and Power Rip to know the lure's last known position.
 * Also acts as the gate: non-null means "a cast has landed and we are in
 * post-cast IDLE, eligible for retreat actions" (D-081).
 * @type {{ x: number, y: number } | null}
 */
let _lastLandingCoord = null;

/**
 * Bus unsubscribe functions acquired in onMount.
 * @type {Array<Function>}
 */
let _unsubs = [];

// ---------------------------------------------------------------------------
// RNG helper
// ---------------------------------------------------------------------------

function _getRng() {
  if (!_castRng) _castRng = rng.rngStream('cast');
  return _castRng;
}

// ---------------------------------------------------------------------------
// Arrow whiff (Bird's Nest) timer management (D-015 v1.14)
// ---------------------------------------------------------------------------

/**
 * Schedule an arrow whiff timer for ARROW_WHIFF_TIMEOUT_MS from now.
 * Called on entry to every arrow-expecting phase (ARMED, PHASE_2, PHASE_4).
 */
function _scheduleWhiff() {
  _cancelWhiff();
  _whiffHandle = clock.schedule(ARROW_WHIFF_TIMEOUT_MS, _fireBirdNest);
}

function _cancelWhiff() {
  if (_whiffHandle !== null) {
    clock.cancel(_whiffHandle);
    _whiffHandle = null;
  }
}

/**
 * Fires when an arrow whiff timer elapses (Bird's Nest penalty).
 *
 * D-015 v1.14: the penalty is an input lockout of 10–15 s. World clock
 * continues to run. Lockout duration is randomised to prevent exploitable
 * patterns. D-030: inputAdapter.lock() emits forced INPUT_*_UP events for
 * held inputs — no hold-state leaks.
 *
 * @param {number} atMs — clock time at which the timer fired
 */
function _fireBirdNest(atMs) {
  _whiffHandle = null;

  // Stop any metronome / pitch sweep activity so audio isn't left running.
  _cancelMetronomeTimers();

  // Kill any active sweep immediately so it doesn't bleed into the lockout.
  bus.emit('AUDIO_STOP_SWEEP', { atMs });

  const nestDurationMs = _getRng().int(BIRDS_NEST_MIN_MS, BIRDS_NEST_MAX_MS);
  const prevPhase      = _phase;

  inputAdapter.lock('BIRDS_NEST', nestDurationMs);

  bus.emit('CAST_BIRDS_NEST', {
    nestDurationMs,
    phase: prevPhase,
    atMs,
  });

  _resetToIdle();
}

// ---------------------------------------------------------------------------
// Metronome / pitch-sweep timer management (D-014 rev, D-021 addendum)
// ---------------------------------------------------------------------------

/**
 * Start the fixed-duration metronome for PHASE_1 or PHASE_3.
 *
 * Schedules:
 *   • Per-beat AUDIO_METRONOME_TICK emissions (METRONOME_BEAT_COUNT beats).
 *   • End-of-phase auto-transition via _onMetronomeEnd.
 *
 * @param {'PHASE_1_METRONOME'|'PHASE_3_METRONOME'} phase
 */
function _startMetronome(phase) {
  _cancelMetronomeTimers();

  const beatIntervalMs = CAST_PHASE_MIN_MS / METRONOME_BEAT_COUNT;

  // Beat 0 fires immediately so the player hears the metronome start.
  bus.emit('AUDIO_METRONOME_TICK', {
    phase,
    beatIndex:  0,
    totalBeats: METRONOME_BEAT_COUNT,
    atMs:       clock.nowMs(),
  });

  // Beats 1..N-1 scheduled via clock.schedule.
  for (let i = 1; i < METRONOME_BEAT_COUNT; i++) {
    const handle = clock.schedule(beatIntervalMs * i, (firedAtMs) => {
      bus.emit('AUDIO_METRONOME_TICK', {
        phase,
        beatIndex:  i,
        totalBeats: METRONOME_BEAT_COUNT,
        atMs:       firedAtMs,
      });
    });
    _metronomeTickHandles.push(handle);
  }

  // End of metronome — auto-advance to the next phase.
  _metronomeEndHandle = clock.schedule(CAST_PHASE_MIN_MS, _onMetronomeEnd);
}

/** Cancel every scheduled metronome / tick handle. Safe when idle. */
function _cancelMetronomeTimers() {
  if (_metronomeEndHandle !== null) {
    clock.cancel(_metronomeEndHandle);
    _metronomeEndHandle = null;
  }
  for (const h of _metronomeTickHandles) clock.cancel(h);
  _metronomeTickHandles = [];
}

/**
 * Called when the PHASE_1 or PHASE_3 metronome completes its full duration.
 * Auto-advances to the corresponding sweep phase (PHASE_2 or PHASE_4) and
 * emits AUDIO_PITCH_SWEEP for synthGraph.
 *
 * @param {number} atMs
 */
function _onMetronomeEnd(atMs) {
  _metronomeEndHandle = null;

  if (_phase === 'PHASE_1_METRONOME') {
    _phase2StartAtMs = atMs;
    _phase = 'PHASE_2_ACCURACY';

    bus.emit('AUDIO_PITCH_SWEEP', {
      phase:      'PHASE_2_ACCURACY',
      direction:  'UP',
      durationMs: ARROW_WHIFF_TIMEOUT_MS,
      atMs,
    });

    _dispatchPhase({
      phase:           'PHASE_2_ACCURACY',
      phase2StartAtMs: _phase2StartAtMs,
      atMs,
    });

    // Arm whiff timer for Tap 3 (ARROW_UP).
    _scheduleWhiff();

  } else if (_phase === 'PHASE_3_METRONOME') {
    _phase4StartAtMs = atMs;
    _phase = 'PHASE_4_IMPACT';

    bus.emit('AUDIO_PITCH_SWEEP', {
      phase:      'PHASE_4_IMPACT',
      direction:  'DOWN',
      durationMs: ARROW_WHIFF_TIMEOUT_MS,
      atMs,
    });

    _dispatchPhase({
      phase:           'PHASE_4_IMPACT',
      phase4StartAtMs: _phase4StartAtMs,
      atMs,
    });

    // Arm whiff timer for Tap 5 (ARROW_DOWN).
    _scheduleWhiff();
  }
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

/**
 * Dispatch CAST_PHASE_CHANGED to stateStore and emit the matching bus event.
 *
 * @param {{ phase: string, [key:string]: * } | null} castObj — null when IDLE
 */
function _dispatchPhase(castObj) {
  stateStore.dispatch({
    type:    'CAST_PHASE_CHANGED',
    payload: { cast: castObj },
  });
  bus.emit('CAST_PHASE_CHANGED', {
    cast:  castObj,
    atMs:  clock.nowMs(),
  });
}

/** Reset FSM state and unlock scan if mid-cast. */
function _resetToIdle() {
  const wasActive = _phase !== 'IDLE';

  _cancelWhiff();
  _cancelMetronomeTimers();

  _phase            = 'IDLE';
  _target           = null;
  _windAtCast       = null;
  _tap1AtMs         = null;
  _tap2AtMs         = null;
  _tap3AtMs         = null;
  _tap4AtMs         = null;
  _phase2StartAtMs  = null;
  _phase4StartAtMs  = null;
  _scatterRadius    = 0;
  _mitigationFactor = 0;
  _lureOptions      = [];
  _selectedLureIdx  = 0;
  _lastLandingCoord = null;
  // _recastCount is NOT reset here — it is reset on new TARGET_LOCKED (D-073).

  _dispatchPhase(null);

  if (wasActive) {
    stateStore.dispatch({ type: 'SCAN_UNLOCKED' });
  }
}

// ---------------------------------------------------------------------------
// Scatter & Mitigation math (D-014 v1.14)
// ---------------------------------------------------------------------------

/**
 * Scatter radius in tiles based on Phase-2 reaction time (Tap 3 latency
 * relative to the rising pitch sweep start) plus optional D-052 lure-
 * weight mismatch penalty.
 *
 * @returns {number} scatter radius in tiles, ≥ MIN_SCATTER_TILES
 */
function _computeScatterRadius() {
  const reactionMs = _tap3AtMs - _phase2StartAtMs;
  const deviation  = Math.abs(reactionMs - IDEAL_REACTION_MS);
  const quality    = Math.max(0, 1 - deviation / SCATTER_QUALITY_WINDOW);

  // Lerp: quality=1 → MIN_SCATTER, quality=0 → MAX_SCATTER.
  let scatter = MIN_SCATTER_TILES + (1 - quality) * (MAX_SCATTER_TILES - MIN_SCATTER_TILES);

  if (_isLureWeightMismatched()) {
    scatter = Math.min(MAX_SCATTER_TILES, scatter * MISMATCH_SCATTER_MULTIPLIER);
  }

  return scatter;
}

/**
 * Wind-mitigation factor based on how well the player matched the Spacebar
 * timing across the two metronomes (D-014 v1.14).
 *
 * Returns 0 if either Spacebar was missed (D-014 rev).
 *
 * @returns {number} mitigation factor in [0, 1]
 */
function _computeMitigationFactor() {
  if (_tap2AtMs === null || _tap4AtMs === null) {
    return 0;
  }

  const relTap2   = _tap2AtMs - _tap1AtMs; // offset into Phase-1 metronome
  const relTap4   = _tap4AtMs - _tap3AtMs; // offset into Phase-3 metronome
  const deviation = Math.abs(relTap4 - relTap2);

  return Math.max(0, 1 - deviation / MITIGATION_MATCH_WINDOW_MS);
}

/**
 * True if the first lure in the active loadout is outside the rated weight
 * range of the first rod (D-052). Defensive: falls back to false on any
 * missing-data error.
 *
 * @returns {boolean}
 */
function _isLureWeightMismatched() {
  try {
    const state        = stateStore.getState();
    const activeTackle = state.tournament?.activeTackle ?? state.hub?.activeTackle;
    if (!activeTackle) return false;

    const rodEntry  = activeTackle.rods?.[0];
    const lureEntry = activeTackle.lures?.[0];
    if (!rodEntry || !lureEntry) return false;

    const rodDef  = equipment.getRod(rodEntry.id);
    const lureDef = equipment.getLure(lureEntry.id);
    const w       = lureDef.weightOz;
    const range   = rodDef.lureWeightRangeOz;

    return w < range.min || w > range.max;
  } catch {
    return false;
  }
}

/**
 * Splash kind from current scatter accuracy (D-014, D-038).
 * @returns {'SILENT'|'NORMAL'|'LOUD'}
 */
function _determineSplashKind() {
  const accuracy = 1 - Math.min(1, _scatterRadius / MAX_SCATTER_TILES);
  if (accuracy > SPLASH_SILENT_THRESHOLD) return 'SILENT';
  if (accuracy >= SPLASH_NORMAL_THRESHOLD) return 'NORMAL';
  return 'LOUD';
}

// ---------------------------------------------------------------------------
// Landing offset computation (D-011, D-012, D-016)
// ---------------------------------------------------------------------------

function _computeLanding(frameRadius) {
  const rngStream = _getRng();

  const windStrength  = (_windAtCast.intensityMs ?? 0) * WIND_DRIFT_SCALE;
  const windReduction = _mitigationFactor * 0.80;
  const effectiveWind = windStrength * (1 - windReduction);

  const windDrift = {
    dx: (_windAtCast.dx ?? 0) * effectiveWind,
    dy: (_windAtCast.dy ?? 0) * effectiveWind,
  };

  const scatterAngle = rngStream.next() * 2 * Math.PI;
  const scatterMag   = rngStream.next() * _scatterRadius;

  const scatter = {
    dx: Math.cos(scatterAngle) * scatterMag,
    dy: Math.sin(scatterAngle) * scatterMag,
  };

  const landing = {
    dx: (_target.offset.dx ?? 0) + windDrift.dx + scatter.dx,
    dy: (_target.offset.dy ?? 0) + windDrift.dy + scatter.dy,
  };

  // D-016 Spool Wall — clamp to frameRadius.
  const dist = Math.hypot(landing.dx, landing.dy);
  if (dist > frameRadius) {
    const scale = frameRadius / dist;
    landing.dx *= scale;
    landing.dy *= scale;
  }

  return landing;
}

function _getFrameRadius() {
  try {
    const poiId = stateStore.getState().session?.player?.currentPoiId ?? _target?.poiId;
    if (!poiId) return 10;
    const poi = poiGraph.getPoi(poiId);
    return poi?.frameRadius ?? 10;
  } catch {
    return 10;
  }
}

function _getPoiCenter() {
  try {
    const poiId = stateStore.getState().session?.player?.currentPoiId ?? _target?.poiId;
    if (!poiId) return null;
    const poi = poiGraph.getPoi(poiId);
    return poi?.centerCoord ?? null;
  } catch {
    return null;
  }
}

/**
 * Return the absolute tile coordinate for the current _target offset.
 * Used by Power Rip when aborting from ARMED state (lure not yet in water,
 * but the player rips toward the intended target position — D-081).
 * Returns null if target or POI center is unavailable.
 *
 * @returns {{ x: number, y: number } | null}
 */
function _getTargetAbsCoord() {
  if (!_target) return null;
  const poiCenter = _getPoiCenter();
  if (!poiCenter) return null;
  return {
    x: Math.round(poiCenter.x + (_target.offset.dx ?? 0)),
    y: Math.round(poiCenter.y + (_target.offset.dy ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// D-071 rod auto-select and D-072 lure-options helpers
// ---------------------------------------------------------------------------

/**
 * Auto-select the lightest-power rod in activeTackle that satisfies the
 * target's `rodClassRequired` (D-071).  Dispatches CAST_ROD_SELECTED so
 * stateStore records the choice in state.tournament.cast.activeRodId.
 *
 * AUTO-SELECT ONLY — never moves items into or out of activeTackle (H-017a).
 * No-op if rodClassRequired is absent, not in the 7-step ladder, or no
 * matching rod is found.
 *
 * @param {string|undefined} rodClassRequired  UL|L|ML|M|MH|H|XH
 * @param {number}           atMs
 */
function _autoSelectRod(rodClassRequired, atMs) {
  if (!rodClassRequired) return;

  const ROD_POWER_ORDER = ['UL', 'L', 'ML', 'M', 'MH', 'H', 'XH'];
  const minPowerIdx = ROD_POWER_ORDER.indexOf(rodClassRequired);
  if (minPowerIdx < 0) return;

  const state        = stateStore.getState();
  const activeTackle = state.tournament?.activeTackle ?? state.hub?.activeTackle;
  const rods         = activeTackle?.rods ?? [];

  let selectedRodId    = null;
  let selectedPowerIdx = Infinity;

  for (const entry of rods) {
    try {
      const def      = equipment.getRod(entry.id);
      const powerIdx = ROD_POWER_ORDER.indexOf(def.power);
      if (powerIdx >= minPowerIdx && powerIdx < selectedPowerIdx) {
        selectedRodId    = entry.id;
        selectedPowerIdx = powerIdx;
      }
    } catch { /* skip unresolvable rods */ }
  }

  if (selectedRodId) {
    stateStore.dispatch({ type: 'CAST_ROD_SELECTED', payload: { rodId: selectedRodId } });
  }
}

/**
 * Build the scored lure options array for the LURE_SELECT phase (D-072).
 *
 * Reads activeTackle.lures from stateStore, resolves each lure's category /
 * tier / weightOz via equipment.getLure, and computes sweetWeightOk against
 * the first rod in activeTackle.rods.
 *
 * matchScore is a placeholder (0.5) until Phase 6 wires the full
 * M_lure↔species × M_lure↔poi scoring from D-059 / D-072.
 *
 * @returns {{ options: Array, recommendedLureId: string|null }}
 */
function _buildLureOptions() {
  const state        = stateStore.getState();
  const activeTackle = state.tournament?.activeTackle ?? state.hub?.activeTackle;
  const lures        = activeTackle?.lures ?? [];
  const rods         = activeTackle?.rods  ?? [];

  let rodDef = null;
  try {
    const rodEntry = rods[0];
    if (rodEntry) rodDef = equipment.getRod(rodEntry.id);
  } catch { /* sweetWeightOk defaults false */ }

  const options = lures.map(entry => {
    let category      = 'UNKNOWN';
    let tier          = 1;
    let sweetWeightOk = false;
    try {
      const lureDef = equipment.getLure(entry.id);
      category      = lureDef.category;
      tier          = lureDef.tier;
      if (rodDef) {
        const w     = lureDef.weightOz;
        sweetWeightOk = w >= rodDef.lureWeightRangeOz.min && w <= rodDef.lureWeightRangeOz.max;
      }
    } catch { /* unknown lure — defaults above stand */ }

    return {
      lureId:       entry.id,
      category,
      tier,
      matchScore:   0.5, // placeholder — full scoring wired in Phase 6 (fishBehavior)
      sweetWeightOk,
    };
  });

  // Dev safety net: ensure LURE_SELECT can always be exercised even when
  // activeTackle.lures is empty (e.g. developer bypasses Hub during testing).
  // A real tackle-box validation gate belongs in Hub/equipment UI, not here.
  if (options.length === 0) {
    options.push({
      lureId:       'dev_mock_lure',
      category:     'Dev Mock Lure',
      tier:         1,
      matchScore:   1.0,
      sweetWeightOk: true,
    });
  }

  // Prefer a sweet-weight lure as the default; fall back to first entry.
  const sweet             = options.find(o => o.sweetWeightOk);
  const recommendedLureId = sweet?.lureId ?? options[0]?.lureId ?? null;

  return { options, recommendedLureId };
}

/**
 * Enter the LURE_SELECT sub-state (D-072).
 *
 * Called from _onTargetLocked (fresh target) and from _onSpacebar IDLE case
 * (camping re-arm per D-073).  Builds lure options, positions the cursor on
 * the recommended lure, dispatches CAST_PHASE_CHANGED, and emits LURE_OPTIONS.
 *
 * @param {number} atMs
 */
function _enterLureSelect(atMs) {
  const { options, recommendedLureId } = _buildLureOptions();
  _lureOptions     = options;
  _selectedLureIdx = Math.max(0, options.findIndex(o => o.lureId === recommendedLureId));

  _phase = 'LURE_SELECT';

  // LURE_OPTIONS MUST be emitted before CAST_PHASE_CHANGED so the UI
  // Announcer has the lure list in hand before it tries to read
  // _lureOptions[selectedLureIdx] in response to the phase event.
  bus.emit('LURE_OPTIONS', {
    lures:             options,
    recommendedLureId,
    atMs,
  });

  _dispatchPhase({
    phase:           'LURE_SELECT',
    target:          _target,
    selectedLureIdx: _selectedLureIdx,
    lureCount:       options.length,
    atMs,
  });
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

/**
 * TARGET_LOCKED handler — IDLE → LURE_SELECT (D-072).
 *
 * D-011: anchors the cast target in POI-frame coordinates at this moment.
 * D-012: samples and holds the wind vector for the cast's lifetime.
 * D-043: sets state.tournament.scanLocked so fishFinder blocks new scans.
 * D-071: auto-selects the lightest qualifying rod from activeTackle.
 * D-073: resets recastCount (fresh TARGET_LOCKED replaces any retained target).
 *
 * @param {{ poiId:string, offset:{dx:number,dy:number}, candidateId:string,
 *            finderTier:string, lockedAtMs?:number,
 *            rodClassRequired?:string }} evt
 */
function _onTargetLocked(evt) {
  if (_phase !== 'IDLE') {
    console.warn('[castPipeline] TARGET_LOCKED received mid-cast; ignoring.');
    return;
  }

  const atMs = evt.lockedAtMs ?? clock.nowMs();

  _target = {
    poiId:       evt.poiId,
    offset:      { dx: evt.offset?.dx ?? 0, dy: evt.offset?.dy ?? 0 },
    candidateId: evt.candidateId,
    finderTier:  evt.finderTier,
  };

  const windSample = wind.sample(atMs);
  _windAtCast = {
    dx:          windSample.dx,
    dy:          windSample.dy,
    intensityMs: windSample.intensityMs,
  };

  // D-073: fresh TARGET_LOCKED replaces any retained target — reset count.
  _recastCount = 0;

  // D-071: auto-select lightest qualifying rod (AUTO-SELECT ONLY — no
  // set-membership mutation on activeTackle per H-017a).
  _autoSelectRod(evt.rodClassRequired, atMs);

  stateStore.dispatch({ type: 'SCAN_LOCKED' });

  _enterLureSelect(atMs);
}

/**
 * ARROW_UP tap handler — Taps 1 and 3 in the D-014 v1.14 sequence.
 *
 * @param {{ atMs?: number }} evt
 */
function _onArrowUp(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  switch (_phase) {

    // ── LURE_SELECT: cursor up (D-072) ──────────────────────────────────────
    case 'LURE_SELECT': {
      if (_lureOptions.length > 0) {
        // Only move the cursor when there are multiple options; but always
        // dispatch so the UI Announcer reads the focused lure (e.g. the
        // sole dev_mock_lure entry when the tackle box is empty).
        if (_lureOptions.length > 1) {
          _selectedLureIdx = (_selectedLureIdx - 1 + _lureOptions.length) % _lureOptions.length;
        }
        _dispatchPhase({
          phase:           'LURE_SELECT',
          target:          _target,
          selectedLureIdx: _selectedLureIdx,
          lureCount:       _lureOptions.length,
          atMs,
        });
      }
      break;
    }

    // ── Tap 1: Start PHASE_1 metronome ─────────────────────────────────────
    case 'ARMED': {
      _cancelWhiff();
      _tap1AtMs = atMs;
      _phase    = 'PHASE_1_METRONOME';
      _dispatchPhase({
        phase:           'PHASE_1_METRONOME',
        phase1StartAtMs: _tap1AtMs,
        durationMs:      CAST_PHASE_MIN_MS,
        atMs,
      });
      _startMetronome('PHASE_1_METRONOME');
      break;
    }

    // ── Tap 3: Lock accuracy, start PHASE_3 metronome ──────────────────────
    case 'PHASE_2_ACCURACY': {
      _cancelWhiff();
      // Kill the sweep immediately — don't let it ring into PHASE_3.
      bus.emit('AUDIO_STOP_SWEEP', { atMs });
      _tap3AtMs      = atMs;
      _scatterRadius = _computeScatterRadius();
      _phase         = 'PHASE_3_METRONOME';
      _dispatchPhase({
        phase:           'PHASE_3_METRONOME',
        phase3StartAtMs: _tap3AtMs,
        scatterRadius:   _scatterRadius,
        durationMs:      CAST_PHASE_MIN_MS,
        atMs,
      });
      _startMetronome('PHASE_3_METRONOME');
      break;
    }

    default:
      // No-op in other phases.  Spacebar misses are silent (D-015 rev);
      // ARROW_UP mis-presses are likewise silent — the only failure mode
      // is a whiff timeout (handled by _fireBirdNest).
      break;
  }
}

/**
 * ARROW_DOWN tap handler — cursor down in LURE_SELECT (D-072) or
 * Tap 5 (Splashdown) in PHASE_4_IMPACT.
 *
 * @param {{ atMs?: number }} evt
 */
function _onArrowDown(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  // ── LURE_SELECT: cursor down (D-072) ─────────────────────────────────────
  if (_phase === 'LURE_SELECT') {
    if (_lureOptions.length > 0) {
      // Only move the cursor when there are multiple options; but always
      // dispatch so the UI Announcer reads the focused lure (e.g. the
      // sole dev_mock_lure entry when the tackle box is empty).
      if (_lureOptions.length > 1) {
        _selectedLureIdx = (_selectedLureIdx + 1) % _lureOptions.length;
      }
      _dispatchPhase({
        phase:           'LURE_SELECT',
        target:          _target,
        selectedLureIdx: _selectedLureIdx,
        lureCount:       _lureOptions.length,
        atMs,
      });
    }
    return;
  }

  if (_phase !== 'PHASE_4_IMPACT') return;

  _cancelWhiff();

  // Kill the sweep immediately — don't let it ring into the splash sound.
  bus.emit('AUDIO_STOP_SWEEP', { atMs });

  // Final mitigation computed here (after both metronomes have run and
  // Spacebar taps, if any, were recorded during PHASE_1 and PHASE_3).
  _mitigationFactor = _computeMitigationFactor();

  const frameRadius = _getFrameRadius();
  const landing     = _computeLanding(frameRadius);
  const splashKind  = _determineSplashKind();

  // Apply spook on the landing tile (H-003: sole write through castSpookModel).
  // tileCoord is declared at function scope so Soft Retrieve / Power Rip can
  // reference it as _lastLandingCoord in post-CAST_LANDED IDLE (D-081).
  const poiCenter = _getPoiCenter();
  const tileCoord = poiCenter
    ? { x: poiCenter.x + Math.round(landing.dx), y: poiCenter.y + Math.round(landing.dy) }
    : null;
  if (tileCoord) {
    castSpookModel.applySplash(tileCoord, splashKind, atMs);
  }

  bus.emit('CAST_LANDED', {
    poiId:            _target.poiId,
    candidateId:      _target.candidateId,
    finderTier:       _target.finderTier,
    landing,
    target:           { ..._target.offset },
    splashKind,
    scatterRadius:    _scatterRadius,
    mitigationFactor: _mitigationFactor,
    atMs,
  });

  // D-080: Narrative cue — lure is in the water, awaiting a bite.
  bus.emit('STATE_ANNOUNCE', { token: 'TIME_TO_FISH', atMs });

  // D-073 Camping Loop: emit TARGET_RETAINED before resetting if the store
  // still holds a lastTarget.  _target is still valid at this point.
  // recastCount is for TTS coalescing only — NOT a math input (D-073).
  const lastTarget = stateStore.getState().tournament?.lastTarget;
  if (lastTarget) {
    _recastCount += 1;
    bus.emit('TARGET_RETAINED', {
      poiId:       _target.poiId,
      offset:      { ..._target.offset },
      candidateId: _target.candidateId,
      lockedAtMs:  lastTarget.lockedAtMs,
      finderTier:  _target.finderTier,
      recastCount: _recastCount,
      atMs,
    });
  }

  // NOTE: _resetToIdle is called here but _lastLandingCoord has been
  // intentionally re-assigned to tileCoord ABOVE (before the CAST_LANDED emit)
  // and will NOT be null after _resetToIdle in this path — we need it
  // to survive so Soft Retrieve / Power Rip can reference it in IDLE.
  // Re-assign after reset to restore the landing coord.
  _resetToIdle();
  _lastLandingCoord = tileCoord;  // Restore: _resetToIdle clears it above (D-081).
}

/**
 * SPACEBAR tap handler — Taps 2 and 4 (optional, wind-mitigation timing).
 *
 * Only the FIRST Spacebar tap in each metronome phase is recorded; subsequent
 * taps in the same phase are silently ignored.  Missing the Spacebar entirely
 * is silent (D-015 rev): mitigation will resolve to 0 in _computeMitigationFactor.
 *
 * @param {{ atMs?: number }} evt
 */
function _onSpacebar(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  switch (_phase) {

    // ── IDLE: camping re-arm on retained target (D-073) ────────────────────
    case 'IDLE': {
      const lastTarget = stateStore.getState().tournament?.lastTarget;
      if (!lastTarget) break;

      // Restore _target from stateStore so _enterLureSelect has data to work with.
      _target = {
        poiId:       lastTarget.poiId,
        offset:      { dx: lastTarget.offset?.dx ?? 0, dy: lastTarget.offset?.dy ?? 0 },
        candidateId: lastTarget.candidateId,
        finderTier:  lastTarget.finderTier,
      };

      // Re-sample wind for the new cast (D-012 — held from this point through flight).
      const windSample = wind.sample(atMs);
      _windAtCast = { dx: windSample.dx, dy: windSample.dy, intensityMs: windSample.intensityMs };

      stateStore.dispatch({ type: 'SCAN_LOCKED' });
      _enterLureSelect(atMs);
      break;
    }

    // ── LURE_SELECT: confirm selection → ARMED (D-072) ─────────────────────
    case 'LURE_SELECT': {
      const chosen = _lureOptions[_selectedLureIdx];
      if (!chosen) break;

      const lureId = chosen.lureId;
      stateStore.dispatch({ type: 'LURE_LOCKED', payload: { lureId } });
      bus.emit('LURE_LOCKED', { lureId, atMs });

      // LURE_SELECT → ARMED.  No whiff timer yet — player may sit in ARMED
      // indefinitely before delivering Tap 1 (D-015 v1.14).
      _phase = 'ARMED';
      _dispatchPhase({ phase: 'ARMED', target: _target, atMs });

      // D-080: Narrative cue — the lure is armed and ready to cast.
      bus.emit('STATE_ANNOUNCE', { token: 'TIME_TO_CAST', atMs });
      break;
    }

    case 'PHASE_1_METRONOME':
      if (_tap2AtMs === null) {
        _tap2AtMs = atMs;
        _dispatchPhase({
          phase:           'PHASE_1_METRONOME',
          phase1StartAtMs: _tap1AtMs,
          tap2AtMs:        _tap2AtMs,
          durationMs:      CAST_PHASE_MIN_MS,
          atMs,
        });
      }
      break;

    case 'PHASE_3_METRONOME':
      if (_tap4AtMs === null) {
        _tap4AtMs = atMs;
        _dispatchPhase({
          phase:           'PHASE_3_METRONOME',
          phase3StartAtMs: _tap3AtMs,
          tap4AtMs:        _tap4AtMs,
          scatterRadius:   _scatterRadius,
          durationMs:      CAST_PHASE_MIN_MS,
          atMs,
        });
      }
      break;

    default:
      // Spacebar in any other phase is silent (D-015 rev).
      break;
  }
}

/**
 * ESC handler — cancel LURE_SELECT and return to IDLE (D-072).
 *
 * Clears _target so targetSelector regains candidate-list focus.
 * Dispatches SCAN_UNLOCKED so fishFinder is unblocked for a fresh scan.
 * No Bird's Nest penalty — ESC is a voluntary cancel.
 *
 * @param {{ atMs?: number }} _evt
 */
function _onEsc(_evt) {
  if (_phase !== 'LURE_SELECT') return;
  _resetToIdle();
}

// ---------------------------------------------------------------------------
// Retrieve / Abort handlers (D-081 v1.17)
// ---------------------------------------------------------------------------

/**
 * Soft Retrieve (INPUT_R) — voluntarily retrieve the lure at a 5-second clock cost.
 *
 * Available in ARMED state (pre-cast, player changes their mind before the cast
 * sequence begins) or in post-CAST_LANDED IDLE state (lure in water, waiting for
 * a bite).
 *
 * Effects (D-081):
 *   • No spook applied — lure exits cleanly.
 *   • Emits STATE_ANNOUNCE { token: 'LURE_RETRIEVED' } (D-080 narrative layer).
 *   • Emits CAST_ABORTED { mode: 'SOFT', clockPenaltyMs: 5000, atMs }.
 *     fishBehavior.js listens to CAST_ABORTED and cancels pending bite timers
 *     (H-014 boundary — no direct import between pipeline modules).
 *   • FSM returns to IDLE (lastTarget preserved in stateStore per D-073).
 *   • clock.tick(5000) advances the tournament clock AFTER CAST_ABORTED is emitted
 *     so the bus-synchronous bite-cancellation fires before any timer callbacks.
 *
 * @param {{ atMs?: number }} evt
 */
function _onInputR(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  // Gate: only active in ARMED (pre-cast) or post-CAST_LANDED IDLE.
  if (_phase === 'ARMED') {
    // Pre-cast abort: lure hasn't touched water.
  } else if (_phase === 'IDLE' && _lastLandingCoord !== null) {
    // Post-cast abort: lure in water, waiting for bite.
  } else {
    return; // Not in an applicable state.
  }

  // Narrative cue first (D-080) so the TTS layer can pre-empt as needed (H-022).
  bus.emit('STATE_ANNOUNCE', { token: 'LURE_RETRIEVED', atMs });

  // Emit CAST_ABORTED BEFORE clock.tick so fishBehavior cancels bite timers
  // synchronously before any scheduled callbacks could fire (H-014, D-081).
  bus.emit('CAST_ABORTED', { mode: 'SOFT', clockPenaltyMs: SOFT_RETRIEVE_CLOCK_PENALTY_MS, atMs });

  // Reset FSM. This clears _lastLandingCoord and _target but preserves
  // state.tournament.lastTarget in stateStore (D-073 camping intact).
  _resetToIdle();

  // Apply the clock penalty. Any remaining scheduled callbacks that survived
  // cancellation (edge case) will fire in strict chronological order (H-004).
  clock.tick(SOFT_RETRIEVE_CLOCK_PENALTY_MS);
}

/**
 * Power Rip (INPUT_Q) — aggressively rip the lure out at a 2-second clock cost
 * with a +1 NORMAL spook penalty at the lure's last known position (D-081).
 *
 * Available in ARMED state or post-CAST_LANDED IDLE state (same gate as Soft Retrieve).
 *
 * Effects (D-081):
 *   • castSpookModel.applySplash at lure position, kind = 'NORMAL' (+1 spook, D-038).
 *     - In IDLE (post-cast): uses _lastLandingCoord.
 *     - In ARMED (pre-cast): uses the intended target coord (ripping toward the target
 *       disturbs that area of water). Falls back gracefully if coord unavailable.
 *   • Emits STATE_ANNOUNCE { token: 'LINE_RIPPED' } (D-080).
 *   • Emits CAST_ABORTED { mode: 'RIP', clockPenaltyMs: 2000, atMs }.
 *   • FSM returns to IDLE (lastTarget preserved per D-073).
 *   • clock.tick(2000) after CAST_ABORTED for the same ordering reason as Soft Retrieve.
 *
 * @param {{ atMs?: number }} evt
 */
function _onInputQ(evt) {
  const atMs = evt.atMs ?? clock.nowMs();

  // Gate: same states as Soft Retrieve.
  let spookCoord = null;
  if (_phase === 'ARMED') {
    // Pre-cast: spook the intended target area (lure hasn't landed but the rip
    // creates water disturbance near where the angler was aiming).
    spookCoord = _getTargetAbsCoord();
  } else if (_phase === 'IDLE' && _lastLandingCoord !== null) {
    // Post-cast: spook at actual landing position.
    spookCoord = _lastLandingCoord;
  } else {
    return; // Not in an applicable state.
  }

  // Apply spook BEFORE the reset (coord is still valid; H-003: sole write via castSpookModel).
  if (spookCoord) {
    castSpookModel.applySplash(spookCoord, 'NORMAL', atMs);
  }

  bus.emit('STATE_ANNOUNCE', { token: 'LINE_RIPPED', atMs });

  // Emit CAST_ABORTED before clock.tick so fishBehavior can cancel bite timers
  // synchronously (H-014, D-081).
  bus.emit('CAST_ABORTED', { mode: 'RIP', clockPenaltyMs: POWER_RIP_CLOCK_PENALTY_MS, atMs });

  _resetToIdle();

  clock.tick(POWER_RIP_CLOCK_PENALTY_MS);
}

// ---------------------------------------------------------------------------
// Mount manifest (H-005)
// ---------------------------------------------------------------------------

modeRouter.registerMountManifest({
  id:    'castPipeline',
  modes: ['TOURNAMENT_ACTIVE'],

  /**
   * Acquire bus subscriptions and reset state when entering TOURNAMENT_ACTIVE.
   *
   * _castRng is intentionally NOT reset — it persists across multiple casts
   * within a tournament for RNG continuity (§5d).
   */
  onMount(_nextMode, _prevMode) {
    _phase                = 'IDLE';
    _target               = null;
    _windAtCast           = null;
    _tap1AtMs             = null;
    _tap2AtMs             = null;
    _tap3AtMs             = null;
    _tap4AtMs             = null;
    _phase2StartAtMs      = null;
    _phase4StartAtMs      = null;
    _scatterRadius        = 0;
    _mitigationFactor     = 0;
    _lureOptions          = [];
    _selectedLureIdx      = 0;
    _recastCount          = 0;
    _lastLandingCoord     = null;
    _whiffHandle          = null;
    _metronomeEndHandle   = null;
    _metronomeTickHandles = [];

    _unsubs = [
      // TARGET_LOCKED from targetSelector — enters LURE_SELECT (D-072).
      bus.on('TARGET_LOCKED',     _onTargetLocked),

      // ARROW_UP: cursor up in LURE_SELECT; Tap 1 (ARMED → PHASE_1);
      //           Tap 3 (PHASE_2 → PHASE_3).
      bus.on('INPUT_ARROW_UP',    _onArrowUp),

      // ARROW_DOWN: cursor down in LURE_SELECT; Tap 5 (PHASE_4 → CAST_LANDED).
      bus.on('INPUT_ARROW_DOWN',  _onArrowDown),

      // SPACEBAR: camping re-arm in IDLE (D-073); confirm in LURE_SELECT (D-072);
      //           optional Taps 2 and 4 (wind-mitigation timing).
      bus.on('INPUT_SPACEBAR',    _onSpacebar),

      // ESC: cancel LURE_SELECT, return to IDLE (D-072).
      bus.on('INPUT_ESC',         _onEsc),

      // INPUT_R: Soft Retrieve — 5 s clock penalty, 0 spook (D-081 v1.17).
      bus.on('INPUT_R',           _onInputR),

      // INPUT_Q: Power Rip — 2 s clock penalty, +1 NORMAL spook (D-081 v1.17).
      bus.on('INPUT_Q',           _onInputQ),
    ];
  },

  /**
   * Release all bus subscriptions and clock handles when leaving TOURNAMENT_ACTIVE.
   * H-005: every handle acquired in onMount is cancelled here.
   */
  onUnmount(_prevMode, _nextMode) {
    _cancelWhiff();
    _cancelMetronomeTimers();

    for (const unsub of _unsubs) unsub();
    _unsubs = [];

    _resetToIdle();
  },
});
