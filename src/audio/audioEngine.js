/**
 * AFish Audio Engine — src/audio/audioEngine.js
 *
 * The complete procedural audio layer for AFish. Subscribes to the event bus
 * and maps game events to Web Audio API synthesis recipes. This is the single
 * audio entry point called once from engine.js (D-021 single boot call rule).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Architecture Boundaries (D-021 — LOCKED)
 * ═══════════════════════════════════════════════════════════════════════════
 *   • This file imports ONLY from '../core/eventBus.js'.
 *   • It is imported ONLY by engine.js (never by other subsystems).
 *   • It NEVER mutates stateStore. All audio state is local and ephemeral.
 *   • Audio non-determinism is out of scope for replay determinism (H-004).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Node.js Safety
 * ═══════════════════════════════════════════════════════════════════════════
 *   All Web Audio operations are gated by the _IS_BROWSER constant. In a
 *   headless Node.js harness, every event is logged via _logAudio() instead
 *   of played. Tests never crash. The bus subscriptions are registered in
 *   both environments so event-routing coverage can be grepped from logs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * D-028 Procedural Synthesis
 * ═══════════════════════════════════════════════════════════════════════════
 *   All SFX synthesized via Web Audio API oscillators, filters, and
 *   white-noise buffers. No MP3 sample loading in this file.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * D-065 Procedural Audio Math (LOCKED — do not alter constants)
 * ═══════════════════════════════════════════════════════════════════════════
 *   Tension → Hz  : freqHz(t) = 220 × 2^(t × 2)   range [220 Hz .. 880 Hz]
 *   Anti-fatigue  : gain × 0.70 when t ≥ 0.85 (paradoxical duck at peak)
 *   Timbre blend  : sine (t=0) → sawtooth (t=1) via GainNode crossfade
 *   Slack bed     : faint noise tone at t ≤ 0.05 (grace period not silent)
 *   Finder ping   : pingHz(d) = 440 × 2^(−d / 6)  shallow=high, deep=low
 *   Pressure noise: noiseGain = 0.05 + 0.15 × (p / MAX_PRESSURE)
 *   Presence enum : NONE=1×250ms  TRACE=1+80ms tail  SCATTERED=2×80ms apart
 *                   SCHOOLED=3×60ms apart
 *   Spook shelf   : high-shelf cut ≥ 800 Hz; spook level 5 → −12 dB
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * H-009 Synth Latency
 * ═══════════════════════════════════════════════════════════════════════════
 *   All voice sub-graphs (gain chains, filters, noise buffers) are pre-built
 *   in _buildFightGraph() and _buildFinderGraph() at init() time so that the
 *   first real event has zero cold-start latency. OscillatorNode instances
 *   (which are single-use) are spawned fresh per-fight or per-ping but always
 *   routed into the pre-existing graph — the costly node-creation work is
 *   amortized at boot.
 *
 * Synthesis recipes extracted verbatim from afish_synth_tester.html (root).
 */

import * as bus from '../core/eventBus.js';

// ═══════════════════════════════════════════════════════════════════════════
// Node.js Guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * True when running inside a browser that exposes AudioContext.
 * All Web Audio API calls are wrapped in checks against this constant.
 */
const _IS_BROWSER = (
  typeof window !== 'undefined' &&
  typeof (window.AudioContext ?? window.webkitAudioContext) !== 'undefined'
);

// ═══════════════════════════════════════════════════════════════════════════
// D-065 Constants (LOCKED — do not alter)
// ═══════════════════════════════════════════════════════════════════════════

const TENSION_HZ_BASE       = 220;   // A3 — oscillator frequency at t = 0
const TENSION_OCTAVES       = 2;     // exponential span: 2 octaves (A3 → A5)
const TENSION_HZ_MAX        = 880;   // A5 — oscillator frequency at t = 1
const TENSION_ANTIFATIGUE_T = 0.85;  // tension threshold for the gain duck
const TENSION_ANTIFATIGUE_Q = 0.70;  // gain multiplier above the threshold
const TENSION_SLACK_FLOOR   = 0.05;  // below this: silence tone, play noise
const PING_BASE_HZ          = 440;   // A4 — finder ping reference frequency
const PING_DEPTH_HALVING_M  = 6;     // ping Hz halves every N metres of depth
const PRESSURE_NOISE_BASE   = 0.05;  // floor noise gain at zero pressure
const PRESSURE_NOISE_RANGE  = 0.15;  // additive range from floor to ceiling
const MAX_PRESSURE          = 5;     // must match D-039 in fishBehavior.js

// ═══════════════════════════════════════════════════════════════════════════
// Module-Level State
// ═══════════════════════════════════════════════════════════════════════════

/** @type {AudioContext|null} */
let _actx       = null;

/** @type {GainNode|null} */
let _masterGain = null;

/** Current master volume [0..1]. */
let _currentVol = 1.0;

/**
 * Pre-built fight voice graph (H-009).
 * Oscillators are NOT stored here — they are created fresh per fight.
 * @type {{ sineGain: GainNode, sawGain: GainNode, toneGain: GainNode,
 *          slackGain: GainNode, slackBuffer: AudioBuffer }|null}
 */
let _fightGraph = null;

/** @type {OscillatorNode|null} */
let _fightSineOsc = null;

/** @type {OscillatorNode|null} */
let _fightSawOsc = null;

/** @type {AudioBufferSourceNode|null} */
let _fightSlackSrc = null;

/** True while a fight voice session is running. */
let _fightActive = false;

/**
 * Pre-built finder ping routing graph (H-009).
 * @type {{ shelf: BiquadFilterNode, noiseGain: GainNode }|null}
 */
let _finderGraph = null;

/**
 * Handle for the repeating sonar-scan ping interval.
 * Cleared on scan completion or FISH_FINDER_CANCELLED.
 * @type {ReturnType<typeof setInterval>|null}
 */
let _scanIntervalId = null;

/**
 * Handle for the auto-terminate timeout that kills _scanIntervalId after
 * payload.scanDurationMs to prevent audio leaks (per task requirement).
 * @type {ReturnType<typeof setTimeout>|null}
 */
let _scanTimeoutId = null;

/**
 * Collected bus unsubscribe functions, kept for a clean engine teardown path.
 * @type {Array<() => void>}
 */
const _unsubs = [];

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the audio engine.
 *
 * Must be called exactly once from engine.js (D-021 single boot call).
 * Safe to call in Node.js — exits immediately without throwing or
 * requiring any browser API. Bus listeners are registered in both
 * environments so that headless test logs show event routing.
 *
 * @param {object} [opts]
 * @param {number} [opts.volume=0.3]  Initial master volume clamped to [0..1].
 */
function init(opts = {}) {
  if (!_IS_BROWSER) {
    console.log('[audioEngine] Headless mode — Web Audio disabled, bus listeners active.');
    _registerBusListeners();
    return;
  }

  if (_actx) return; // idempotent

  try {
    _actx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (err) {
    console.warn('[audioEngine] AudioContext creation failed:', err.message);
    _registerBusListeners();
    return;
  }

  _currentVol = Math.max(0, Math.min(1, opts.volume ?? 1.0));

  _masterGain = _actx.createGain();
  _masterGain.gain.value = _currentVol;
  _masterGain.connect(_actx.destination);

  // H-009: Pre-build all persistent voice sub-graphs at init time.
  _buildFightGraph();
  _buildFinderGraph();

  _registerBusListeners();

  console.log('[audioEngine] Web Audio ready. Context state:', _actx.state);
}

/**
 * Set the master volume.
 * @param {number} vol  Target volume clamped to [0..1].
 */
function setVolume(vol) {
  _currentVol = Math.max(0, Math.min(1, vol));
  if (_masterGain) _masterGain.gain.value = _currentVol;
}

/**
 * Return the current master volume.
 * @returns {number}
 */
function getVolume() {
  return _currentVol;
}

/**
 * Play a D-065 finder ping directly.
 *
 * Exposed as a public export so that targetSelector.js can trigger a ping
 * when the player navigates between finder candidates (D-041 menu-FSM),
 * and so that tests can exercise the synthesis math without a bus event.
 *
 * @param {object} [params]
 * @param {number} [params.depthM=3]            Water depth at the target tile.
 * @param {number} [params.pressure=0]           Tile pressure level [0..5].
 * @param {string} [params.presenceHint='NONE']  NONE | TRACE | SCATTERED | SCHOOLED
 * @param {number} [params.spook=0]              Tile spook level [0..5].
 */
function playFinderPing({ depthM = 3, pressure = 0, presenceHint = 'NONE', spook = 0 } = {}) {
  if (!_IS_BROWSER || !_actx || !_finderGraph) {
    _logAudio('sonar', 'ping', { depthM, pressure, presenceHint, spook });
    return;
  }
  _playFinderPingImpl({ depthM, pressure, presenceHint, spook });
}

// ═══════════════════════════════════════════════════════════════════════════
// D-065 Math Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert tension t ∈ [0, 1] to oscillator frequency in Hz.
 * Formula: freqHz(t) = TENSION_HZ_BASE × 2^(t × TENSION_OCTAVES)
 * Result is clamped to [TENSION_HZ_BASE, TENSION_HZ_MAX].
 *
 * @param {number} t  Tension value, clamped to [0..1].
 * @returns {number}  Frequency in Hz.
 */
function _tensionHz(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return Math.min(
    TENSION_HZ_MAX,
    TENSION_HZ_BASE * Math.pow(2, clamped * TENSION_OCTAVES)
  );
}

/**
 * Convert water depth to finder ping frequency.
 * Formula: pingHz(d) = 440 × 2^(−d / 6)
 * Inverse mapping: shallow = high pitch, deep = low pitch.
 * Frequency halves every PING_DEPTH_HALVING_M metres.
 *
 * @param {number} depthM  Depth in metres (clamped to ≥ 0).
 * @returns {number}       Frequency in Hz.
 */
function _pingHz(depthM) {
  return PING_BASE_HZ * Math.pow(2, -Math.max(0, depthM) / PING_DEPTH_HALVING_M);
}

/**
 * Compute the pressure noise overlay gain.
 * Formula: noiseGain(p) = 0.05 + 0.15 × (p / MAX_PRESSURE)
 * At zero pressure → clean tone (0.05). At full pressure → audibly hashy (0.20).
 *
 * @param {number} pressure  Tile pressure [0..MAX_PRESSURE].
 * @returns {number}         Gain value [0.05..0.20].
 */
function _pressureNoiseGain(pressure) {
  const p = Math.max(0, Math.min(MAX_PRESSURE, pressure));
  return PRESSURE_NOISE_BASE + PRESSURE_NOISE_RANGE * (p / MAX_PRESSURE);
}

/**
 * Compute the spook high-shelf attenuation in dB.
 * 0 spook → 0 dB (no cut). 5 spook → −12 dB above 800 Hz (muffled / far away).
 *
 * @param {number} spook  Spook level [0..5].
 * @returns {number}      Negative dB value (0 to −12).
 */
function _spookShelfDb(spook) {
  return -(12 * Math.max(0, Math.min(5, spook)) / 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// White Noise Buffer Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a mono white-noise AudioBuffer of the requested duration.
 * Uses Math.random() — audio non-determinism is explicitly out of scope for
 * replay determinism per D-021 (H-004 applies to game state, not audio).
 *
 * @param {number} durationSec  Buffer duration in seconds.
 * @returns {AudioBuffer}
 */
function _createNoiseBuffer(durationSec) {
  const length = Math.ceil(_actx.sampleRate * durationSec);
  const buffer = _actx.createBuffer(1, length, _actx.sampleRate);
  const data   = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1; // uniform [-1, +1]
  }
  return buffer;
}

// ═══════════════════════════════════════════════════════════════════════════
// H-009: Pre-built Fight Voice Graph
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the fight voice signal chain at init time (H-009).
 *
 * Signal graph (oscillators are NOT created here; they are spawned fresh
 * for each individual fight session and connected to these persistent nodes):
 *
 *   _fightSineOsc  ──→ sineGain ──┐
 *                                   ├──→ toneGain ──→ _masterGain
 *   _fightSawOsc   ──→ sawGain  ──┘
 *
 *   _fightSlackSrc ──→ slackGain ──→ _masterGain
 */
function _buildFightGraph() {
  const g = {};

  // Per-timbre gain lanes — D-065 crossfade: sineGain fades out as tension
  // rises; sawGain fades in, delivering harmonic content without loudness jump.
  g.sineGain = _actx.createGain();
  g.sawGain  = _actx.createGain();
  g.sineGain.gain.value = 0.0;
  g.sawGain.gain.value  = 0.0;

  // Master tone bus — anti-fatigue multiplier (D-065) applied to this node.
  g.toneGain = _actx.createGain();
  g.toneGain.gain.value = 0.0; // silent until fight starts

  g.sineGain.connect(g.toneGain);
  g.sawGain.connect(g.toneGain);
  g.toneGain.connect(_masterGain);

  // Slack noise bed — D-065: plays at t ≤ 0.05 so the HOOK_SHAKEN grace window
  // is never completely silent. Uses a looping pre-generated noise buffer.
  g.slackGain = _actx.createGain();
  g.slackGain.gain.value = 0.0;
  g.slackGain.connect(_masterGain);

  // Pre-generate a 4-second looping noise buffer reused across all fights.
  g.slackBuffer = _createNoiseBuffer(4.0);

  _fightGraph = g;
}

// ═══════════════════════════════════════════════════════════════════════════
// H-009: Pre-built Finder Ping Graph
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the finder ping routing chain at init time (H-009).
 *
 * Signal graph (per-ping oscillators route through shelf → masterGain;
 * per-ping noise sources route directly through noiseGain → masterGain):
 *
 *   (per-ping OscNode) ──→ (per-ping GainNode) ──→ shelf ──→ _masterGain
 *   (per-ping NoiseSrc) ──→ (per-ping GainNode) ──────────→ _masterGain
 */
function _buildFinderGraph() {
  const g = {};

  // High-shelf filter for spook muffling (D-065).
  // Frequency 800 Hz, gain set per-ping from _spookShelfDb(spook).
  g.shelf = _actx.createBiquadFilter();
  g.shelf.type            = 'highshelf';
  g.shelf.frequency.value = 800;
  g.shelf.gain.value      = 0.0; // neutral until first ping
  g.shelf.connect(_masterGain);

  _finderGraph = g;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fight Voice Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start the fight voice for a new fight session.
 * Creates fresh OscillatorNodes (single-use) and connects them to the
 * pre-built fight graph. Idempotent — no-op if already active.
 */
function _startFightVoice() {
  // Guard: _fightSineOsc is null only when oscillators are not yet running.
  // We no longer use _fightActive here because that flag is set by the caller
  // (the FIGHT_TENSION bus handler) BEFORE this function is invoked, in order
  // to maintain routing state in headless Node.js environments.
  if (!_IS_BROWSER || !_actx || !_fightGraph || _fightSineOsc !== null) return;

  const g   = _fightGraph;
  const now = _actx.currentTime;

  // ── Sine oscillator (primary voice at low tension) ──────────────────────
  _fightSineOsc = _actx.createOscillator();
  _fightSineOsc.type = 'sine';
  _fightSineOsc.frequency.value = TENSION_HZ_BASE;
  _fightSineOsc.connect(g.sineGain);

  // ── Sawtooth oscillator (harmonic body at high tension) ─────────────────
  _fightSawOsc = _actx.createOscillator();
  _fightSawOsc.type = 'sawtooth';
  _fightSawOsc.frequency.value = TENSION_HZ_BASE;
  _fightSawOsc.connect(g.sawGain);

  // ── Slack noise bed (looping, audible only at t ≤ TENSION_SLACK_FLOOR) ──
  _fightSlackSrc = _actx.createBufferSource();
  _fightSlackSrc.buffer = g.slackBuffer;
  _fightSlackSrc.loop   = true;
  _fightSlackSrc.connect(g.slackGain);

  // Start at t=0 state: tone silent, slack bed faintly audible.
  g.sineGain.gain.setValueAtTime(0.0,  now);
  g.sawGain.gain.setValueAtTime(0.0,   now);
  g.toneGain.gain.setValueAtTime(0.0,  now);
  g.slackGain.gain.setValueAtTime(0.06, now);

  _fightSineOsc.start(now);
  _fightSawOsc.start(now);
  _fightSlackSrc.start(now);

  _fightActive = true;
}

/**
 * Update the fight voice for a new tension value.
 *
 * Implements the full D-065 tension→Hz mapping:
 *   • Exponential frequency ramp: freqHz(t) = 220 × 2^(t × 2)
 *   • Timbre crossfade: sine (t=0) → sawtooth (t=1)
 *   • Anti-fatigue duck: gain × 0.70 at t ≥ 0.85
 *   • Slack bed: active only when t ≤ 0.05
 *
 * Uses a 250 ms linear ramp (default) to prevent audible stair-stepping
 * between coalesced FIGHT_TENSION events at the 60 ms tick cadence (H-011).
 *
 * @param {number} tension   Tension value [0..1].
 * @param {number} [rampMs=250]  Automation ramp duration in milliseconds.
 */
function _updateFightVoice(tension, rampMs = 250) {
  if (!_IS_BROWSER || !_actx || !_fightGraph || !_fightActive) return;

  const g      = _fightGraph;
  const now    = _actx.currentTime;
  const target = now + (rampMs / 1000);
  const hz     = _tensionHz(tension);

  // Frequency ramp — both oscillators track in lockstep.
  if (_fightSineOsc) _fightSineOsc.frequency.linearRampToValueAtTime(hz, target);
  if (_fightSawOsc)  _fightSawOsc.frequency.linearRampToValueAtTime(hz, target);

  // D-065 timbre crossfade.
  // Sawtooth is perceptually louder at equal gain (rich harmonics), so its lane
  // gain is scaled down slightly (0.22) relative to the sine lane (0.35) to
  // keep the crossfade perceptually even.
  const sineW = Math.max(0, 1 - tension) * 0.35;
  const sawW  = Math.min(1, tension)     * 0.22;
  g.sineGain.gain.linearRampToValueAtTime(sineW, target);
  g.sawGain.gain.linearRampToValueAtTime(sawW,   target);

  // D-065 anti-fatigue duck: above t ≥ 0.85, tone gain drops to 70%.
  // This prevents a screech reflex at peak tension while keeping pitch audible.
  const antiFatigue = tension >= TENSION_ANTIFATIGUE_T ? TENSION_ANTIFATIGUE_Q : 1.0;
  const toneVol     = tension <= TENSION_SLACK_FLOOR   ? 0.0 : (1.0 * antiFatigue);
  g.toneGain.gain.linearRampToValueAtTime(toneVol, target);

  // D-065 slack noise bed: faint when slackline, silent during active fight.
  const slackVol = tension <= TENSION_SLACK_FLOOR ? 0.08 : 0.0;
  g.slackGain.gain.linearRampToValueAtTime(slackVol, target);
}

/**
 * Stop and release the fight voice.
 * Called on FIGHT_RESOLVED before playing the outcome sound.
 * Fades out over 200 ms then stops all oscillators.
 */
function _stopFightVoice() {
  if (!_IS_BROWSER || !_actx || !_fightGraph || !_fightActive) return;

  const g   = _fightGraph;
  const now = _actx.currentTime;
  const off = now + 0.20;

  g.toneGain.gain.linearRampToValueAtTime(0, off);
  g.slackGain.gain.linearRampToValueAtTime(0, off);

  if (_fightSineOsc)  { try { _fightSineOsc.stop(off);  } catch (_) { /* already stopped */ } }
  if (_fightSawOsc)   { try { _fightSawOsc.stop(off);   } catch (_) { /* already stopped */ } }
  if (_fightSlackSrc) { try { _fightSlackSrc.stop(off); } catch (_) { /* already stopped */ } }

  _fightSineOsc  = null;
  _fightSawOsc   = null;
  _fightSlackSrc = null;
  _fightActive   = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Category 1 — UI & Menu Synthesis Recipes
// Source: afish_synth_tester.html → playUI()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Menu cursor move — brief rising sine blip (600 → 800 Hz, 100 ms).
 * Fires on directional INPUT_* events when outside of a fight.
 */
function _playUI_move() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, now);
  osc.frequency.exponentialRampToValueAtTime(800, now + 0.05);
  gain.gain.setValueAtTime(0.3,  now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

  osc.start(now);
  osc.stop(now + 0.1);
}

/**
 * Menu confirm / select — triangle two-step chime (A4 → C#5, 350 ms).
 * Fires on INPUT_SPACEBAR (confirm) events when outside of a fight.
 */
function _playUI_select() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(440,    now);
  osc.frequency.setValueAtTime(554.37, now + 0.1);
  gain.gain.setValueAtTime(0,    now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

  osc.start(now);
  osc.stop(now + 0.35);
}

/**
 * Error / locked action — flat sawtooth buzz (150 Hz, 300 ms).
 * Fires on CAST_BIRDS_NEST, Workbench "Coming Soon" stub (D-068), and any
 * INPUT event that the current mode rejects as invalid.
 */
function _playUI_error() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(150, now);
  gain.gain.setValueAtTime(0.3,  now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);

  osc.start(now);
  osc.stop(now + 0.3);
}

/**
 * Mode transition swoosh — sine sweep up and back (100 → 1200 → 100 Hz, 350 ms).
 * Fires on every MODE_CHANGED event.
 */
function _playUI_transition() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(100, now);
  osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
  osc.frequency.exponentialRampToValueAtTime(100,  now + 0.30);
  gain.gain.setValueAtTime(0,    now);
  gain.gain.linearRampToValueAtTime(0.2, now + 0.15);
  gain.gain.linearRampToValueAtTime(0,   now + 0.30);

  osc.start(now);
  osc.stop(now + 0.35);
}

// ═══════════════════════════════════════════════════════════════════════════
// Category 2 — Sonar / Fish Finder Synthesis Recipes
// Source: afish_synth_tester.html → playSonar(), extended with D-065 math
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scanning pulse — clean 440 Hz sine blip with a fast attack/decay (200 ms).
 * Distinct from the full D-065 finder ping (_playFinderPingImpl) which fires
 * once with depth/pressure/presence data when results are ready. This cue fires
 * every ~1 000 ms DURING the scan to give the player continuous audio feedback
 * that the device is actively sweeping.
 *
 * Signal chain: OscillatorNode → GainNode → _masterGain
 * (Does not route through the spook shelf — the player hasn't locked on yet.)
 */
function _playSonar_scanPing() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(440, now);
  osc.frequency.exponentialRampToValueAtTime(300, now + 0.18);  // soft downward tail

  gain.gain.setValueAtTime(0,    now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.02);           // fast attack
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);     // exponential decay

  osc.start(now);
  osc.stop(now + 0.20);
}

/**
 * Cancel the active scan audio loop immediately.
 * Safe to call when no loop is running.
 */
function _clearScanLoop() {
  if (_scanIntervalId !== null) {
    clearInterval(_scanIntervalId);
    _scanIntervalId = null;
  }
  if (_scanTimeoutId !== null) {
    clearTimeout(_scanTimeoutId);
    _scanTimeoutId = null;
  }
}

/**
 * Structure echo — descending triangle bloom (150 → 80 Hz, 850 ms).
 * Fires when a high-density structure candidate is present in the scan result.
 */
function _playSonar_echo() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(80, now + 0.8);
  gain.gain.setValueAtTime(0,    now);
  gain.gain.linearRampToValueAtTime(0.3,  now + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);

  osc.start(now);
  osc.stop(now + 0.85);
}

/**
 * Target locked — square double-beep confirmation chirp (880 → 1108 Hz, 450 ms).
 * Fires on TARGET_LOCKED. The two-step rising pattern confirms the cast target commit.
 */
function _playSonar_locked() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'square';

  // First beep — A5
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.2,  now);
  gain.gain.setValueAtTime(0,    now + 0.05);

  // Second beep — A5
  osc.frequency.setValueAtTime(880, now + 0.10);
  gain.gain.setValueAtTime(0.2,  now + 0.10);
  gain.gain.setValueAtTime(0,    now + 0.15);

  // Confirmation chime — C#6 (musically confirms lock)
  osc.frequency.setValueAtTime(1108.73, now + 0.20);
  gain.gain.setValueAtTime(0.2,  now + 0.20);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.40);

  osc.start(now);
  osc.stop(now + 0.45);
}

/**
 * D-065 Finder Ping — full multi-parameter implementation.
 *
 * Computes and plays a finder ping using all four D-065 mapping formulas:
 *   • Depth    → frequency (inverse: shallow = high pitch)
 *   • Pressure → noise gain overlay (low = clean, high = hashy)
 *   • Presence → ping count and spacing pattern
 *   • Spook    → high-shelf cut (attenuates content above 800 Hz)
 *
 * @param {object} params
 * @param {number} params.depthM        Water depth in metres.
 * @param {number} params.pressure      Tile pressure [0..5].
 * @param {string} params.presenceHint  NONE | TRACE | SCATTERED | SCHOOLED
 * @param {number} params.spook         Tile spook level [0..5].
 */
function _playFinderPingImpl({ depthM, pressure, presenceHint, spook }) {
  if (!_finderGraph) return;

  const g   = _finderGraph;
  const now = _actx.currentTime;
  const hz  = _pingHz(depthM);

  // Apply spook high-shelf attenuation. Level 5 → −12 dB above 800 Hz.
  g.shelf.gain.setValueAtTime(_spookShelfDb(spook), now);

  // ── Presence → ping pattern (D-065) ───────────────────────────────────
  // NONE:      1 ping at 250 ms, no tail
  // TRACE:     1 ping at 250 ms + 80 ms faint detuned tail (echo hint)
  // SCATTERED: 2 pings 80 ms apart
  // SCHOOLED:  3 pings 60 ms apart
  const PING_DUR = 0.25; // seconds per individual ping

  const patterns = {
    NONE:      [{ offset: 0.00, tailGain: 0    }],
    TRACE:     [{ offset: 0.00, tailGain: 0.12 }],
    SCATTERED: [{ offset: 0.00, tailGain: 0 }, { offset: 0.08, tailGain: 0 }],
    SCHOOLED:  [{ offset: 0.00, tailGain: 0 }, { offset: 0.06, tailGain: 0 }, { offset: 0.12, tailGain: 0 }],
  };

  const pings = patterns[presenceHint] ?? patterns.NONE;

  for (const { offset, tailGain } of pings) {
    const t = now + offset;

    // Main ping oscillator — routes through spook shelf.
    const osc      = _actx.createOscillator();
    const pingEnv  = _actx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    osc.connect(pingEnv);
    pingEnv.connect(g.shelf);

    pingEnv.gain.setValueAtTime(0,    t);
    pingEnv.gain.linearRampToValueAtTime(0.4,   t + 0.02);
    pingEnv.gain.exponentialRampToValueAtTime(0.001, t + PING_DUR);
    osc.start(t);
    osc.stop(t + PING_DUR + 0.02);

    // TRACE faint tail — slightly detuned echo 80 ms after ping onset.
    if (tailGain > 0) {
      const tailStart    = t + 0.08;
      const tailOsc      = _actx.createOscillator();
      const tailEnv      = _actx.createGain();
      tailOsc.type = 'sine';
      tailOsc.frequency.value = hz * 0.85; // detuned "echo" reflection
      tailOsc.connect(tailEnv);
      tailEnv.connect(g.shelf);

      tailEnv.gain.setValueAtTime(0,        tailStart);
      tailEnv.gain.linearRampToValueAtTime(tailGain,  tailStart + 0.01);
      tailEnv.gain.exponentialRampToValueAtTime(0.001, tailStart + 0.10);
      tailOsc.start(tailStart);
      tailOsc.stop(tailStart + 0.12);
    }
  }

  // ── Pressure noise overlay (D-065) ────────────────────────────────────
  // Broadband noise routed directly to masterGain (bypasses shelf — noise is
  // intentionally full-spectrum to represent the sonar clutter analogy).
  const totalDur = (pings[pings.length - 1].offset + PING_DUR) + 0.05;
  const noiseGainVal = _pressureNoiseGain(pressure);

  const noiseSrc = _actx.createBufferSource();
  noiseSrc.buffer = _createNoiseBuffer(totalDur);
  const noiseEnv = _actx.createGain();
  noiseSrc.connect(noiseEnv);
  noiseEnv.connect(_masterGain);

  noiseEnv.gain.setValueAtTime(noiseGainVal, now);
  noiseEnv.gain.exponentialRampToValueAtTime(0.001, now + totalDur);
  noiseSrc.start(now);
}

// ═══════════════════════════════════════════════════════════════════════════
// Category 3 — Physical Mechanics Synthesis Recipes
// Source: afish_synth_tester.html → playPhysics()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Motor cruise — sawtooth 40 Hz carrier with 10 Hz LFO tremolo.
 *
 * An 0.5 s fade-in followed by a sustained plateau, then a 0.5 s fade-out.
 * Used on PLAYER_ARRIVED_AT_POI (short arrival chug) and on any explicit
 * motor-start navigation event.
 *
 * @param {number} [durationSec=2.5]  Total motor-chug duration in seconds.
 */
function _playPhysics_motor(durationSec = 2.5) {
  const now = _actx.currentTime;

  const osc      = _actx.createOscillator();
  const lfo      = _actx.createOscillator();
  const lfoGain  = _actx.createGain();
  const mainGain = _actx.createGain();

  // Carrier — deep 40 Hz sawtooth for diesel-engine texture.
  osc.type = 'sawtooth';
  osc.frequency.value = 40;

  // LFO — 10 Hz sine drives amplitude modulation (10 chugs per second).
  lfo.type = 'sine';
  lfo.frequency.value = 10;

  // Tremolo depth: LFO output is routed into lfoGain.gain (AM mod target).
  lfoGain.gain.value = 0.5;
  lfo.connect(lfoGain.gain);

  osc.connect(lfoGain);
  lfoGain.connect(mainGain);
  mainGain.connect(_masterGain);

  const rampIn  = Math.min(0.5, durationSec * 0.2);
  const rampOut = Math.min(0.5, durationSec * 0.2);

  mainGain.gain.setValueAtTime(0, now);
  mainGain.gain.linearRampToValueAtTime(0.4, now + rampIn);
  mainGain.gain.setValueAtTime(0.4, now + durationSec - rampOut);
  mainGain.gain.linearRampToValueAtTime(0,   now + durationSec);

  osc.start(now);
  lfo.start(now);
  osc.stop(now + durationSec);
  lfo.stop(now + durationSec);
}

/**
 * Lure splash — white-noise burst shaped by splash intensity.
 *
 * Splash kind mapping (D-038 / D-014 Tap 5):
 *   SILENT — very short (80 ms), very quiet, high-pass filtered (≥ 3500 Hz)
 *   NORMAL — short (180 ms), moderate level, high-pass filtered (≥ 2000 Hz)
 *   LOUD   — longer (600 ms), high level, low-pass filtered (≤ 800 Hz)
 *
 * @param {'SILENT'|'NORMAL'|'LOUD'} kind
 */
function _playPhysics_splash(kind) {
  const now      = _actx.currentTime;
  const isLoud   = kind === 'LOUD';
  const isSilent = kind === 'SILENT';

  const duration = isLoud ? 0.60 : isSilent ? 0.08 : 0.18;
  const peakGain = isLoud ? 0.60 : isSilent ? 0.08 : 0.22;

  const noiseSrc = _actx.createBufferSource();
  noiseSrc.buffer = _createNoiseBuffer(duration);

  const filter = _actx.createBiquadFilter();
  if (isLoud) {
    filter.type = 'lowpass';
    filter.frequency.value = 800;
  } else {
    filter.type = 'highpass';
    filter.frequency.value = isSilent ? 3500 : 2000;
  }

  const gain = _actx.createGain();
  noiseSrc.connect(filter);
  filter.connect(gain);
  gain.connect(_masterGain);

  gain.gain.setValueAtTime(peakGain, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

  noiseSrc.start(now);
}

// ═══════════════════════════════════════════════════════════════════════════
// Category 4 — Combat Synthesis Recipes
// Source: afish_synth_tester.html → playCombat(), plus nibble, phase-change,
//         landed, and hook-shaken sounds not in the original tester
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bite thud — kick-drum synth with fast pitch drop (150 → 40 Hz, 300 ms).
 * Fires on BITE_THUD (the main hookset trigger event, D-033).
 */
function _playCombat_bite() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.1); // fast pitch drop
  gain.gain.setValueAtTime(0.8,  now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

  osc.start(now);
  osc.stop(now + 0.3);
}

/**
 * Nibble tap — lighter version of the bite sound (120 → 70 Hz, 140 ms).
 * Fires on BITE_NIBBLE during the pre-hookset nibble phase (D-032).
 * Intentionally quieter and shorter than the main bite to distinguish them.
 */
function _playCombat_nibble() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, now);
  osc.frequency.exponentialRampToValueAtTime(70, now + 0.06);
  gain.gain.setValueAtTime(0.35, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);

  osc.start(now);
  osc.stop(now + 0.14);
}

/**
 * Reel clicking — 4 rapid square-wave click bursts (1000 Hz, 400 ms total).
 * Fires on INPUT_SPACEBAR_DOWN during an active fight session.
 */
function _playCombat_reel() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'square';
  osc.frequency.value = 1000;

  gain.gain.setValueAtTime(0, now);
  for (let i = 0; i < 4; i++) {
    const t = now + i * 0.08;
    gain.gain.setValueAtTime(0.1, t);
    gain.gain.setValueAtTime(0,   t + 0.02);
  }

  osc.start(now);
  osc.stop(now + 0.4);
}

/**
 * Line snap / whip crack — sawtooth sweep (2000 → 6000 Hz) plus noise burst.
 * Fires on FIGHT_RESOLVED { outcome: 'LINE_SNAPPED' } and on
 * FIGHT_THRESHOLD_CROSSED { threshold: 'SNAP' }.
 */
function _playCombat_snap() {
  const now = _actx.currentTime;

  // Sawtooth sweep — whip motion
  const osc  = _actx.createOscillator();
  const env1 = _actx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(2000, now);
  osc.frequency.exponentialRampToValueAtTime(6000, now + 0.05);
  env1.gain.setValueAtTime(0.5,  now);
  env1.gain.exponentialRampToValueAtTime(0.01, now + 0.10);
  osc.connect(env1);
  env1.connect(_masterGain);
  osc.start(now);
  osc.stop(now + 0.12);

  // Simultaneous noise burst — crack body
  const noiseSrc = _actx.createBufferSource();
  noiseSrc.buffer = _createNoiseBuffer(0.12);
  const env2 = _actx.createGain();
  env2.gain.setValueAtTime(0.5,  now);
  env2.gain.exponentialRampToValueAtTime(0.01, now + 0.10);
  noiseSrc.connect(env2);
  env2.connect(_masterGain);
  noiseSrc.start(now);
}

/**
 * Snap danger alarm — two rapid high-pitched square beeps (1400 Hz, 200 ms).
 * Fires on FIGHT_THRESHOLD_CROSSED { threshold: 'SNAP_DANGER' }.
 * Distinct from the snap crack: this is a warning, not the break itself.
 */
function _playCombat_snapDanger() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'square';
  osc.frequency.value = 1400;

  gain.gain.setValueAtTime(0,    now);
  gain.gain.setValueAtTime(0.25, now + 0.00);
  gain.gain.setValueAtTime(0,    now + 0.05);
  gain.gain.setValueAtTime(0.25, now + 0.08);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);

  osc.start(now);
  osc.stop(now + 0.2);
}

/**
 * Slack danger warning — low sine pulse (280 Hz, 350 ms).
 * Fires on FIGHT_THRESHOLD_CROSSED { threshold: 'SLACK_DANGER' | 'SLACK_LOST' }.
 * Lower pitch contrasts with the high snap-danger alarm to inform the player.
 */
function _playCombat_slackDanger() {
  const now  = _actx.currentTime;
  const osc  = _actx.createOscillator();
  const gain = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.value = 280;

  gain.gain.setValueAtTime(0,    now);
  gain.gain.setValueAtTime(0.35, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.30);

  osc.start(now);
  osc.stop(now + 0.35);
}

/**
 * Fish landed — triumphant ascending A-major triad arpeggio (A4 C#5 E5, 360 ms).
 * Fires after _stopFightVoice() on FIGHT_RESOLVED { outcome: 'FISH_LANDED' }.
 */
function _playCombat_landed() {
  const now   = _actx.currentTime;
  const notes = [440, 554.37, 659.25]; // A4, C#5, E5 (A major triad)

  for (let i = 0; i < notes.length; i++) {
    const t    = now + i * 0.12;
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = notes[i];
    osc.connect(gain);
    gain.connect(_masterGain);

    gain.gain.setValueAtTime(0,    t);
    gain.gain.linearRampToValueAtTime(0.3,  t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.25);

    osc.start(t);
    osc.stop(t + 0.3);
  }
}

/**
 * Hook shaken — dejected descending two-tone (A4 → E4, 290 ms).
 * Fires after _stopFightVoice() on FIGHT_RESOLVED { outcome: 'HOOK_SHAKEN' }.
 */
function _playCombat_hookShaken() {
  const now   = _actx.currentTime;
  const notes = [440, 330]; // A4 → E4 (a falling fifth — disappointment)

  for (let i = 0; i < notes.length; i++) {
    const t    = now + i * 0.14;
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = notes[i];
    osc.connect(gain);
    gain.connect(_masterGain);

    gain.gain.setValueAtTime(0,    t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.22);

    osc.start(t);
    osc.stop(t + 0.25);
  }
}

/**
 * Fight phase change — short sine swoop indicating fish state transition.
 *
 *   RUNNING → TIRED : descending swoop (660 → 330 Hz) — fish tiring
 *   TIRED   → RUNNING: ascending swoop (330 → 660 Hz) — fish surging
 *
 * Edge voice: uses a separate OscillatorNode and never interferes with the
 * continuous tension oscillator (D-065 edge-events use separate voices).
 *
 * @param {string} newPhase  'RUNNING' | 'TIRED' (or any future phase string)
 */
function _playCombat_phaseChange(newPhase) {
  const now     = _actx.currentTime;
  const isTired = newPhase === 'TIRED';
  const osc     = _actx.createOscillator();
  const gain    = _actx.createGain();
  osc.connect(gain);
  gain.connect(_masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(isTired ? 660 : 330, now);
  osc.frequency.exponentialRampToValueAtTime(isTired ? 330 : 660, now + 0.20);
  gain.gain.setValueAtTime(0,    now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.04);
  gain.gain.linearRampToValueAtTime(0,    now + 0.20);

  osc.start(now);
  osc.stop(now + 0.25);
}

// ═══════════════════════════════════════════════════════════════════════════
// AI Competitor Audio Cues (D-061 / D-062)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Play a brief ambient cue scaled to AI catch priority (D-062 ladder).
 *
 *   URGENT — two-note urgent alarm (took the lead — never coalesced)
 *   HIGH   — single ascending triangle chime (trophy fish)
 *   NORMAL — soft sine ping (competitor inside the cut-line)
 *   LOW    — barely-audible tick (background catch, outside cut-line)
 *
 * @param {'URGENT'|'HIGH'|'NORMAL'|'LOW'} priority
 */
function _playAI_catch(priority) {
  const now = _actx.currentTime;

  if (priority === 'URGENT') {
    // Rising minor-second alarm — A5 → A#5, two square pulses.
    const notes = [880, 932.33];
    for (let i = 0; i < notes.length; i++) {
      const t    = now + i * 0.10;
      const osc  = _actx.createOscillator();
      const gain = _actx.createGain();
      osc.type = 'square';
      osc.frequency.value = notes[i];
      osc.connect(gain);
      gain.connect(_masterGain);
      gain.gain.setValueAtTime(0.28, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);
      osc.start(t);
      osc.stop(t + 0.15);
    }
  } else if (priority === 'HIGH') {
    // Ascending triangle chime — A4 rising to E5.
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.linearRampToValueAtTime(659.25, now + 0.15);
    osc.connect(gain);
    gain.connect(_masterGain);
    gain.gain.setValueAtTime(0,    now);
    gain.gain.linearRampToValueAtTime(0.20, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.30);
    osc.start(now);
    osc.stop(now + 0.35);
  } else if (priority === 'NORMAL') {
    // Soft sine ping at E5 — present but unobtrusive.
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 659.25;
    osc.connect(gain);
    gain.connect(_masterGain);
    gain.gain.setValueAtTime(0,    now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.start(now);
    osc.stop(now + 0.18);
  } else {
    // LOW — barely audible A5 tick (50 ms).
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(_masterGain);
    gain.gain.setValueAtTime(0.03, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.start(now);
    osc.stop(now + 0.07);
  }
}

/**
 * Skunk sigh — dejected descending interval (C4 → A3, triangle, ~380 ms).
 * Fires on SIMULATED_TOURNAMENT_SKUNK when a bot finishes with zero fish.
 * Intentionally subtle — it is a background event, not a player concern.
 */
function _playAI_skunk() {
  const now   = _actx.currentTime;
  const notes = [261.63, 220]; // C4 → A3 (a falling minor third — deflated)

  for (let i = 0; i < notes.length; i++) {
    const t    = now + i * 0.18;
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = notes[i];
    osc.connect(gain);
    gain.connect(_masterGain);
    gain.gain.setValueAtTime(0,    t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
    osc.start(t);
    osc.stop(t + 0.35);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Node.js Fallback Logger
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Emit a structured console log for audio events in Node.js environments.
 * Follows the same naming conventions as the synth recipes so harness logs
 * can be grepped to verify event-routing coverage.
 *
 * @param {string} category  e.g. 'ui', 'sonar', 'physics', 'combat', 'ai'
 * @param {string} name      e.g. 'transition', 'ping', 'splash_LOUD'
 * @param {object} [meta]    Optional structured context.
 */
function _logAudio(category, name, meta) {
  const detail = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[AUDIO] ${category}:${name}${detail}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Bus Listeners — Event-to-Synthesis Dispatch Table
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register all event bus subscriptions.
 * Called exactly once from init(). Subscriptions persist for the application
 * lifetime per D-021 (audio subscribes to bus only; audio never mutates state).
 *
 * In Node.js (_IS_BROWSER = false), every handler runs the _logAudio() path
 * so that headless test runs produce a readable audio-event trace without
 * touching any browser API.
 */
function _registerBusListeners() {

  // ── MODE_CHANGED ─────────────────────────────────────────────────────────
  // Play a mode-transition swoosh on every mode change.
  _unsubs.push(bus.on('MODE_CHANGED', (evt) => {
    if (!_IS_BROWSER || !_actx) {
      _logAudio('ui', 'transition', { from: evt?.prevMode, to: evt?.mode });
      return;
    }
    _playUI_transition();
  }));

  // ── Cast Pipeline ─────────────────────────────────────────────────────────
  // AUDIO_METRONOME_TICK — short sharp tick on each beat of PHASE_1 / PHASE_3.
  // 1 000 Hz triangle, 50 ms, exponential decay: gives a crisp click without
  // the harshness of a square wave.  Routed directly to masterGain.
  _unsubs.push(bus.on('AUDIO_METRONOME_TICK', (evt) => {
    if (!_IS_BROWSER || !_actx) {
      _logAudio('cast', 'metronome_tick', { phase: evt?.phase, beat: evt?.beatIndex });
      return;
    }
    const now  = _actx.currentTime;
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.connect(gain);
    gain.connect(_masterGain);
    osc.type = 'triangle';
    osc.frequency.value = 1_000;
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.start(now);
    osc.stop(now + 0.055);
  }));

  // AUDIO_PITCH_SWEEP — rising (UP) or falling (DOWN) sine sweep over
  // payload.durationMs.  Covers the full PHASE_2 / PHASE_4 whiff window so
  // the player can judge the right moment to tap.
  //   UP   (Phase 2): 200 Hz → 800 Hz — player taps ARROW_UP before the sweep peaks.
  //   DOWN (Phase 4): 800 Hz → 200 Hz — player taps ARROW_DOWN before it bottoms out.
  // Gain ramps in over 30 ms and out over the final 80 ms to avoid clicks.
  _unsubs.push(bus.on('AUDIO_PITCH_SWEEP', (evt) => {
    const direction  = evt?.direction ?? 'UP';
    const durationMs = Math.max(100, evt?.durationMs ?? 3_000);
    if (!_IS_BROWSER || !_actx) {
      _logAudio('cast', 'pitch_sweep', { direction, durationMs, phase: evt?.phase });
      return;
    }
    const durationSec = durationMs / 1_000;
    const now  = _actx.currentTime;
    const osc  = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.connect(gain);
    gain.connect(_masterGain);
    osc.type = 'sine';
    const startHz = direction === 'UP' ? 200 : 800;
    const endHz   = direction === 'UP' ? 800 : 200;
    osc.frequency.setValueAtTime(startHz, now);
    osc.frequency.linearRampToValueAtTime(endHz, now + durationSec);
    // Gain envelope: 30 ms ramp-in, hold, 80 ms ramp-out at the end.
    const fadeIn  = Math.min(0.03, durationSec * 0.1);
    const fadeOut = Math.min(0.08, durationSec * 0.1);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.20, now + fadeIn);
    gain.gain.setValueAtTime(0.20, now + durationSec - fadeOut);
    gain.gain.linearRampToValueAtTime(0, now + durationSec);
    osc.start(now);
    osc.stop(now + durationSec + 0.01);
  }));

  _unsubs.push(bus.on('CAST_BIRDS_NEST', () => {
    if (!_IS_BROWSER || !_actx) { _logAudio('ui', 'error', { event: 'CAST_BIRDS_NEST' }); return; }
    _playUI_error();
  }));

  _unsubs.push(bus.on('CAST_LANDED', (evt) => {
    // evt.splashKind: 'SILENT' | 'NORMAL' | 'LOUD'  (D-014 Tap 5 — splashdown)
    const kind = evt?.splashKind ?? 'NORMAL';
    if (!_IS_BROWSER || !_actx) { _logAudio('physics', 'splash_' + kind); return; }
    _playPhysics_splash(kind);
  }));

  // ── Fish Finder / Sonar ───────────────────────────────────────────────────
  // FISH_FINDER_SCANNING fires at the start of every scan.
  // A repeating sonar ping plays every ~1 000 ms to signal that the device is
  // actively sweeping. The loop is guarded by two mechanisms:
  //   1. A setTimeout for payload.scanDurationMs that clears the interval
  //      automatically — prevents audio leaks if FISH_FINDER_RESULTS never fires
  //      (e.g. if scan() is modified to resolve early in a future release).
  //   2. FISH_FINDER_CANCELLED clears both handles immediately (early abort).
  _unsubs.push(bus.on('FISH_FINDER_SCANNING', (evt) => {
    const scanDurationMs = evt?.scanDurationMs ?? 10_000;

    if (!_IS_BROWSER || !_actx) {
      _logAudio('sonar', 'scan_start', { scanDurationMs, poiId: evt?.poiId, tier: evt?.tier });
      return;
    }

    // Defensive clear of any previous scan loop that wasn't terminated cleanly.
    _clearScanLoop();

    // Play first pulse immediately so the player hears feedback without delay.
    _playSonar_scanPing();

    // Repeat every 1 000 ms for the scan duration.
    _scanIntervalId = setInterval(() => {
      _playSonar_scanPing();
    }, 1_000);

    // Auto-terminate after scanDurationMs (D-021: audio must not leak).
    _scanTimeoutId = setTimeout(() => {
      _clearScanLoop();
    }, scanDurationMs);
  }));

  // FISH_FINDER_CANCELLED — player aborted the scan early (e.g. moved away).
  // Clear the interval immediately; no sound needed (abrupt silence is correct).
  _unsubs.push(bus.on('FISH_FINDER_CANCELLED', () => {
    if (!_IS_BROWSER || !_actx) {
      _logAudio('sonar', 'scan_cancelled');
      return;
    }
    _clearScanLoop();
  }));

  // D-065: use the top-ranked candidate for all ping parameters.
  // Also clear the scan-ping loop — results mean the scan has completed.
  _unsubs.push(bus.on('FISH_FINDER_RESULTS', (evt) => {
    _clearScanLoop();
    const top = evt?.candidates?.[0] ?? {};
    const params = {
      depthM:       top.depthM       ?? 3,
      pressure:     top.pressure     ?? 0,
      presenceHint: top.presenceHint ?? 'NONE',
      spook:        top.spook        ?? 0,
    };
    if (!_IS_BROWSER || !_actx) { _logAudio('sonar', 'ping', params); return; }
    _playFinderPingImpl(params);
  }));

  _unsubs.push(bus.on('TARGET_LOCKED', () => {
    if (!_IS_BROWSER || !_actx) { _logAudio('sonar', 'locked'); return; }
    _playSonar_locked();
  }));

  // ── Bite Events ───────────────────────────────────────────────────────────
  _unsubs.push(bus.on('BITE_NIBBLE', () => {
    if (!_IS_BROWSER || !_actx) { _logAudio('combat', 'nibble'); return; }
    _playCombat_nibble();
  }));

  _unsubs.push(bus.on('BITE_THUD', () => {
    if (!_IS_BROWSER || !_actx) { _logAudio('combat', 'bite'); return; }
    _playCombat_bite();
  }));

  // ── Fight Tension — D-065 Continuous Voice ────────────────────────────────
  // The fight voice is lazily started on the first FIGHT_TENSION event and
  // runs until FIGHT_RESOLVED stops it. This keeps start-of-fight latency
  // minimal while still allowing the pre-built graph (H-009) to be ready.
  _unsubs.push(bus.on('FIGHT_TENSION', (evt) => {
    // evt: { tension, trend, atMs, rampToMs }  (D-035)
    const tension = evt?.tension ?? 0;
    // _fightActive is routing state — updated in BOTH browser and Node.js so the
    // INPUT_* mutex ("suppress move blip during fight") works in headless tests.
    if (!_fightActive) _fightActive = true;
    if (!_IS_BROWSER || !_actx) {
      _logAudio('combat', 'tension', { t: tension.toFixed(3), trend: evt?.trend });
      return;
    }
    _startFightVoice(); // idempotent once _fightActive guarded internally
    _updateFightVoice(tension);
  }));

  // ── Fight Phase Change — edge voice, separate from tension oscillator ────
  _unsubs.push(bus.on('FIGHT_PHASE_CHANGED', (evt) => {
    // evt may carry { phase } or { newPhase } depending on fightLoop.js convention.
    const phase = evt?.phase ?? evt?.newPhase ?? 'RUNNING';
    if (!_IS_BROWSER || !_actx) { _logAudio('combat', 'phaseChange', { phase }); return; }
    _playCombat_phaseChange(phase);
  }));

  // ── Fight Threshold Crossed — edge voice, separate from tension oscillator
  _unsubs.push(bus.on('FIGHT_THRESHOLD_CROSSED', (evt) => {
    const threshold = evt?.threshold ?? '';
    if (!_IS_BROWSER || !_actx) { _logAudio('combat', 'threshold', { threshold }); return; }
    switch (threshold) {
      case 'SNAP_DANGER':  _playCombat_snapDanger();  break;
      case 'SNAP':         _playCombat_snap();         break;
      case 'SLACK_DANGER': _playCombat_slackDanger(); break;
      case 'SLACK_LOST':   _playCombat_slackDanger(); break; // same perceptual cue
      default: break;
    }
  }));

  // ── Fight Resolved — stop tension voice, play outcome sound ──────────────
  _unsubs.push(bus.on('FIGHT_RESOLVED', (evt) => {
    const outcome = evt?.outcome ?? '';
    // Clear routing flag in both environments so INPUT_* blips resume after a fight.
    _fightActive = false;
    if (!_IS_BROWSER || !_actx) { _logAudio('combat', 'resolved', { outcome }); return; }

    // Always stop the continuous tension voice before the outcome sound.
    _stopFightVoice();

    switch (outcome) {
      case 'FISH_LANDED':  _playCombat_landed();     break;
      case 'LINE_SNAPPED': _playCombat_snap();        break;
      case 'HOOK_SHAKEN':  _playCombat_hookShaken();  break;
      default: break;
    }
  }));

  // ── Reel Click (player reeling during fight) ──────────────────────────────
  // INPUT_SPACEBAR_DOWN fires on every press during the fight. A click burst
  // plays to confirm the reel action. Suppressed outside of fight to avoid
  // interfering with the spacebar-confirm menu sound.
  _unsubs.push(bus.on('INPUT_SPACEBAR_DOWN', () => {
    if (!_fightActive) return;
    if (!_IS_BROWSER || !_actx) { _logAudio('combat', 'reel'); return; }
    _playCombat_reel();
  }));

  // ── Navigation / Motor ────────────────────────────────────────────────────
  // PLAYER_ARRIVED_AT_POI fires when fast-travel completes. A brief motor
  // chug/fade-out conveys that the boat just docked at the new location.
  _unsubs.push(bus.on('PLAYER_ARRIVED_AT_POI', () => {
    if (!_IS_BROWSER || !_actx) { _logAudio('physics', 'motor_arrival'); return; }
    _playPhysics_motor(1.2); // short arrival burst: ramp-in + sustain + fade
  }));

  // ── AI Competitor Catches (D-061 / D-062) ─────────────────────────────────
  _unsubs.push(bus.on('AI_FISH_LANDED', (evt) => {
    const priority = evt?.ttsPriority ?? 'LOW';
    if (!_IS_BROWSER || !_actx) {
      _logAudio('ai', 'catch', { priority, bot: evt?.botId });
      return;
    }
    _playAI_catch(priority);
  }));

  _unsubs.push(bus.on('SIMULATED_TOURNAMENT_SKUNK', (evt) => {
    if (!_IS_BROWSER || !_actx) {
      _logAudio('ai', 'skunk', { bot: evt?.botId });
      return;
    }
    _playAI_skunk();
  }));

  // ── UI Navigation Blips ───────────────────────────────────────────────────
  // Directional inputs outside of fight trigger a brief menu-move blip.
  // During a fight session, directional inputs drive tension and must not
  // also trigger UI sounds — they are explicitly gated by _fightActive.
  for (const inputEvent of [
    'INPUT_ARROW_UP',
    'INPUT_ARROW_DOWN',
    'INPUT_ARROW_LEFT',
    'INPUT_ARROW_RIGHT',
  ]) {
    _unsubs.push(bus.on(inputEvent, () => {
      if (_fightActive) return; // suppress: inputs during fight are rod movements
      if (!_IS_BROWSER || !_actx) { _logAudio('ui', 'move', { event: inputEvent }); return; }
      _playUI_move();
    }));
  }

  // ── UI Select Blip ────────────────────────────────────────────────────────
  // INPUT_SPACEBAR (logical tap, not DOWN) fires in menus to confirm selection.
  // During fight, spacebar is handled by INPUT_SPACEBAR_DOWN → reel click instead.
  _unsubs.push(bus.on('INPUT_SPACEBAR', () => {
    if (_fightActive) return;
    if (!_IS_BROWSER || !_actx) { _logAudio('ui', 'select'); return; }
    _playUI_select();
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

export { init, setVolume, getVolume, playFinderPing };
