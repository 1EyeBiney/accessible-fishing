/**
 * AFish Fight Loop — src/fish/fightLoop.js
 *
 * Public API Contract (§9 — FIGHT):
 *   Module self-registers via modeRouter.registerMountManifest.
 *   No direct exports; all communication is via the event bus.
 *
 * Subsystems owned:
 *   • Nibble Trap (D-033)  — NIBBLE_WINDOW blocks input; any INPUT during window
 *                            cancels the bite sequence and emits BITE_CANCELLED.
 *   • Hookset Trigger (D-033, D-050) — BITE_THUD opens a timed HOOKSET_WINDOW;
 *                            only INPUT_ARROW_UP_DOWN edge within the window
 *                            advances to fight.  Miss → lure rejection logged.
 *   • Tension Model (D-031, D-034) — tension float [0,1]; reeling raises it,
 *                            drag lowers it, fish pull pulls toward equilibrium.
 *   • Fight Tick (D-034) — clock.every(60, ...) drives the physics step.
 *   • 4-channel event emission (D-035) — FIGHT_TENSION, FIGHT_PHASE_CHANGED,
 *                            FIGHT_THRESHOLD_CROSSED, FIGHT_RESOLVED.
 *   • Terminal conditions (D-036) — LINE_SNAPPED, HOOK_SHAKEN, FISH_LANDED.
 *
 * Decisions implemented:
 *   D-031 — Idle Decay mutex: if ARROW_DOWN and ARROW_UP both held simultaneously,
 *            player tension contribution cancels out; fish pull toward equilibrium
 *            still applies (RUNNING phase drifts tension UP, TIRED phase DOWN).
 *   D-033 — Hookset window shrinks with species intelligence (min 300ms, D-050).
 *   D-034 — Fight tick = 60ms via clock.every. Reads inputAdapter.isHeld().
 *   D-035 — FIGHT_TENSION coalesced: emit only when |delta| > 0.02 OR gap ≥ 250ms.
 *   D-036 — tension ≥ 1.0 → LINE_SNAPPED (immediate).
 *            tension ≤ 0 for > 1500ms continuously → HOOK_SHAKEN.
 *            landingDistance ≤ 0.5 → FISH_LANDED.
 *            rod durability ≤ 0 → ROD_BROKEN + ROD_SNAPPED.
 *   D-039 — Pressure events: HOOKSET +1 on every hookset attempt, CATCH +1 on land.
 *   D-049 — Lure rejection recorded on hookset miss and on hook-shake.
 *   D-080 — Deceptive Thud (v1.78): emits STRIKE_LIGHT / STRIKE_MODERATE / STRIKE_HEAVY on
 *            successful hookset, selected by InitialPull = weightKg × styleMod × RNG(0.8–1.2).
 *            Bands (LOCKED): STRIKE_LIGHT < 1.5; STRIKE_MODERATE 1.5–3.5; STRIKE_HEAVY ≥ 3.5.
 *   D-082 — Ergonomic Reversal + Trophy Yank (LOCKED, v1.78):
 *            ARROW_DOWN (held) = Reel In (tension UP).
 *            ARROW_UP   (held) = Give Drag (tension DOWN).
 *            SPACEBAR   (tap)  = Trophy Yank: snap roll P_snap, then YANK_WEAR + trophyMultiplier
 *                                +0.15 + 1 s clock penalty (D-082).
 *            ARROW_UP   (tap)  = Hookset trigger during HOOKSET_WINDOW.
 *   D-083 — Crooked Stick exemption: SPACEBAR is a complete no-op when activeRodId === 'crooked_stick'.
 *
 * H-005 compliance:
 *   All clock handles and bus subscriptions are cancelled in onUnmount.
 *   If a fight is in progress when unmounting, it resolves as HOOK_SHAKEN.
 *
 * H-013 compliance:
 *   Pressure (written via fishBehavior.applyPressureEvent) and Spook are
 *   separate orthogonal systems. This module never reads or writes spook.
 *
 * Events emitted:
 *   HOOKSET_ATTEMPTED    { hit: false, fishInstance, atMs }
 *   HOOKSET_MISSED       { fishInstance, lureId, coordKey, atMs }
 *   FISH_HOOKED          { fishInstance, startTension, atMs }
 *   STATE_ANNOUNCE       { token: 'STRIKE_LIGHT'|'STRIKE_MODERATE'|'STRIKE_HEAVY', atMs } — D-080
 *   FIGHT_TENSION        { tension, phase, delta, atMs } — coalesced (D-035)
 *   FIGHT_PHASE_CHANGED  { phase, prevPhase, tension, atMs } — edge only (D-035)
 *   FIGHT_THRESHOLD_CROSSED { threshold, tension, atMs } — edge only (D-035)
 *                           threshold ∈ SLACK_DANGER | SNAP_DANGER | LINE_SNAPPED | SLACK_LOST
 *   ROD_STRAINED         { rodId, durability, atMs } — once per fight, < 25% durability (D-036)
 *   ROD_BROKEN           { rodId, atMs } — durability ≤ 0 (D-036)
 *   FIGHT_RESOLVED       { outcome, fishInstance, atMs }
 *                           outcome ∈ FISH_LANDED | LINE_SNAPPED | HOOK_SHAKEN | ROD_SNAPPED
 *   BITE_CANCELLED       { reason, speciesId, poiId, lureId, atMs }
 *
 * Events consumed:
 *   BITE_NIBBLE      — opens nibble-trap window
 *   BITE_THUD        — opens hookset window
 *   INPUT_ARROW_UP   — hookset trigger (tap during HOOKSET_WINDOW, D-082)
 *   INPUT_SPACEBAR   — Trophy Yank (tap during active fight, D-082)
 */

import * as bus           from '../core/eventBus.js';
import * as clock         from '../core/clock.js';
import * as inputAdapter  from '../core/inputAdapter.js';
import * as stateStore    from '../core/stateStore.js';
import * as modeRouter    from '../core/modeRouter.js';
import * as equipment     from '../equipment/equipment.js';
import * as rng           from '../core/rng.js';
import {
  applyPressureEvent,
  recordLureRejection,
  advanceFight,
} from './fishBehavior.js';

// ===========================================================================
// Constants
// ===========================================================================

/** Fight-tick interval in ms (D-034, LOCKED). */
const FIGHT_TICK_MS = 60;

/**
 * Continuous slack duration required before hook is considered shaken (D-036).
 * Fish must be at zero tension for this long before HOOK_SHAKEN fires.
 */
const SLACK_GRACE_MS = 1_500;

// ── Tension physics constants ────────────────────────────────────────────────
// The tension model runs on a [0,1] float each tick.
// "Reeling" = SPACEBAR held; "Drag" = ARROW_DOWN held.

/** Fraction added to tension per tick when actively reeling. */
const REEL_TENSION_ADD = 0.018;

/** Fraction removed from tension per tick when giving drag. */
const DRAG_TENSION_SUB = 0.040;

/** Fish pull keeps tension near this equilibrium when fish is RUNNING. */
const IDLE_RUNNING_EQUILIBRIUM = 0.62;

/** Fish pull keeps tension near this equilibrium when fish is TIRED. */
const IDLE_TIRED_EQUILIBRIUM = 0.22;

/**
 * Rate at which tension approaches the fish-pull equilibrium per tick.
 * Lower = more sluggish; higher = snappier.
 */
const IDLE_APPROACH_RATE = 0.10;

/** Tension multiplier on the fish pull force when a species RUNNER surges. */
const FISH_PULL_REEL_SCALE  = 0.65;
const FISH_PULL_DRAG_SCALE  = 0.20;

// ── Landing distance ─────────────────────────────────────────────────────────
/** Landing distance (metres) at which the fish is considered landed (D-036). */
const LANDED_THRESHOLD = 0.5;

/** Starting landing distance for a typical fish. Weight-scaled at fight start. */
const BASE_LANDING_DISTANCE_M = 20.0;

/** Distance reduced per tick when successfully reeling the fish in. */
const REEL_SPEED_M_PER_TICK = 0.20;

/** Distance gained per tick when the fish is running and angler gives drag. */
const FISH_RUN_SPEED_M_PER_TICK = 0.12;

// ── Tension emission thresholds (D-035) ──────────────────────────────────────

/** Minimum tension delta to trigger a FIGHT_TENSION event (D-035). */
const TENSION_EMIT_DELTA = 0.02;

/** Maximum gap in ms between FIGHT_TENSION events regardless of delta (D-035). */
const TENSION_EMIT_MAX_GAP_MS = 250;

// ── Threshold sentinels (D-035) ──────────────────────────────────────────────
const SNAP_DANGER_THRESHOLD  = 0.85;  // above this → warn about snap risk
const SLACK_DANGER_THRESHOLD = 0.10;  // below this → warn about slack (hook shake risk)

// ── Input identifiers (D-082, LOCKED) ────────────────────────────────────────────
const INPUT_REEL_IN    = 'ARROW_DOWN'; // held = Reel In  (tension UP)
const INPUT_GIVE_DRAG  = 'ARROW_UP';   // held = Give Drag (tension DOWN)
const INPUT_HOOKSET    = 'ARROW_UP';   // tap  = Hookset during HOOKSET_WINDOW
const INPUT_PUMP       = 'SPACEBAR';   // tap  = Trophy Yank (D-082)

// ===========================================================================
// Module state
// ===========================================================================

/** Bus unsubscribe handles, cleared in onUnmount. @type {Function[]} */
const _unsubs = [];

/** Clock handle for the fight tick, or null when no fight is active. */
let _tickHandle = null;

/** Clock handle for the hookset window timeout, or null. */
let _hooksetTimeoutHandle = null;

/** Clock handle for the nibble-window input-lock timeout, or null. */
let _nibbleWindowHandle = null;

/** Unsub for the hookset input listener, or null. */
let _hooksetInputUnsub = null;

/** Unsub for the nibble-window input listener, or null. */
let _nibbleInputUnsub = null;

/** Unsub for the Trophy Yank SPACEBAR listener (active only during a fight). */
let _pumpUnsub = null;

/** Fish instance awaiting hookset (between BITE_THUD and window expiry). */
let _pendingFishInstance = null;

/** Pending castSpec (needed for rejection recording). */
let _pendingCastSpec = null;

/**
 * Active fight state, or null when no fight is in progress.
 *
 * @type {null | {
 *   fishInstance:      object,
 *   activeRodId:       string|null,
 *   fightRng:          object,
 *   tension:           number,
 *   phase:             'RUNNING'|'TIRED',
 *   landingDistanceM:  number,
 *   slackStartMs:      number|null,
 *   lastTensionEmitMs: number,
 *   lastEmittedTension:number,
 *   prevPhase:         'RUNNING'|'TIRED',
 *   rodStrainedFired:  boolean,
 *   thresholdFlags: {
 *     slackDanger: boolean,
 *     snapDanger:  boolean,
 *   },
 * }}
 */
let _fight = null;

// ===========================================================================
// Window / handle cleanup helpers
// ===========================================================================

function _clearHooksetWindow() {
  if (_hooksetTimeoutHandle !== null) {
    clock.cancel(_hooksetTimeoutHandle);
    _hooksetTimeoutHandle = null;
  }
  if (_hooksetInputUnsub !== null) {
    _hooksetInputUnsub();
    _hooksetInputUnsub = null;
  }
  _pendingFishInstance = null;
  _pendingCastSpec     = null;
}

function _clearNibbleWindow() {
  if (_nibbleWindowHandle !== null) {
    clock.cancel(_nibbleWindowHandle);
    _nibbleWindowHandle = null;
  }
  if (_nibbleInputUnsub !== null) {
    _nibbleInputUnsub();
    _nibbleInputUnsub = null;
  }
}

function _clearFightTick() {
  if (_tickHandle !== null) {
    clock.cancel(_tickHandle);
    _tickHandle = null;
  }
}

// ===========================================================================
// Fight resolution
// ===========================================================================

/**
 * Terminate the active fight with the given outcome.
 * Emits FIGHT_RESOLVED, applies pressure (CATCH on land), records rejection
 * on loss (D-049), dispatches SCAN_UNLOCKED so the scan phase can resume.
 *
 * @param {'FISH_LANDED'|'LINE_SNAPPED'|'HOOK_SHAKEN'|'ROD_SNAPPED'} outcome
 * @param {number} atMs
 */
function _resolveFight(outcome, atMs) {
  if (!_fight) return;

  const { fishInstance } = _fight;

  _clearFightTick();
  _clearHooksetWindow();
  _clearNibbleWindow();

  // Unsubscribe the Trophy Yank listener.
  if (_pumpUnsub !== null) {
    _pumpUnsub();
    _pumpUnsub = null;
  }

  // Pressure event for catch (D-039: CATCH +1).
  if (outcome === 'FISH_LANDED') {
    applyPressureEvent(fishInstance.coord, 'CATCH', atMs);
  }

  // Lure rejection on any outcome OTHER than landing (D-049).
  if (outcome === 'LINE_SNAPPED' || outcome === 'HOOK_SHAKEN') {
    recordLureRejection(fishInstance.coord, fishInstance.lureId, atMs);
  }

  bus.emit('FIGHT_RESOLVED', { outcome, fishInstance, atMs });

  // Unlock the scan so the player can cast again.
  stateStore.dispatch({ type: 'SCAN_UNLOCKED', payload: { reason: outcome, atMs } });

  _fight = null;
}

// ===========================================================================
// Hookset miss
// ===========================================================================

/**
 * Handle a missed hookset — window expired or wrong input.
 *
 * @param {object} fishInstance
 * @param {object} castSpec
 * @param {number} atMs
 */
function _onHooksetMiss(fishInstance, castSpec, atMs) {
  recordLureRejection(fishInstance.coord, fishInstance.lureId, atMs);
  bus.emit('HOOKSET_MISSED', {
    fishInstance,
    lureId:   fishInstance.lureId,
    coordKey: `${fishInstance.coord.x},${fishInstance.coord.y}`,
    atMs,
  });
  // Unlock scan — the cast is over, fish fled.
  stateStore.dispatch({ type: 'SCAN_UNLOCKED', payload: { reason: 'HOOKSET_MISSED', atMs } });
}

// ===========================================================================
// Fight initialisation
// ===========================================================================

/**
 * Begin the active fight phase.
 * Locks scan, initialises fight state, emits FISH_HOOKED, starts fight tick.
 *
 * @param {object} fishInstance
 * @param {number} atMs
 */
function _startFight(fishInstance, atMs) {
  // Scale starting landing distance by fish weight (bigger fish starts farther).
  const startDistance = Math.min(
    BASE_LANDING_DISTANCE_M * 2.0,
    Math.max(5.0, BASE_LANDING_DISTANCE_M * (fishInstance.weightKg / 1.5))
  );

  // Capture the active rod id so durability can be checked / damaged each tick (D-082, D-083).
  const tackle      = equipment.getActiveTackle();
  const activeRodId = tackle?.rods?.[0]?.id ?? null;

  // Initialise per-fight Trophy Yank state (D-082).
  fishInstance.trophyMultiplier = 1.0;

  // Create a deterministic RNG stream for this fight (H-015, H-004).
  const fightRng = rng.rngStream('fight');

  _fight = {
    fishInstance,
    activeRodId,
    fightRng,
    tension:            0.50,  // start at mid-tension
    phase:              fishInstance.phase,  // from evaluateStrike → 'RUNNING'
    prevPhase:          fishInstance.phase,
    landingDistanceM:   startDistance,
    slackStartMs:       null,
    lastTensionEmitMs:  atMs,
    lastEmittedTension: 0.50,
    rodStrainedFired:   false,  // D-036: ROD_STRAINED fires once per fight
    thresholdFlags: {
      slackDanger: false,
      snapDanger:  false,
    },
  };

  stateStore.dispatch({ type: 'SCAN_LOCKED', payload: { reason: 'FIGHT_ACTIVE', atMs } });

  bus.emit('FISH_HOOKED', {
    fishInstance,
    startTension: _fight.tension,
    atMs,
  });

  // D-080: Deceptive Thud — compute InitialPull and emit the appropriate STRIKE_* token.
  // styleMod: BULLDOG/THRASHER = 1.2, RUNNER/JUMPER = 1.0, DIVER = 0.8 (D-082, LOCKED v1.78).
  const FIGHT_STYLE_MOD = { BULLDOG: 1.2, THRASHER: 1.2, RUNNER: 1.0, JUMPER: 1.0, DIVER: 0.8 };
  const styleMod    = FIGHT_STYLE_MOD[fishInstance.fightStyle] ?? 1.0;
  const initialPull = fishInstance.weightKg * styleMod * (0.8 + (fightRng.next() * 0.4));
  const strikeToken = initialPull < 1.5  ? 'STRIKE_LIGHT'
                    : initialPull >= 3.5 ? 'STRIKE_HEAVY'
                    :                      'STRIKE_MODERATE';
  bus.emit('STATE_ANNOUNCE', { token: strikeToken, atMs });

  // Subscribe the Trophy Yank listener (D-082: SPACEBAR tap during fight).
  _pumpUnsub = bus.on(`INPUT_${INPUT_PUMP}`, _onPump);

  // Start the fight tick.
  _tickHandle = clock.every(FIGHT_TICK_MS, _onFightTick);
}

// ===========================================================================
// Trophy Yank (D-082, v1.78)
// ===========================================================================

/**
 * Handle a Trophy Yank (SPACEBAR tap) during an active fight (D-082, v1.78).
 *
 * Execution order (all effects applied before the clock penalty):
 *   1. D-083 guard    — Crooked Stick is a complete no-op (no snap roll, no wear,
 *                        no reward, no clock penalty).
 *   2. Snap roll      — P_snap = 0.10 + (1 − currentDurabilityFraction).
 *                        On failure: emit ROD_BROKEN, resolve fight as ROD_SNAPPED.
 *   3. Cost           — equipment.damageItem(activeRodId, 'YANK_WEAR') (−0.10 durability).
 *   4. Reward         — fishInstance.trophyMultiplier += 0.15 (additive stacking).
 *   5. Penalty        — clock.tick(1000) advances tournament clock by 1 in-game second.
 *
 * @param {object} evt — INPUT_SPACEBAR payload { type, atMs, source }
 */
function _onPump(evt) {
  if (!_fight) return;

  const f    = _fight;
  const atMs = evt.atMs ?? clock.nowMs();

  // 1. D-083: Crooked Stick is exempt from Trophy Yank — complete no-op.
  if (f.activeRodId === 'crooked_stick') return;

  // 2. Snap roll — applied before wear so a fresh rod still carries the 10% base risk.
  let currentDurabilityFraction = 1.0;
  if (f.activeRodId) {
    const state   = stateStore.getState();
    const rodList = state.mode === 'TOURNAMENT_ACTIVE'
      ? (state.tournament.activeTackle?.rods ?? [])
      : (state.hub.inventory?.rods ?? []);
    const rodEntry   = rodList.find(r => r.id === f.activeRodId);
    const rodCatalog = equipment.getRod(f.activeRodId);
    if (rodEntry && rodCatalog) {
      currentDurabilityFraction = rodEntry.durability / rodCatalog.durability;
    }
  }

  const roll   = f.fightRng.next();
  const P_snap = 0.10 + (1.0 - currentDurabilityFraction);
  if (roll < P_snap) {
    bus.emit('ROD_BROKEN', { rodId: f.activeRodId, atMs });
    _resolveFight('ROD_SNAPPED', atMs);
    return;
  }

  // 3. Cost: rod wear (−0.10 maxDurability per yank).
  if (f.activeRodId) {
    equipment.damageItem(f.activeRodId, 'YANK_WEAR');
  }

  // 4. Reward: additive trophy multiplier (consumed by scoring.js on FISH_LANDED).
  f.fishInstance.trophyMultiplier += 0.15;

  // 5. Penalty: advance tournament clock by 1 in-game second.
  //    _fight may be null after this call if a terminal condition fires inside the ticks.
  clock.tick(1000);
}

// ===========================================================================
// Nibble trap (D-033)
// ===========================================================================

/**
 * Handle incoming BITE_NIBBLE.
 * Closes any existing nibble window and opens a fresh one for this nibble.
 * Any input during the nibble window cancels the bite and emits BITE_CANCELLED.
 *
 * @param {object} evt - BITE_NIBBLE payload
 */
function _onBiteNibble(evt) {
  // Close any prior window — each nibble resets the trap.
  _clearNibbleWindow();

  // Lock the input adapter during the nibble window so the system registers
  // any inadvertent tap for the cancellation check below.
  inputAdapter.lock('NIBBLE_WINDOW', FIGHT_TICK_MS * 10);

  // Subscribe to any input edge during the window.
  _nibbleInputUnsub = bus.on('INPUT_ACTION', (inputEvt) => {
    // Any input during nibble window → cancel the bite.
    _clearNibbleWindow();
    bus.emit('BITE_CANCELLED', {
      reason:    'INPUT_DURING_NIBBLE',
      speciesId: evt.speciesId ?? 'UNKNOWN',
      poiId:     evt.poiId,
      lureId:    _pendingFishInstance?.lureId ?? null,
      atMs:      inputEvt.atMs ?? clock.nowMs(),
    });
    // The bite timer (in fishBehavior) will still deliver BITE_THUD unless
    // fightLoop cancels it — but fightLoop does not own the bite handle.
    // The thud fires → _onBiteThud will call _onHooksetMiss internally.
    // This is the correct behaviour: fish spooked, rejection recorded at thud.
  });

  // Auto-clear the window after a short duration if no input occurs.
  _nibbleWindowHandle = clock.schedule(FIGHT_TICK_MS * 10, (_atMs) => {
    _nibbleWindowHandle = null;
    if (_nibbleInputUnsub) {
      _nibbleInputUnsub();
      _nibbleInputUnsub = null;
    }
  });
}

// ===========================================================================
// Hookset trigger (D-033)
// ===========================================================================

/**
 * Handle BITE_THUD — fish has committed, open the hookset window.
 * Applies HOOKSET pressure (+1). Watches for INPUT_ARROW_UP tap (D-082: hookset trigger).
 *
 * @param {object} evt - BITE_THUD payload
 */
function _onBiteThud(evt) {
  const { fishInstance, hooksetWindowMs, castSpec, atMs } = evt;

  // Clear any stale nibble window — the thud supersedes it.
  _clearNibbleWindow();

  // Apply HOOKSET pressure regardless of whether the player hits or misses (D-039).
  applyPressureEvent(fishInstance.coord, 'HOOKSET', atMs);

  _pendingFishInstance = fishInstance;
  _pendingCastSpec     = castSpec;

  bus.emit('HOOKSET_ATTEMPTED', { hit: false, fishInstance, atMs });

  // Open the hookset input window.
  // D-082: ARROW_UP tap = hookset trigger. Listens on the specific INPUT_ARROW_UP
  // channel emitted by inputAdapter._emitTap('ARROW_UP', ...).
  _hooksetInputUnsub = bus.on(`INPUT_${INPUT_HOOKSET}`, (inputEvt) => {
    // Any ARROW_UP tap within the window → start fight.
    _clearHooksetWindow();
    _startFight(fishInstance, inputEvt.atMs ?? clock.nowMs());
  });

  // Window expiry → miss.
  _hooksetTimeoutHandle = clock.schedule(hooksetWindowMs, (expiredAtMs) => {
    const fi = _pendingFishInstance;
    const cs = _pendingCastSpec;
    _clearHooksetWindow();
    if (fi) _onHooksetMiss(fi, cs, expiredAtMs);
  });
}

// ===========================================================================
// Fight tick (D-034)
// ===========================================================================

/**
 * Core fight-tick function. Called by clock.every(60, ...) during active fight.
 *
 * Reads input adapter state → computes tension and landing distance updates →
 * advances fish FSM → checks terminal conditions → emits coalesced events (D-035).
 *
 * @param {number} atMs - current clock time
 */
function _onFightTick(atMs) {
  if (!_fight) return;

  const f = _fight;
  const { fishInstance } = f;

  // ── 1. Read input (D-082) ─────────────────────────────────────────────────
  const reeling    = inputAdapter.isHeld(INPUT_REEL_IN);    // ARROW_DOWN held
  const givingDrag = inputAdapter.isHeld(INPUT_GIVE_DRAG);  // ARROW_UP held
  // Idle Decay mutex (D-082, D-031): both held simultaneously → player tension
  // contributions cancel; fish-pull-toward-equilibrium still applies so
  // RUNNING drifts tension UP and TIRED drifts tension DOWN naturally.
  const mutex      = reeling && givingDrag;

  // ── 2. Advance fish FSM ────────────────────────────────────────────────────
  const { stamina, phase, pullForce } = advanceFight(
    {
      speciesId: fishInstance.speciesId,
      stamina:   fishInstance.stamina,
      phase:     f.phase,
    },
    { reeling, givingDrag, mutex },
    FIGHT_TICK_MS
  );

  // Persist stamina / phase back onto the fishInstance for fidelity.
  fishInstance.stamina = stamina;

  // ── 3. Compute tension delta ───────────────────────────────────────────────
  let tensionDelta = 0;

  if (!mutex) {
    if (reeling)    tensionDelta += REEL_TENSION_ADD;
    if (givingDrag) tensionDelta -= DRAG_TENSION_SUB;
  }

  // Fish pulls toward equilibrium (spring-like approach).
  const equilibrium   = phase === 'RUNNING' ? IDLE_RUNNING_EQUILIBRIUM : IDLE_TIRED_EQUILIBRIUM;
  const pullScale     = reeling  ? FISH_PULL_REEL_SCALE
                      : givingDrag ? FISH_PULL_DRAG_SCALE
                      : 1.0;
  const fishPullDelta = (equilibrium - f.tension) * IDLE_APPROACH_RATE * pullForce * pullScale;
  tensionDelta       += fishPullDelta;

  const newTension = Math.max(0, Math.min(1, f.tension + tensionDelta));
  const totalDelta = newTension - f.tension;
  f.tension        = newTension;

  // ── 4. Advance landing distance ────────────────────────────────────────────
  if (reeling && !mutex) {
    f.landingDistanceM = Math.max(0, f.landingDistanceM - REEL_SPEED_M_PER_TICK);
  } else if (!reeling && phase === 'RUNNING') {
    f.landingDistanceM += FISH_RUN_SPEED_M_PER_TICK * pullForce;
  }

  // ── 5. Terminal conditions (D-036) ─────────────────────────────────────────
  // 5a) Rod durability — checked every tick (wear applied by _onPump, D-082/D-036).
  if (f.activeRodId) {
    const rodTackle = equipment.getActiveTackle();
    const rodEntry  = rodTackle?.rods?.find(r => r.id === f.activeRodId);
    if (rodEntry) {
      const rodDef = equipment.getRod(f.activeRodId);
      const maxDur = rodDef.durability; // catalog value = max (always 1.0 for standard rods)

      if (!f.rodStrainedFired && rodEntry.durability < 0.25 * maxDur) {
        f.rodStrainedFired = true;
        bus.emit('ROD_STRAINED', { rodId: f.activeRodId, durability: rodEntry.durability, atMs });
      }

      if (rodEntry.durability <= 0) {
        bus.emit('ROD_BROKEN', { rodId: f.activeRodId, atMs });
        _resolveFight('ROD_SNAPPED', atMs);
        return;
      }
    }
  }

  // 5b) Line snap — tension at ceiling
  if (newTension >= 1.0) {
    _resolveFight('LINE_SNAPPED', atMs);
    return;
  }

  // 5c) Hook shake — tension at floor continuously for SLACK_GRACE_MS
  if (newTension <= 0) {
    if (f.slackStartMs === null) {
      f.slackStartMs = atMs;
    } else if (atMs - f.slackStartMs >= SLACK_GRACE_MS) {
      _resolveFight('HOOK_SHAKEN', atMs);
      return;
    }
  } else {
    f.slackStartMs = null;
  }

  // 5d) Fish landed
  if (f.landingDistanceM <= LANDED_THRESHOLD) {
    _resolveFight('FISH_LANDED', atMs);
    return;
  }

  // ── 6. Phase-change event (D-035, edge) ────────────────────────────────────
  if (phase !== f.prevPhase) {
    bus.emit('FIGHT_PHASE_CHANGED', {
      phase,
      prevPhase: f.prevPhase,
      tension:   newTension,
      atMs,
    });
    f.prevPhase = phase;
    f.phase     = phase;
  } else {
    f.phase = phase;
  }

  // ── 7. Threshold events (D-035, edge-triggered) ───────────────────────────
  const inSlackDanger = newTension < SLACK_DANGER_THRESHOLD;
  const inSnapDanger  = newTension > SNAP_DANGER_THRESHOLD;

  if (inSlackDanger && !f.thresholdFlags.slackDanger) {
    f.thresholdFlags.slackDanger = true;
    bus.emit('FIGHT_THRESHOLD_CROSSED', {
      threshold: 'SLACK_DANGER',
      tension:   newTension,
      atMs,
    });
  } else if (!inSlackDanger && f.thresholdFlags.slackDanger) {
    f.thresholdFlags.slackDanger = false;
    bus.emit('FIGHT_THRESHOLD_CROSSED', {
      threshold: 'SLACK_LOST',
      tension:   newTension,
      atMs,
    });
  }

  if (inSnapDanger && !f.thresholdFlags.snapDanger) {
    f.thresholdFlags.snapDanger = true;
    bus.emit('FIGHT_THRESHOLD_CROSSED', {
      threshold: 'SNAP_DANGER',
      tension:   newTension,
      atMs,
    });
  } else if (!inSnapDanger && f.thresholdFlags.snapDanger) {
    f.thresholdFlags.snapDanger = false;
  }

  // ── 8. Coalesced FIGHT_TENSION emission (D-035) ───────────────────────────
  const absDelta       = Math.abs(totalDelta);
  const gapMs          = atMs - f.lastTensionEmitMs;
  const shouldEmit     = absDelta >= TENSION_EMIT_DELTA || gapMs >= TENSION_EMIT_MAX_GAP_MS;

  if (shouldEmit) {
    bus.emit('FIGHT_TENSION', {
      tension: newTension,
      phase:   f.phase,
      delta:   totalDelta,
      atMs,
    });
    f.lastTensionEmitMs  = atMs;
    f.lastEmittedTension = newTension;
  }
}

// ===========================================================================
// Mount Manifest (H-005)
// ===========================================================================

modeRouter.registerMountManifest({
  id:    'fightLoop',
  modes: ['TOURNAMENT_ACTIVE'],

  onMount(_nextMode, _prevMode) {
    // Subscribe to bite sequence events.
    _unsubs.push(bus.on('BITE_NIBBLE', _onBiteNibble));
    _unsubs.push(bus.on('BITE_THUD',   _onBiteThud));
  },

  onUnmount(_prevMode, _nextMode) {
    // If a fight is in progress, resolve it as hook-shaken (cleans up _pumpUnsub too).
    if (_fight) {
      _resolveFight('HOOK_SHAKEN', clock.nowMs());
    }

    // Safety net: clear pump unsub if somehow not already cleared.
    if (_pumpUnsub !== null) {
      _pumpUnsub();
      _pumpUnsub = null;
    }

    // Cancel all pending windows and the tick.
    _clearFightTick();
    _clearHooksetWindow();
    _clearNibbleWindow();

    // Release bus subscriptions.
    for (const unsub of _unsubs) unsub();
    _unsubs.length = 0;
  },
});
