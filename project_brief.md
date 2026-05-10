brief_version: 1.4

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
- App version: v0.1.0. Brief version: 1.4.
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

## §9 CORE FILES (Proposed Modular Split)
- `src/core/` (eventBus.js, clock.js, rng.js, stateStore.js, inputAdapter.js, modeRouter.js)
- `src/audio/` (audioManager.js, audioRoutes.js, ttsQueue.js, sfxBank.js, synthGraph.js, musicBed.js)
- `src/profile/` (profileStore.js, profileSerializer.js)
- `src/hub/` (hubMenu.js, baitShop.js, tackleShop.js, boatShop.js, workshop.js, leaderboardsView.js, soundMenu.js, economy.js)
- `src/world/` (grid.js, lakeGenerator.js, structureIndex.js, poiGraph.js, tileTraits.js)
- `src/navigation/` (boatController.js, poiTravel.js, microDrift.js, stationKeeping.js, wind.js, motor.js, shallowOverride.js)
- `src/casting/` (castPower.js, castTiming.js, castValidator.js, castResolver.js, castSpookModel.js, fight.js)
- `src/equipment/` (rods.js, lures.js, crafting.js, durability.js, liveBait.js, fishFinder.js, boats.js)
- `src/fish/` (species.js, population.js, strikeModel.js)
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

## §11 CURRENT STATUS
- Active task: Evaluating conceptual mechanics (Lake Size, POIs, Fish Strikes).
- Blockers: Awaiting user design decisions. NO CODE ALLOWED.

## §12 ROADMAP
- [ ] Phase 0: Foundations (eventBus, clock, rng, stateStore, inputAdapter, modeRouter)
- [ ] Phase 0.5: Boot, Focus Trap, Profile (engine boot sequence, profile/, FOCUS_TRAP screen, profileSerializer adapter)
- [ ] Phase 1: World Generation (grid, tileTraits, lakeGenerator, structureIndex, poiGraph)
- [ ] Phase 2a: POI Fast-Travel (poiTravel, motor outboard cost model, boatController mode routing, equipment/boats.js)
- [ ] Phase 2b: Micro-Drift (microDrift local frame, wind, momentum, stationKeeping)
- [ ] Phase 3: Equipment Baseline (rods, lures, durability, liveBait, fishFinder)
- [ ] Phase 4: Casting & Fighting (castPower, castTiming, castValidator, castResolver, castSpookModel, fight)
- [ ] Phase 5: Fish & Strikes (species, population, strikeModel)
- [ ] Phase 6: AI & Competition (brainBase, primeDirective, tournamentScheduler, personalities, tournament/circuit, leaderboard, scoring)
- [ ] Phase 7: Hub & Economy (hub/*, economy, payout, weighIn, single-currency wallet, auto-save triggers per D-020)
- [ ] Phase 8: Audio Layer (audio/* — audioManager, audioRoutes, ttsQueue, synthGraph, sfxBank, musicBed; procedural-first per D-028)
- [ ] Phase 9: Engine Integration & Replay (engine.js wiring, deterministic replay test, mount/unmount leak test per H-005, weigh-in fast-forward determinism test per H-008)

## §13 OPEN QUESTIONS
- (All initial OQs resolved in brief_version 1.1 via D-008, D-009, D-010.)

## §14 SESSION LOG
- S-INITIAL: Established Accessible Fishing concept. Shifted navigation paradigm to POI Fast-Travel and 8-way Numpad micro-drifting to solve blind exploration cognitive load. Drafted initial brief_version 1.0.
- S-002 (v1.1): Resolved OQ-1/2/3. Expanded §9 to reflect POI paradigm. Restructured §12 Phase 2.
- S-003 (v1.2): Adopted D-013 Continuous Real-Time Clock. Locked Phase 4 cast model (D-014/D-015/D-016). Added D-011/D-012 cast anchoring.
- S-004 (v1.3): SYSTEM OVERRIDE. Purged unauthorized Phase 0 code execution. Enforced STRICT NO CODE lock in directives. Reverted to conceptual design phase.
- S-005 (v1.4): Injected Hub World, Economy Loop, Audio Manager, Profile/Focus Trap. Locked rulings: profile adapter (D-024), Hub lockout during tournament (D-025), Weigh-In Early with deterministic clock fast-forward (D-026), single currency (D-027), procedural Web Audio synthesis as SFX default (D-028), auto-save on Hub mutations + post-tournament (D-020). Confirmed boat tradeoff (D-022) is non-monotonic: rowboats access shallow POIs bass boats cannot. Added D-017–D-023 (mode FSM, hub pause, state partition, audio boundary, boats, focus trap). Added H-005–H-009 (mode leak, save tampering, TTS backpressure, weigh-in determinism, synth latency). Expanded §9 with audio/, profile/, hub/, equipment/boats.js, tournament/payout.js, tournament/weighIn.js, audio/synthGraph.js, core/modeRouter.js. Restructured §12 to add Phase 0.5, Phase 7, Phase 8, Phase 9. NO CODE generated; conceptual design only per v1.3 NO CODE LOCK (still active).