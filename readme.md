\# Accessible Fishing



\## Overview

An audio-first, headless fishing simulation game designed with deep strategic mechanics, competitive tournaments, and fully accessible navigation. Built on a robust headless state architecture, the game focuses on strategy, equipment management, and dynamic environments rather than visual reflexes.



\## Core Mechanics



\### Environment \& Lake Generation

\* \*\*The Grid:\*\* Lakes are represented as non-rectangular 2D arrays containing `land` and `water` tiles.

\* \*\*Depth \& Structure:\*\* Water tiles feature varied depths, bottom types (mud, rock, gravel), and cover (weeds, submerged timber).

\* \*\*Accessible Spawning:\*\* Lake generation logic ensures that essential environmental traits (e.g., deep drop-offs, rich weed beds) always spawn early and within reachable zones from the starting dock.



\### Boat Navigation \& Accessibility

\* \*\*Wind \& Drift Momentum:\*\* Wind and currents apply constant vectors to the boat. A momentum mechanic dictates that consecutive turns drifting in the same direction increase speed, requiring active management.

\* \*\*Motor Strategy:\*\* Players balance using loud, high-speed outboards to cross the lake against quiet, battery-draining trolling motors to counter drift and hold over hot spots.

\* \*\*Shallow Water Override (Accessibility):\*\* High-speed outboard motors automatically cut off 3 tiles away from land or obstructions, safely preventing the player from running aground.



\### Casting \& Reeling

\* \*\*Max-Power Calibration:\*\* Instead of requiring players to time a rapidly moving meter to hit fractional power (e.g., 80%), distance is controlled by equipment setup (rod flexibility, lure weight) and pre-cast settings. 

\* \*\*The 4-Part Cast:\*\* Players focus on timing the perfect 100% release point for a clean, accurate entry.

\* \*\*Invalid Target Warning:\*\* Attempts to cast directly onto land trigger an auditory warning and block the cast.

\* \*\*The Fight:\*\* A tension-based audio mechanic (e.g., reel click pitch) dictates when to reel in and when to let line out to prevent snapping.



\### Equipment \& Crafting

\* \*\*Fish Finders:\*\* Auditory sonar pings return tones based on depth and secondary chimes for fish detected in the water column.

\* \*\*Lure Crafting \& Decay:\*\* Players can craft lures to hit specific stat blocks (Depth, Vibration, Profile). Crafted lures suffer durability decay from strikes and snags, while live bait perishes over time, adding inventory management.



\### Tournaments \& AI Competitors

\* \*\*Competitive Play:\*\* The core gameplay loop involves competitive tournament circuits against a leaderboard of simulated anglers.

\* \*\*AI Brain Mode:\*\* Computer-controlled opponents utilize a default "brain mode" guided by a prime directive (e.g., targeting specific structures at different times of day based on shifting conditions).

\* \*\*Notable Opponents:\*\* Players will face off against distinct AI personalities and aggressive top-tier pros, including Bill the Legend.

