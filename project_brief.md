brief_version: 1.10

## §0 AGENT DIRECTIVES
- Read this file end-to-end on session boot.
- On conflict with §5 INVARIANTS: BLOCK AND ASK. No exceptions.
- On conflict with §6 DECISIONS: pause, surface decision, require explicit reopen.
- Never re-emit full files for this brief. Diff or surgical edit only.
- STRICT NO CODE LOCK: You are absolutely forbidden from generating, creating, or modifying any `.js`, `.json`, or script files. Output must be purely text-based architectural analysis until explicitly commanded with "INITIATE PHASE [X]".
- Batch clarifying questions into one turn.

## §1 PINNED CONTEXT
- App: Accessible Fishing (AFish). Audio-first, headless fishing simulation.
- Focus: Strategic gameplay, equipment management, and dynamic environments over visual reflexes.
- Architecture: Strict modular split. Single-purpose JavaScript files.
- Active cycle: Conceptual Design.
- App version: v0.1.0. Brief version: 1.10.
- State: Conceptual design phase. STRICT NO CODE LOCK active.

## §2 PROJECT
- Name: Accessible Fishing
- Pitch: A deeply strategic, headless fishing simulation designed for visually impaired players. Features POI fast-travel navigation, 8-way numpad micro-drifting, deep tackle customization, competitive AI tournaments, a Hub-based economy loop, and procedurally synthesized audio.
- Repo: github.com/1EyeBiney/accessible-fishing

## §3 TECH STACK
- Language: JavaScript (Node.js for initial headless testing).
- Interface: Text/Audio based. No visual rendering layer.
- Architecture: Decoupled event bus for audio cues, centralized seeded RNG, strict modularity.

## §4 CONVENTIONS
- Versioning (brief): `brief_version: X.Y`. Y bumps on every save-state. X bumps on milestone.
- File naming: camelCase for singletons/functions, PascalCase for classes.
- Modularity: No monolithic files. State, logic, and output must be isolated.
- Changelog format: `vXX.Y — short description` with `### Added/Fixed/Changed` blocks.

## §5 INVARIANTS
- a. Headless State: The engine must manage numbers, states, and coordinates without relying on a visual layer.
- b. Anti-Truncation: All code updates must provide the full file.
- c. Navigation Accessibility: Players must not be forced to blindly explore raw grid tiles.
- d. Single Source of Truth: All randomness must flow through a single seeded RNG service (`core/rng.js`) for replayability.
- e. Time Authority: A single clock service (`core/clock.js`) manages wind shifts, lure decay, and AI ticks.
- f. Decoupled Audio: The game engine never calls audio directly; it emits structured events via `core/eventBus.js`.

## §6 DECISIONS
- D-001 Navigation Paradigm: Fast-Travel POI system. Outboards are used to travel between known landmarks. Engine calculates time-cost based on distance.
- D-002 Micro-Navigation: 8-way directional system mapped to Numpad (N, NE, E, etc.) within a POI cell.
- D-003 Station Keeping: Active Oars (requires player input) vs. Passive Trolling Motor (drains battery) to fight wind/current drift.
- D-004 Casting Mechanic: Adapted 4-part timing cast. Distance set by equipment (Max-Power Calibration); timing sets accuracy.
- D-005 AI Architecture: AI runs on a "brain mode" against a precomputed "structure index" to save processing overhead, rather than scanning raw grid cells.
- D-006 AI Roster: Includes distinct personalities and top-tier pros (e.g., Bill the Legend).
- D-007 Shallow Water Override: High-speed motors automatically cut off near land to prevent blind collision frustration.
- D-008 Turn Model (SUPERSEDED in v1.2 by D-013): originally strict turn-based; rescinded.
- D-009 Coordinate System: Lake stored as sparse `Map<"x,y", Tile>` keyed via a single `coordKey()` helper. Micro-drift uses a separate local `{dx,dy}` offset frame scoped to the active POI.
- D-010 Input Layer: All input flows through `core/inputAdapter.js`, which normalizes sources (keyboard, switch, voice, controller) into `INPUT_*` events on the bus. No engine module reads raw input.
- D-011 Cast Target Anchoring: Targeting cursor commits at Tap 1 and is anchored in POI-frame coordinates for the duration of flight. Boat drift during flight does NOT shift the landing target; wind does. Boat's drifted position at splashdown determines fight start state.
- D-012 Cast Wind Lock: Wind vector used by the cast resolver is sampled at Tap 1 and held constant for the flight. Mid-flight wind shifts are deferred.
- D-013 Continuous Real-Time Tournament Clock: World clock ticks continuously in real time. Wasting time is the primary penalty. AI opponents evaluate on staggered scheduled cooldowns (Scheduled AI), NOT per-tick scans. Supersedes D-008.
- D-014 5-Tap Cast Model: Tap 1 Arrow (Backswing) → Tap 2 Spacebar (open Wind Mitigation timer) → Tap 3 Arrow (Apex; sets Scatter Circle radius) → Tap 4 Spacebar (close Wind Mitigation timer; duration match vs Tap1→Tap3 sets mitigation 0..1, perfect = 80% wind reduction) → Tap 5 Arrow (Splashdown; SILENT / NORMAL / LOUD). Scatter and Mitigation are orthogonal quality axes.
- D-015 Whiff / Bird's Nest: Inter-tap timeout creates a Bird's Nest. Penalty is a 10–15 second input lockout via `inputAdapter`. The world clock continues to advance during the lockout.
- D-016 Cross-POI Boundary Spool Wall: Casts that exceed the local POI frame radius are clamped at the boundary (invisible spool wall) and drop straight down at the clamp point. Spook is purely radial; directional spook (Refinement B) rejected.
- D-017 Game Mode FSM: `state.mode` is the single source of truth for mode. Modes: BOOT, FOCUS_TRAP, PROFILE_SELECT, HUB, TOURNAMENT_BRIEFING, TOURNAMENT_ACTIVE, TOURNAMENT_RESULTS. Only `core/modeRouter.js` mutates it. Subsystems register a mount manifest declaring which modes they run in.
- D-018 Hub Pauses Clock: On enter-HUB, `modeRouter` calls `clock.pause()`. On enter-TOURNAMENT_ACTIVE, `clock.reset()` then `clock.start()`. Only `modeRouter` is permitted to drive the clock for mode reasons (preserves §5e).
- D-019 State Partition: State is partitioned into `profile` (persistent, on disk via adapter), `hub` (carried between tournaments: wallet, owned boat, tackle inventory), `tournament` (disposable per-run), and `session` (UI/focus, never persisted).
- D-020 Auto-Save Triggers: Auto-save fires silently (a) after every Hub mutation that changes wallet or inventory and (b) on enter-HUB after a tournament resolves. No mid-tournament save. Quit-during-tournament forfeits the run.
- D-021 Audio Boundary: `audio/` subscribes to the bus only. The engine never imports audio modules outside the single boot call. Audio never mutates `stateStore`. Audio non-determinism is out of scope for replay determinism (H-004).
- D-022 Boat as Stat Block: Boats are stat blocks in `equipment/boats.js` with `speedTilesPerMin`, `shallowDraftMin`, `noiseProfile`, `fuelType`, `fuelPerTile`, `windPenalty`, `stabilityForCasting`, `upgradeSlots`. `poiTravel.js` reads `state.hub.activeBoat`; `poiGraph` edges expose `minDepth` and `maxDepth` so boat draft filters available routes. Rowboats reach shallow POIs that bass boats cannot; bass boats reach distant/chop POIs that rowboats cannot. Upgrade is a true tradeoff, not a strict ladder.
- D-023 Focus Trap Boot: First user-facing screen after BOOT is FOCUS_TRAP, a single live region that holds screen-reader focus until the player issues a confirmed input. Required for reliable accessibility startup.
- D-024 Profile Storage Adapter: `profile/profileSerializer.js` is an adapter behind a `load()/save()` interface. Concrete backend (Node fs JSON, browser localStorage, or both) is deferred. No subsystem touches storage directly.
- D-025 Hub Lockout During Tournament: Once TOURNAMENT_ACTIVE is entered, all Hub menus (shops, workshop, boat, tackle) are inaccessible. Preparation is permanent for the run. `hub/*` modules unmount on enter-TOURNAMENT_ACTIVE per D-017 mount manifests.
- D-026 Weigh-In Early: The player may end a tournament run early at the dock POI. On WEIGH_IN, the player's score locks, then the clock fast-forwards (manual-mode `tick()` to tournament end-time) so Scheduled-AI opponents finish their runs deterministically. After fast-forward, results are computed and mode transitions to TOURNAMENT_RESULTS, then HUB. The fast-forward path uses the same clock callbacks as real-time play — no separate simulation code path.
- D-027 Single Currency v0.1: One wallet field `state.hub.money`. Sponsorships, reputation, and gated tiers are deferred. `tournament/payout.js` writes only to this field.
- D-028 Procedural Audio Synthesis: `audio/sfxBank.js` prioritizes Web Audio API procedural synthesis (oscillators, filters, white-noise nodes) over MP3 samples for UI clicks, splashes, reel zips, and tension snaps. Sample files are reserved for content that cannot be reasonably synthesized (e.g., music beds, distinctive ambience). New module `audio/synthGraph.js` owns reusable synth voices; `sfxBank.js` is the lookup/dispatch surface.
- D-029 Input Edge Model: `core/inputAdapter.js` emits `INPUT_<TYPE>_DOWN` and `INPUT_<TYPE>_UP` for every input. The existing `INPUT_<TYPE>` "tap" event is preserved and now fires on UP when `heldMs < TAP_THRESHOLD_MS` (default 150ms). The adapter exposes `isHeld(type)` and `heldDuration(type)` queries. No subsystem polls the bus for held state; consumers query the adapter or subscribe to edges. The 5-tap cast (D-014) consumes tap events only and is unaffected.
- D-030 Lockout Forced Release: If `inputAdapter.lock()` engages while an input is held, the adapter emits a synthetic `INPUT_<TYPE>_UP { reason: 'LOCKOUT_FORCED_RELEASE' }` for each currently-held input so consumers cannot leak hold state. Re-engaging requires a fresh DOWN after unlock. Same forced release fires on every `MODE_CHANGED` via `inputAdapter.releaseAll()` (see H-010).
- D-031 Fight Input Conflict & Idle Decay: STRICT MUTEX. While both `SPACEBAR` (reel) and `ARROW_DOWN` (give drag) are held simultaneously, neither effect applies; tension reverts to the phase-dependent idle decay. Idle decay (no input or mutex-cancelled input) is phase-dependent: in Running phase tension drifts UP toward a Running equilibrium; in Tired phase tension drifts DOWN toward a Tired equilibrium. Tired is therefore the strategic reel-in window.
- D-032 Strike Pipeline: `fish/strikeModel.js` evaluates bite probability on cast splashdown (CAST_LANDED) using lure-depth-vs-fish-depth match, lure profile vs species preference, and rejects if `castSpookModel.isSpooked(offset, atMs)`. On success, schedules a bite timer via `clock.schedule(rngStream('fish').int(min,max), ...)` through `fish/biteTimer.js`. Nibble count is DYNAMIC — computed per bite by `strikeModel` from species intelligence, environmental conditions (shade, time of day), and the fish's current mood-to-eat. Not a fixed value.
- D-033 Hookset Trap & Trigger: Pre-bite, `fish/strikeModel.js` (via `biteTimer`) emits 1–N `BITE_NIBBLE` events (count from D-032). Any input during the NIBBLE_WINDOW after a nibble cancels the cast (lure pulled). The `BITE_THUD` event opens a HOOKSET_WINDOW. Baseline window is 750ms (chosen from prior accessible-game audio-reflex testing) and shrinks dynamically based on smarter species, poorer environmental conditions, or mismatched equipment — never grows beyond baseline. The hookset key is `ARROW_UP` (matches "rod up" gesture). An `INPUT_ARROW_UP_DOWN` edge inside the window transitions to FIGHT; outside the window, wrong key, or any input during a NIBBLE cancels the cast. All windows are tournament-clock relative for replay determinism.
- D-034 Acoustic Fight Loop: `casting/fight.js` registers a `clock.every(FIGHT_TICK_MS=60, ...)` recurrence on FIGHT enter; cancels on FIGHT_RESOLVED. Per tick: read `inputAdapter.isHeld('SPACEBAR')` and `isHeld('ARROW_DOWN')`, advance tension and fish stamina via `casting/tensionModel.js` (pure math), drive Running↔Tired transitions via `fish/fishStateMachine.js`, emit coalesced events.
- D-035 Fight Event Channels: `fight.js` emits four distinct channels: `FIGHT_TENSION { tension, trend, atMs, rampToMs }` (coalesced; emitted only when |Δtension|>0.02 OR every 250ms), `FIGHT_PHASE_CHANGED` (edge), `FIGHT_THRESHOLD_CROSSED` (edge: SLACK_DANGER, SNAP_DANGER, SNAP, SLACK_LOST), `FIGHT_RESOLVED` (terminal). `audio/synthGraph.js` consumes `FIGHT_TENSION` for continuous pitch via Web Audio `linearRampToValueAtTime` between events; consumes edge events for distinct alarm voices.
- D-036 Fight Failure Modes: Tension == 1.0 → `LINE_SNAPPED` (fish lost). Tension at 0.0 continuously for `SLACK_GRACE_MS = 1500` → `HOOK_SHAKEN` (fish lost). Successful reel-in to landing distance → `FISH_LANDED`.
- D-037 Water Tile Schema (LOCKED v0.1): Tile = `{ id, coord, traits, state }`. `traits` immutable post-generation: `depth { bottomM, minM, maxM, slopeDeg }`, `bottom { primary, secondary, hardness }` with enum {MUD, SAND, GRAVEL, ROCK}, `cover { type, density, canopyDepthM, snagRisk, shadeFactor }` with enum {NONE, WEEDBED, TIMBER, LILYPADS, DOCK, BRUSHPILE, ROCKPILE, OVERHANG}, `tags[]` from v0.1 taxonomy {DROP_OFF_EDGE, WEEDBED_INNER, WEEDBED_EDGE, TIMBER_INNER, TIMBER_EDGE, AMBUSH_POINT, OPEN_FLAT, POINT, TRANSITION, SHADED_DAY}, `reach { fromDockMin, draftClass }`. `state` mutable per tournament: `spook { level, updatedAtMs, sourceEventId }`, `pressure { level, updatedAtMs, lastCastAtMs, lastCatchAtMs }`, `occupancy { fishCount, fishCountStaleAtMs }`, `events[]` (diagnostic, NOT serialized in replay snapshots). Per-tile `flow` REMOVED from v0.1; flow is per-POI only. Tile existence in the sparse Map encodes water (D-009); no `isWater` field.
- D-038 Spook Math (LOCKED): `MAX_SPOOK = 5`, `SPOOK_DECAY_MS_PER_LEVEL = 12000`. Splash increments: SILENT 0, NORMAL +1, LOUD +3. Compute-on-read: `currentSpook(atMs) = max(0, level - floor((atMs - updatedAtMs) / 12000))`. Owned by `casting/castSpookModel.js` (per H-003); no per-tick bus traffic for decay.
- D-039 Pressure / Fished-Out Math (LOCKED): `MAX_PRESSURE = 5`, `PRESSURE_DECAY_MS_PER_LEVEL = 90000` (90s/level, ~7.5min full decay). Increments: CAST +1, HOOKSET +1, CATCH +1 (full success cycle = +3). `PRESSURE_STRIKE_PENALTY = 0.6` (max pressure cuts bite probability by 60%, leaves a stubborn-fish floor). Compute-on-read pattern mirrors D-038. Owned by new module `fish/pressureModel.js`. Pressure is orthogonal to spook — separate causes, separate decay rates, separate consumers (finder ranking + strike weighting).
- D-040 POI Frame-Boundary Penalty (LOCKED): If integrated drift in `navigation/microDrift.js` would push the boat outside `frameRadius`, the boat snaps to a REPOSITIONING sub-state and the tournament clock advances by exactly 5 in-game minutes (the repositioning penalty). POI graph distances must be tuned so drifting between adjacent POIs is never a viable free-travel exploit. Penalty is fixed (not scaled by overshoot) for v0.1.
- D-041 Fish Finder Menu Pivot (CORE DAY-ONE MECHANIC): Manual cursor traversal of the 81-tile micro-frame is REMOVED. The player presses SCAN; `equipment/fishFinder.js` queries `world/structureIndex.js` for ranked frame-local candidates, augments with live `castSpookModel.readSpook` and `fish/pressureModel.readPressure`, and emits `FISH_FINDER_RESULTS { candidates: [{ id, offset, label, depthM?, bottom?, spook?, pressure?, presenceHint?, speciesBand? }] }`. New module `casting/targetSelector.js` is a menu-FSM that consumes player navigation (UP/DOWN/ENTER) and emits `TARGET_LOCKED { poiId, offset, candidateId, lockedAtMs, finderTier }`. `castResolver.js` consumes TARGET_LOCKED as the new Tap-1 commit trigger; D-011 anchoring rule is otherwise unchanged.
- D-042 Finder Tiers & Angler's Intuition (LOCKED): Tier ladder is a function of equipped Fish Finder (tied to boat upgrades). Without a Finder, the player uses ANGLER'S INTUITION: scan time 10 in-game seconds, minimal low-quality candidates. Equipped tiers: BASIC 6000ms / cap 4 / fields {offset, coverType}; MID 4500ms / cap 5 / + {depthM, bottom}; PRO 3500ms / cap 6 / + {spookLevel, presenceHint}; ELITE 2500ms / cap 8 / + {speciesBand}. Higher tier = more information AND faster scan. `presenceHint` enum: NONE, TRACE, SCATTERED, SCHOOLED. Exact fish-by-tile counts are NEVER returned (accessibility safety valve preserves strategic ambiguity).
	- D-043 Scan Mutual Exclusion (LOCKED): SCAN is locked out while casting (any 5-tap state ≠ IDLE), retrieving, or fighting. Scanning and casting are mutually exclusive states enforced by the cast/fight FSMs setting a `state.tournament.scanLocked` flag that `targetSelector` and `fishFinder` both check. Auto-rescan: SILENT INVALIDATION. If a candidate's pressure or spook crosses a threshold mid-session, it silently drops from the active list; the player must manually re-scan to discover this.

	- D-044 Equipment/Entity Triangle Schema (LOCKED): Rod, Lure, and Fish schemas are strictly partitioned as follows:
		- Rod: { id, class, lengthIn, tier, power (UL–XH), action (SLOW–XFAST), lureWeightRangeOz {min,max,sweet}, maxLineTension, compliance, hooksetSensitivity, durability, audio }
		- Lure: { id, category (9 types), tier, weightOz, profile, presentation {runDepthM, actionType, retrieveStyles, noiseProfile}, snagRiskModifier, presentationProfile, sizeProfile, colorClass, speciesAffinity, durability, audio }
		- Fish Species: { id, speciesBand, preySizeBand, wariness, intelligence, moodVolatility, nibbleBand, habitat {depthAffinityM, bottomAffinity, coverAffinity, tagAffinity}, presentationPreferences, diurnal, stamina, fightStyle (5 types), pullForceCurve, tensionMultipliers, mouthHardness, hookRetention, weight, audio }
		- All cross-entity math is normalized to [0..1] match scores. No field exists without a named consumer in strikeModel.js, hookset.js, or tensionModel.js. Procedural-audio block required for all.

	- D-045 Rod Power Ladder (LOCKED): The full 7-step rod power ladder is used: UL, L, ML, M, MH, H, XH. Numeric mappings for power/action are locked as per schema table. No reduction for v0.1.

	- D-046 Lure Categories (LOCKED): All 9 day-one lure categories are present: CRANKBAIT, JIG, WORM, SPINNERBAIT, TOPWATER, JERKBAIT, SPOON, SWIMBAIT, LIVE_BAIT. No category trimming for v0.1.

	- D-047 Fish Fight Styles (LOCKED): All 5 day-one fight styles are present: BULLDOG, RUNNER, JUMPER, DIVER, THRASHER. No reduction for v0.1.

	- D-048 Species Affinity (LOCKED): Lure-to-species affinity is hand-tuned per lure (not derived from category × species matrix). Each lure may override affinity for any species.

	- D-049 Lure Memory Decay (LOCKED): Fish instance lure memory is time-decay based. Rejected lures are forgotten after 60 in-game seconds. No count cap is used. This affects strikeModel.js intelligence penalty.

	- D-050 Hookset Window Floor (LOCKED): The hookset window width (see D-033) has an absolute hard floor of 300ms for accessibility. No fish or rod can shrink the window below this value.

	- D-051 Live Bait Vigor (LOCKED): Live Bait is a consumable with a degrading "vigor" state (100% to 0%). Vigor degrades per cast, per nibble, and over time. When vigor reaches 0%, the bait is lost. Live Bait is not infinite and must be replenished.

	- D-052 Mismatched Lure Penalty (LOCKED): Casting a lure outside the rod's rated weight range applies a severe penalty to the Scatter Circle (accuracy) ONLY. No cast distance penalty and no forced Bird's Nest lockout are applied.

	- D-053 Diurnal Multipliers (LOCKED): Diurnal strike multipliers are hand-tuned per species (not global or pattern-based). Each fish species defines its own DAWN/DAY/DUSK/NIGHT multipliers.

	- D-054 Arms Race AI Progression (LOCKED): AI bots do not have wallets or persistent inventory. Instead, each tournament event specifies an `aiGearTier` (1–5) for all AI competitors, which advances as the in-game calendar progresses. The player must upgrade gear to keep pace with the AI arms race. AI gear tier is advanced by week, not by win/loss.

	- D-055 Infinite Repeatable Tournaments (LOCKED): All tournaments are infinitely repeatable. Players may re-enter and grind previously won tournaments for money or gear. There is no lockout after a win.

	- D-056 Endless Calendar, 1-Per-Week Cadence (LOCKED): The game operates on an endless in-game calendar. Each week, the Hub offers exactly one tournament, rotating through available lakes and tiers. The player may enter or "Skip Week" (advancing the calendar, allowing AI to progress, and rerolling weather). There is no yearly cap on entries or progression.

	- D-057 Lake-Owned Dynamic Weather (LOCKED): Each Lake owns its own dynamic weather and seasonal system. When a tournament occurs, it inherits the Lake's current weather and season for that calendar week. Tournament schemas do not hardcode weather; instead, they reference the Lake's state at the time of the event.

  - D-058 Bot Profile Schema (LOCKED): Each AI bot is defined by `{ id, displayName, personalityArchetype, patience, targetPreference {VOLUME, BALANCED, TROPHY summing to 1.0}, adaptability, skill, poiSelectionBias, weatherSensitivity, lureRotation, tierSkillCurve {matchedTier, underTier, overTier}, audio {ttsVoiceId, catchPhrasePool, skunkPhrase} }`. All stats normalized [0..1] except curated rotations and audio tokens. Consumers: `ai/brainBase.js` + `ai/tournamentScheduler.js`. The six archetypes are LOCKED: GRINDER, TROPHY_HUNTER, OPPORTUNIST, GAMBLER, METHODICAL, RUN_AND_GUN. `lureRotation` is hand-curated per bot (NOT auto-generated from `aiGearTier × archetype`).

  - D-059 Headless Success Equation (LOCKED): `ai/tournamentScheduler.js` resolves catches on Scheduled Cooldown ticks (D-013) — never per-physics-tick, never simulating cast/fight. P_catch = base(tier) · S(skill) · G(gearTier) · W(weather, lake) · M_lure↔species · M_lure↔poi · R(pressure). Terms: `base(tier=1..5) = [0.45, 0.40, 0.35, 0.30, 0.25]`; `S(skill) = 0.5 + 0.5 * skill`; `G(gearTier) = tierSkillCurve[matched|under|over]`; `W = 1 + weatherSensitivity * (lakeWeatherBias[species] - 0.5)`; `M_lure↔species` from D-044/D-048; `M_lure↔poi` = dot-product of lure profile vs structureIndex tags × poiSelectionBias; `R(pressure) = 1 - (PRESSURE_STRIKE_PENALTY * tile.pressure / MAX_PRESSURE)` per D-039. Final clamped to [0.05, 0.95]. NO desperation mode — math is pure and consistent across the entire tournament duration. Weight sampling on hit: `weightKg = lognormal(μ,σ) * (1 + 0.4*skill) * (1 + 0.5*targetPreference.TROPHY - 0.2*targetPreference.VOLUME) * tierWeightCurve[gearTier]` with `tierWeightCurve = [0.85, 0.92, 1.00, 1.08, 1.18]`. Trophy-band gate: `rng < min(0.12, 0.10 + targetPreference.TROPHY * 0.04)` — Trophy Hunter trophy rate CAPPED AT 12% so human players retain a fair advantage.

  - D-060 Bot Cooldown Cadence (LOCKED): `botCooldownMs = baseTickMs(tier) * (1.5 - 0.5 * skill) * weatherTickMod(lake)` where `baseTickMs(tier=1..5) = [180000, 150000, 120000, 90000, 60000]` (3min..1min) and `weatherTickMod = {optimal: 0.85, neutral: 1.00, harsh: 1.30}`. Cooldown handle is registered via `clock.every(...)` per bot and MUST cancel on tournament-end / mode change (per H-005). Under-tier penalty for bot vs event = `0.70` (moderate) as locked in `tierSkillCurve.underTier`.

  - D-061 SIMULATED_CATCH Event Schema (LOCKED): `{ type: "SIMULATED_CATCH", atMs, botId, botDisplayName, personalityArchetype, speciesId, speciesDisplayName, weightKg, isTrophy, isPersonalBest, poiId, leaderboardImpact { newRank, previousRank, newBagWeightKg, tookTheLead, knockedOff }, ttsPriority: LOW|NORMAL|HIGH|URGENT, phraseToken, rngSeed }`. `leaderboardImpact` MUST be pre-computed by the emitter before `bus.emit` so downstream consumers (TTS, audio, leaderboard) receive a single consistent snapshot (see H-016). **`lureId` is INTENTIONALLY OMITTED** from the event payload — AI lure choices remain secret on the bus to prevent players from reverse-engineering the AI's tackle setup. Bots that finish a tournament with zero fish emit `SIMULATED_TOURNAMENT_SKUNK { botId, botDisplayName, skunkPhrase, atMs }` on tournament-end (MP3 voice lines mapped later by `audio/sfxBank.js`).

  - D-062 TTS Priority Ladder for AI Catches (LOCKED): URGENT = `tookTheLead == true` (never coalesced); HIGH = `isTrophy == true` (coalesced with LEADERBOARD_CHANGED if same bot within window); NORMAL = catch from a bot inside the prize cut-line (max 1 announcement per bot per 3s, coalesce excess); LOW = catch from non-cut-line bot (coalesced into "two more bots are on the board" summary line). `audio/ttsQueue.js` owns the queue, priority sort, and coalescing window; the scheduler never calls TTS directly (preserves D-021 audio boundary).

  - D-063 Win-Condition Objective Switch (LOCKED): On tournament-enter, every bot reads `tournament.rules.winCondition` and applies an objective-specific behavior override WITHOUT mutating its personality stats. Mode summary: HEAVIEST_BAG → top-5 swap-or-keep bag logic, patience × 1.00, trophy lures favored; BIGGEST_FISH → single-best-discard logic, patience × 0.60, trophy lures only, trophy gate boosted within the 12% cap; TOTAL_CATCH_COUNT → all-catches-count, patience × 0.50, fast lures favored. Objective mismatch penalty is **mathematically scaled**: `mismatchPenalty = 1 - 0.20 * (1 - targetPreference.alignmentWith(winCondition))` where alignment maps `TROPHY` to BIGGEST_FISH / HEAVIEST_BAG and `VOLUME` to TOTAL_CATCH_COUNT. Penalty applied as a multiplier on `S(skill)` in D-059. Stat-pure bots (perfect alignment) take no penalty.

  - D-064 Bot Count Scaling (LOCKED): Tournament `competitorCount` scales by tier. Player + N-1 AI bots where N = `[5, 6, 6, 7, 8]` for tier 1..5. Slot fill rule: sample distinct bots from the personality archetype roster weighted by tier (low tiers favor GRINDER / RUN_AND_GUN; high tiers favor TROPHY_HUNTER / METHODICAL / legendary personalities like Bill the Legend).

  - D-065 Procedural Synth Mapping (LOCKED): `audio/synthGraph.js` owns the math for all procedural-audio mappings. Math is referential-transparent (pure functions of input scalars) and decoupled from any subsystem state. Locked constants and formulas:
    - **Tension → Hz** (consumes D-035 FIGHT_TENSION): `freqHz(t) = TENSION_HZ_BASE * 2^(t * TENSION_OCTAVES)` with `TENSION_HZ_BASE = 220` (A3), `TENSION_OCTAVES = 2`, `TENSION_HZ_MAX = 880` (A5). Curve is **exponential** (musical/log-perceptual), implemented via Web Audio `linearRampToValueAtTime` between coalesced events. Granularity preserves the D-035 Δ>0.02 gate — no scale-snapping.
    - **Anti-fatigue rules**: above `t ≥ 0.85`, oscillator gain drops 30% (paradoxical “duck at peak” keeps pitch info without screech reflex). Timbre crossfades from sine (t=0) to soft-clipped sawtooth (t=1) for drama via harmonics, not loudness. At `t ≤ 0.05` (slack territory), oscillator mutes and a low ambient noise bed plays so HOOK_SHAKEN grace isn’t silent. Edge events (phase / threshold) use separate voices and never compete with the tension oscillator.
    - **Finder ping** (consumes D-041 FISH_FINDER_RESULTS menu navigation): single entry point `playFinderPing({depthM, pressure, presenceHint, spook})`. Fire-and-forget (no queue). Mutually exclusive with cast/retrieve/fight per D-043 scan lockout.
    - **Depth → ping Hz**: `pingHz(depthM) = 440 * 2^(-depthM / 6)` — inverse (shallow = high, deep = low); halves every 6 meters.
    - **Pressure → noise gain** (overlay on ping): `noiseGain(p) = 0.05 + 0.15 * (p / MAX_PRESSURE)`. Low pressure = clean tone; high pressure = audibly hashy.
    - **Presence hint → envelope** (PRO+ finder only): NONE = single 250ms ping; TRACE = single 250ms ping + 80ms faint tail; SCATTERED = two pings 80ms apart; SCHOOLED = three pings 60ms apart. Multi-ping envelope is the primary auditory channel for presence — NO TTS for this field.
    - **Spook → high-shelf cut** (PRO+ finder only): high-frequency content attenuated as spook rises; level 5 cuts everything above 800Hz by 12dB (“far away / muffled”).
    - **TTS coexistence**: finder ping is procedural and arrives in ~30ms; TTS short-form summary (categorical fields only: cover type, species band) is queued NORMAL priority separately via `audio/ttsQueue.js`. Ping never blocks TTS; TTS never delays ping. Preserves D-021 audio boundary.
    - **Synth voice precaching**: all voices (tension oscillator, ping voice, noise overlay) are pre-built and cached at audio boot per H-009 to eliminate cold-synth first-trigger latency.
## §7 PREFERENCES
- Full, unabbreviated files for code generation.
- Copy buttons for all generated changelogs and prompts.
- Tables/bullets over prose in chat.

## §8 KNOWN HAZARDS
- H-001 Vector Resolution Ambiguity: Wind, drift, and motor thrust must be resolved in a strict, declared pipeline to prevent logic drift.
- H-002 AI Perf at Scale: Scanning grids per-tick will stall the loop. Must use the structure index AND scheduled cooldowns (D-013).
- H-003 Cast Spook Coupling: Splashdown spook state is consumed by `fish/strikeModel.js`. It must live in `casting/castSpookModel.js` (NOT inline in resolver, NOT inline in strike model) to preserve single-purpose module boundaries.
- H-004 Real-Time Determinism: Under D-013, replay determinism requires recorded `INPUT_*` events to be timestamped against the tournament clock, not wall-clock. The clock must support a manual/replay mode.
- H-005 Mode Leak: Subsystems left subscribed to the bus across a mode change (e.g., AI scheduler still ticking in HUB) cause silent state drift and resource waste. Mitigation: every subsystem registers a mount manifest with `onUnmount` that cancels all clock handles and bus subscriptions. Engine boot test asserts zero stray subscriptions after a HUB↔TOURNAMENT round-trip.
- H-006 Save Tampering: Profile JSON on disk is a tempting save-edit target. Mitigation deferred, but flagged: design for a checksum or signed save file before v1.0.
- H-007 Audio Queue Backpressure: A flood of bus events (rapid sonar pings, fast travel) can swamp the TTS queue. Mitigation: `audio/ttsQueue.js` enforces priority + coalescing (drop duplicate `SONAR_PING` within window).
- H-008 Weigh-In Fast-Forward Determinism: D-026 fast-forwards the clock to simulate AI completion. The fast-forward MUST drive the same `clock.tick()` path used in real-time play so AI scheduled callbacks fire identically. A separate "simulate remaining tournament" code path would diverge from live play and is forbidden.
- H-009 Synth Audio Latency: Procedural SFX (D-028) constructed on the audio thread can introduce first-trigger latency on cold synth voices. Mitigation: `audio/synthGraph.js` pre-builds and caches voice graphs at audio boot.
- H-010 Held-Input Leak Across Mode Change: A `MODE_CHANGED` event while keys are held could leave consumers stuck. Mitigation: `core/modeRouter.js` calls `inputAdapter.releaseAll()` on every mode transition, emitting synthetic UP edges for every held input (per D-030).
- H-011 Fight Tick vs Audio Frame Drift: If `FIGHT_TICK_MS` is set too high, audio ramps audibly stair-step; too low, bus traffic spikes. 60ms with delta-gated emission (D-035) is the declared sweet spot. Changes to this constant require a brief amendment.
- H-012 Strike Timer in Fast-Forward: D-026 weigh-in fast-forward must NOT skip past pending bite timers; the clock fast-forward path already executes scheduled callbacks in order, so this is a regression-test target, not a code change.
- H-013 Pressure / Spook Conflation Risk: Pressure and Spook are ORTHOGONAL state variables (D-038 vs D-039). They MUST NOT be merged into a single counter. Different causes, different decay rates, different consumers. Conflation would force a single decay rate that is wrong for both behaviors and would couple the cast pipeline to the finder pipeline, violating single-purpose modules.
- H-014 Finder ↔ Cast State Coupling: `equipment/fishFinder.js` and `casting/*` must communicate ONLY through `state.tournament.scanLocked` flag plus `TARGET_LOCKED` and `FISH_FINDER_RESULTS` events. No direct imports between finder and cast modules. Violations re-introduce the spaghetti-FSM failure mode the modular split exists to prevent.
- H-015 AI Sub-Stream Determinism: Every bot's RNG calls MUST route through dedicated sub-streams: `rngStream('aiBrain:' + botId)` for movement / lure rotation / POI selection, and `rngStream('aiCatch:' + botId)` for P_catch rolls and weight sampling. Mixing streams across bots or sharing the world RNG breaks replay determinism (§5d). Verified by the replay test in Phase 9.
- H-016 Leaderboard-Before-Emit Ordering: `SIMULATED_CATCH` events MUST carry pre-computed `leaderboardImpact` (D-061). Emitting before the leaderboard commits would let TTS and audio consumers read stale rank state and announce wrong standings. The scheduler computes the impact, commits the leaderboard write, then emits the event in a single atomic block.

## §9 CORE FILES (Proposed Modular Split)
- `src/core/` (eventBus.js, clock.js, rng.js, stateStore.js, inputAdapter.js, modeRouter.js)
- `src/audio/` (audioManager.js, audioRoutes.js, ttsQueue.js, sfxBank.js, synthGraph.js, musicBed.js)
- `src/profile/` (profileStore.js, profileSerializer.js)
- `src/hub/` (hubMenu.js, baitShop.js, tackleShop.js, boatShop.js, workshop.js, leaderboardsView.js, soundMenu.js, economy.js)
- `src/world/` (grid.js, lakeGenerator.js, structureIndex.js, poiGraph.js, tileTraits.js)
- `src/navigation/` (boatController.js, poiTravel.js, microDrift.js, stationKeeping.js, wind.js, motor.js, shallowOverride.js)
- `src/casting/` (castPower.js, castTiming.js, castValidator.js, castResolver.js, castSpookModel.js, hookset.js, tensionModel.js, fight.js, targetSelector.js)
- `src/equipment/` (rods.js, lures.js, crafting.js, durability.js, liveBait.js, fishFinder.js, boats.js)
- `src/fish/` (species.js, population.js, strikeModel.js, biteTimer.js, fishStateMachine.js, pressureModel.js)
- `src/ai/` (brainBase.js, primeDirective.js, tournamentScheduler.js, personalities/billTheLegend.js)
- `src/tournament/` (circuit.js, leaderboard.js, scoring.js, payout.js, weighIn.js)
- `src/engine.js` (boot sequence, mode router wiring, tick loop ownership; no game logic)

## §10 GLOSSARY
- POI: Point of Interest (landmark for fast-travel).
- Structure Index: Precomputed map of environmental features for AI use.
- Watchdog Engine: Strict rulebook preventing logic drift and code truncation.
- Max-Power Calibration: Casting distance determined by tackle, not timing.
- Hub Mode: Out-of-tournament state. Clock paused. Shops, workshop, leaderboards, sound menu accessible.
- Tournament Mode: In-tournament state. Real-time clock running. Hub locked (D-025).
- Focus Trap: Boot-time live region that captures screen-reader focus for reliable a11y start-up.
- Stat Block (Boat): Multi-axis equipment record (speed, draft, noise, fuel, wind penalty, stability) consumed by poiTravel and castTiming.
- Economy Loop: Tournament winnings → Hub purchases → better stats → better tournament results.
- Weigh-In Early: Player-initiated early end of a tournament run at the dock; clock fast-forwards AI to completion (D-026).
- Procedural Audio: SFX synthesized at runtime via Web Audio API graphs rather than sample playback (D-028).
- Edge Event: `INPUT_<TYPE>_DOWN` / `INPUT_<TYPE>_UP` paired events with tournament-clock timestamps; basis for both tap detection and continuous-hold queries (D-029).
- Tap Event: Logical `INPUT_<TYPE>` event emitted on UP when held < TAP_THRESHOLD_MS (D-029).
- Trap & Trigger: Hookset mechanic — punish input during nibble (Trap), reward `ARROW_UP` within the dynamic HOOKSET_WINDOW after THUD (Trigger) (D-033).
- Tension Event Channels: Split bus channels for fight state (D-035): coalesced continuous, phase edges, threshold edges, terminal.
- Coalesced Emission: Bus event guarded by both a delta gate (Δ>0.02) and a time gate (≤250ms) to keep audio smooth without spamming the bus.
- Phase-Dependent Idle Decay: When fight inputs are absent or mutex-cancelled, tension drifts toward a Running or Tired equilibrium based on fish phase (D-031).
- Pressure / Fished-Out: Per-tile counter incremented by cast / hookset / catch; decays slowly (90s/level). Suppresses finder ranking and strike probability. Forces players to re-scan and reposition (D-039).
- Compute-on-Read: Pattern used by both Spook (D-038) and Pressure (D-039) — stored as `{level, updatedAtMs}`; current value derived from elapsed clock time on each read. Zero per-tick bus traffic; perfectly replay-deterministic.
- Angler's Intuition: Pre-Finder baseline scan; 10 in-game seconds, minimal low-quality candidates (D-042).
- Finder Tier: BASIC → MID → PRO → ELITE; tied to boat upgrades. Higher tier reveals more fields AND scans faster (D-042).
- Presence Hint: Categorical fish-presence indicator returned by PRO+ finders. Enum: NONE, TRACE, SCATTERED, SCHOOLED. Never exact counts (accessibility safety valve, D-042).
- Target Lock: Menu-driven cast target commit (D-041); replaces the rejected manual cursor model. `TARGET_LOCKED` event is the new Tap-1 anchoring trigger for `castResolver.js`.
- Repositioning Penalty: Fixed 5 in-game minutes deducted from the tournament clock when drift pushes the boat outside `frameRadius` (D-040).

## §11 CURRENT STATUS
- Active task: ALL THREE PHASES OF DATA MODELING COMPLETE. Phase 1 (Water Tile, v1.6), Phase 2 (Equipment/Entity Triangle, v1.7), Tournament & Career (v1.8), and Phase 3 (AI Bot Brains, v1.9) all locked. Next: awaiting explicit `INITIATE PHASE [X]` override to lift NO CODE LOCK and begin implementation.
- Blockers: None. STRICT NO CODE LOCK still active.

## §12 ROADMAP
- [ ] Phase 0: Foundations (eventBus, clock, rng, stateStore, inputAdapter, modeRouter)
- [ ] Phase 0.5: Boot, Focus Trap, Profile (engine boot sequence, profile/, FOCUS_TRAP screen, profileSerializer adapter)
- [ ] Phase 1: World Generation (grid, tileTraits per D-037, lakeGenerator, structureIndex, poiGraph)
- [ ] Phase 2a: POI Fast-Travel (poiTravel, motor outboard cost model, boatController mode routing, equipment/boats.js)
- [ ] Phase 2b: Micro-Drift (microDrift local frame, wind, momentum, stationKeeping, frame-boundary repositioning penalty per D-040)
- [ ] Phase 3: Equipment Baseline (rods, lures, durability, liveBait, fishFinder with tier ladder per D-042, boats with finder-slot)
- [ ] Phase 4a: Casting (castPower, castTiming, castValidator, castResolver, castSpookModel, targetSelector menu-FSM per D-041)
- [ ] Phase 4b: Hookset & Fight (hookset.js with Trap/Trigger windows; tensionModel.js pure math; fight.js orchestrator with `clock.every(60ms)` loop and coalesced FIGHT_TENSION events)
- [ ] Phase 4c: Adapter Edge Upgrade (inputAdapter DOWN/UP edges, isHeld, releaseAll, lockout forced-release per D-029/D-030)
- [ ] Phase 5: Fish & Strikes (species, population, strikeModel, biteTimer, fishStateMachine — Running↔Tired FSM, pressureModel per D-039)
- [ ] Phase 6: AI & Competition (brainBase, primeDirective, tournamentScheduler with D-059 headless equation + D-060 cooldown cadence, six archetype personalities per D-058/D-064, tournament/circuit with D-056 weekly calendar, leaderboard with D-061 SIMULATED_CATCH pre-computed impact, scoring, weekly arms-race tier advance per D-054, win-condition objective switch per D-063)
- [ ] Phase 7: Hub & Economy (hub/*, economy, payout, weighIn, single-currency wallet, auto-save triggers per D-020)
- [ ] Phase 8: Audio Layer (audio/* — audioManager, audioRoutes, ttsQueue, synthGraph implementing D-065 procedural-synth mappings (tension→Hz exponential 220→880Hz, finder ping depth→Hz, pressure→noise, presence→envelope, spook→high-shelf), sfxBank, musicBed; procedural-first per D-028; voices pre-cached at audio boot per H-009)
- [ ] Phase 9: Engine Integration & Replay (engine.js wiring, deterministic replay test, mount/unmount leak test per H-005, weigh-in fast-forward determinism test per H-008)

## §13 OPEN QUESTIONS
- (All initial OQs resolved in brief_version 1.1 via D-008, D-009, D-010.)

## §14 SESSION LOG
- S-INITIAL: Established Accessible Fishing concept. Shifted navigation paradigm to POI Fast-Travel and 8-way Numpad micro-drifting to solve blind exploration cognitive load. Drafted initial brief_version 1.0.
- S-002 (v1.1): Resolved OQ-1/2/3. Expanded §9 to reflect POI paradigm. Restructured §12 Phase 2.
- S-003 (v1.2): Adopted D-013 Continuous Real-Time Clock. Locked Phase 4 cast model (D-014/D-015/D-016). Added D-011/D-012 cast anchoring.
- S-004 (v1.3): SYSTEM OVERRIDE. Purged unauthorized Phase 0 code execution. Enforced STRICT NO CODE lock in directives. Reverted to conceptual design phase.
- S-005 (v1.4): Injected Hub World, Economy Loop, Audio Manager, Profile/Focus Trap. Locked rulings: profile adapter (D-024), Hub lockout during tournament (D-025), Weigh-In Early with deterministic clock fast-forward (D-026), single currency (D-027), procedural Web Audio synthesis as SFX default (D-028), auto-save on Hub mutations + post-tournament (D-020). Confirmed boat tradeoff (D-022) is non-monotonic: rowboats access shallow POIs bass boats cannot. Added D-017–D-023 (mode FSM, hub pause, state partition, audio boundary, boats, focus trap). Added H-005–H-009 (mode leak, save tampering, TTS backpressure, weigh-in determinism, synth latency). Expanded §9 with audio/, profile/, hub/, equipment/boats.js, tournament/payout.js, tournament/weighIn.js, audio/synthGraph.js, core/modeRouter.js. Restructured §12 to add Phase 0.5, Phase 7, Phase 8, Phase 9. NO CODE generated; conceptual design only per v1.3 NO CODE LOCK (still active).
- S-006 (v1.5): Defined Strike, Hookset (Trap & Trigger), and Acoustic Fight mechanics. Locked rulings: hookset key = `ARROW_UP` (D-033), nibble count dynamic per species/environment/mood (D-032), hookset window baseline 750ms shrink-only (D-033), `SLACK_GRACE_MS = 1500` (D-036), phase-dependent idle decay — Running drifts UP, Tired drifts DOWN (D-031), strict mutex on Spacebar+ArrowDown reverts to idle decay (D-031). Added D-029 (input edge model with held-state queries, backward compatible with D-014 taps), D-030 (lockout / mode-change forced release), D-034 (60ms fight tick via clock.every), D-035 (four-channel fight event split with coalesced FIGHT_TENSION), D-036 (snap/slack/landed failure modes). Added H-010 (held-input mode-change leak → releaseAll), H-011 (fight tick cadence sweet spot), H-012 (bite timers must survive weigh-in fast-forward — regression test target). Expanded §9 with casting/hookset.js, casting/tensionModel.js, fish/biteTimer.js, fish/fishStateMachine.js. Restructured Phase 4 into 4a/4b/4c. NO CODE generated; persistent NO CODE LOCK respected.
	- S-007 (v1.6): Phase 1 of 3 data modeling complete. Locked Water Tile schema (D-037) with bottom enum {MUD,SAND,GRAVEL,ROCK} (CLAY/SILT cut), cover enum {NONE,WEEDBED,TIMBER,LILYPADS,DOCK,BRUSHPILE,ROCKPILE,OVERHANG}, v0.1 tag taxonomy, per-POI flow only. Locked Spook math (D-038): MAX_SPOOK=5, decay 12s/level, splash SILENT 0 / NORMAL +1 / LOUD +3. Locked Pressure / Fished-Out math (D-039): MAX_PRESSURE=5, decay 90s/level, CAST/HOOKSET/CATCH each +1, PRESSURE_STRIKE_PENALTY=0.6. Locked POI frame-boundary penalty (D-040) at fixed 5 in-game minutes. MAJOR PIVOT: removed manual cursor traversal of micro-frame; introduced Fish Finder Menu Pivot as core day-one mechanic (D-041) with `casting/targetSelector.js` menu-FSM and `TARGET_LOCKED` as Tap-1 trigger. Locked Finder tier ladder (D-042): Angler's Intuition (no finder, 10s scan), BASIC 6s/cap4, MID 4.5s/cap5, PRO 3.5s/cap6, ELITE 2.5s/cap8; presence hints {NONE,TRACE,SCATTERED,SCHOOLED}; never exact fish counts. Locked Scan mutual exclusion + silent invalidation (D-043). Added H-013 (pressure/spook conflation risk), H-014 (finder↔cast coupling boundary). Expanded §9 with `casting/targetSelector.js` and `fish/pressureModel.js`. Updated §12 phases 1/2b/3/4a/5 to reference new modules and decisions. NO CODE generated; persistent NO CODE LOCK respected.
	- S-008 (v1.7): Phase 2 of 3 data modeling complete. Locked Equipment/Entity Triangle schemas (D-044). Locked 7-step rod power ladder (D-045), 9 lure categories (D-046), 5 fish fight styles (D-047), hand-tuned lure-to-species affinity (D-048), time-decay lure memory (D-049), 300ms hookset window floor (D-050), live bait vigor as consumable (D-051), mismatched lure penalty as accuracy-only (D-052), and per-species diurnal multipliers (D-053). NO CODE generated; STRICT NO CODE LOCK respected.

	- S-009 (v1.8): Tournament & Career model locked. Arms Race AI progression (D-054), infinite repeatable tournaments (D-055), endless calendar with 1-per-week cadence (D-056), and Lake-owned dynamic weather (D-057) are now core. Special events deferred. NO CODE generated; STRICT NO CODE LOCK respected.  - S-010 (v1.9): Phase 3 of 3 data modeling COMPLETE. All AI Bot Brain math and schemas locked. Six personality archetypes confirmed (D-058): GRINDER, TROPHY_HUNTER, OPPORTUNIST, GAMBLER, METHODICAL, RUN_AND_GUN with hand-curated `lureRotation` per bot. Locked headless success equation (D-059) — pure math, no desperation mode, Trophy Hunter trophy rate capped at 12%. Locked bot cooldown cadence (D-060) with 0.70× under-tier penalty. Locked SIMULATED_CATCH event schema (D-061) — `lureId` intentionally omitted to prevent AI tackle reverse-engineering; SIMULATED_TOURNAMENT_SKUNK event approved for zero-fish bots. Locked TTS priority ladder (D-062). Locked win-condition objective switch with mathematically-scaled mismatch penalty (D-063). Locked bot count scaling 5→8 by tier (D-064). Added H-015 (AI sub-stream determinism) and H-016 (leaderboard-before-emit atomic ordering). Updated §11 to reflect ALL THREE PHASES OF DATA MODELING COMPLETE. Updated §12 Phase 6 to reference all new decisions. Engine is fully spec'd and ready for `INITIATE PHASE [X]` override to lift NO CODE LOCK. NO CODE generated; STRICT NO CODE LOCK respected.
  - S-011 (v1.10): Procedural audio math locked (D-065). Tension→Hz: exponential 220Hz (A3) → 880Hz (A5), 2-octave span, continuous ramp (no scale snapping), anti-fatigue duck at t≥0.85, sine→sawtooth timbre blend, slack ambient bed. Finder ping math: single `playFinderPing` entry point; depth→Hz inverse (440 * 2^(-depthM/6)); pressure→noise gain overlay; presence→multi-ping envelope (NONE/TRACE/SCATTERED/SCHOOLED) replacing TTS for that field; spook→high-shelf cut for muffled “far away” perception. TTS short-form runs in parallel via D-021 audio boundary. §12 Phase 8 updated to reference D-065 math. NO CODE generated; STRICT NO CODE LOCK respected.