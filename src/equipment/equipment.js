/**
 * AFish Equipment — src/equipment/equipment.js
 *
 * Phase 4 — full implementation.
 *
 * Public API Contract (§9 — EQUIPMENT):
 *   getRod(id)              → frozen rod definition from catalog
 *   getLure(id)             → frozen lure definition from catalog
 *   getBait(id)             → frozen bait definition from catalog
 *   damageItem(id, kind)    → dispatches durability/vigor mutation (always writable per H-017)
 *   vigor(baitId)           → current vigor [0,100] for a live-bait instance
 *   addToLoadout(slot, id)  → adds item to hub.activeTackle (blocked in TOURNAMENT_ACTIVE)
 *   removeFromLoadout(slot, id) → removes item (blocked in TOURNAMENT_ACTIVE)
 *   setActiveTackle(plan)   → replaces full activeTackle (TOURNAMENT_BRIEFING or HUB only)
 *   getActiveTackle()       → reads activeTackle from appropriate state partition
 *   validateLoadout()       → { valid, overRods, overLures } for current activeTackle vs boat
 *   ALL_ROD_IDS             → readonly array
 *   ALL_LURE_IDS            → readonly array
 *   ALL_BAIT_IDS            → readonly array
 *
 * Decisions implemented:
 *   D-044 — Rod / Lure / (Fish*) schema triangle. *Fish schema lives in fishBehavior.js.
 *   D-045 — Rod Power Ladder (LOCKED): UL, L, ML, M, MH, H, XH. All 7 present.
 *   D-046 — Lure Categories (LOCKED): CRANKBAIT, JIG, WORM, SPINNERBAIT, TOPWATER,
 *            JERKBAIT, SPOON, SWIMBAIT, LIVE_BAIT. All 9 present.
 *   D-047 — Fish Fight Styles: BULLDOG, RUNNER, JUMPER, DIVER, THRASHER (in fishBehavior).
 *   D-048 — Species Affinity: hand-tuned per lure (NOT category × species matrix).
 *   D-051 — Live Bait Vigor: degrades per cast, per nibble, per hookset; stored in state.
 *   D-067 — activeTackle loadout: bounded by boat.maxRods / boat.maxLures.
 *   D-068 — Crafting: deferred to v2.0. No crafting logic or exports.
 *   D-069 — Loadout Rigging Mode Anchor: rigging surface is tournament.js's job;
 *            equipment.js enforces the H-017 write boundary at the API level.
 *   H-017 — Active Tackle Mutation Boundary:
 *            (a) Set-membership (add/remove entries) → BLOCKED in TOURNAMENT_ACTIVE.
 *            (b) Per-item state (durability, vigor)  → ALWAYS writable.
 *            Both directions enforced explicitly in this module.
 *
 * Schema definitions are frozen catalog objects (read-only blueprints).
 * Mutable per-item state (durability, vigor) lives exclusively in stateStore.
 * All mutations go through stateStore.dispatch — no direct property writes.
 *
 * Reducers registered here:
 *   ITEM_DURABILITY_CHANGED  { itemId, itemType, newDurability }
 *   BAIT_VIGOR_CHANGED       { baitId, newVigor }
 *   LOADOUT_ADD              { slotType, itemId }   ('rods' | 'lures' | 'bait')
 *   LOADOUT_REMOVE           { slotType, itemId }
 *   ACTIVE_TACKLE_SET        { activeTackle }       (from tournament.js on TOURNAMENT_ENTERED)
 *   INVENTORY_ITEM_ACQUIRED  { itemType, itemId, count? }
 */

import * as stateStore from '../core/stateStore.js';
import * as boats      from './boats.js';

// ============================================================================
// ROD CATALOG (D-044, D-045)
// ============================================================================
//
// Power ladder (D-045, LOCKED): UL < L < ML < M < MH < H < XH (7 steps, no reduction)
// Action values: SLOW | MEDIUM | FAST | XFAST
//
// Schema fields:
//   id, class, lengthIn, tier, power, action,
//   lureWeightRangeOz { min, max, sweet },
//   maxLineTension,       — unitless [0..30]; scales fight tension math
//   compliance,           — [0,1]; 1 = most flexible tip (UL); 0 = stiffest (XH)
//   hooksetSensitivity,   — [0,1]; higher = easier to detect and land hooksets
//   durability,           — initial durability [0,1]; runtime state tracks changes
//   audio { swishToken, strainToken, snapToken }
//
// NOTE: `durability` on catalog entries is the INITIAL / max value.
//       Runtime durability is tracked per-item in stateStore.

/** @type {Readonly<Record<string, Readonly<object>>>} */
const ROD_CATALOG = Object.freeze({

  ROD_ULTRALIGHT_FINESSE: Object.freeze({
    id:     'ROD_ULTRALIGHT_FINESSE',
    class:  'SPINNING',
    label:  'Ultralight Finesse Rod',
    lengthIn: 66,   // 5'6"
    tier:   1,
    power:  'UL',
    action: 'SLOW',
    lureWeightRangeOz: Object.freeze({ min: 0.03, max: 0.25, sweet: 0.10 }),
    maxLineTension:    4,
    compliance:        0.92,
    hooksetSensitivity: 0.55,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_LIGHT',
      strainToken: 'ROD_STRAIN_LIGHT',
      snapToken:   'ROD_SNAP',
    }),
  }),

  ROD_LIGHT_SPINNING: Object.freeze({
    id:     'ROD_LIGHT_SPINNING',
    class:  'SPINNING',
    label:  'Light Spinning Rod',
    lengthIn: 72,   // 6'0"
    tier:   1,
    power:  'L',
    action: 'MEDIUM',
    lureWeightRangeOz: Object.freeze({ min: 0.06, max: 0.50, sweet: 0.20 }),
    maxLineTension:    7,
    compliance:        0.80,
    hooksetSensitivity: 0.62,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_LIGHT',
      strainToken: 'ROD_STRAIN_LIGHT',
      snapToken:   'ROD_SNAP',
    }),
  }),

  ROD_ML_SPINNING: Object.freeze({
    id:     'ROD_ML_SPINNING',
    class:  'SPINNING',
    label:  'Medium-Light Spinning Rod',
    lengthIn: 78,   // 6'6"
    tier:   2,
    power:  'ML',
    action: 'MEDIUM',
    lureWeightRangeOz: Object.freeze({ min: 0.12, max: 0.75, sweet: 0.375 }),
    maxLineTension:    10,
    compliance:        0.68,
    hooksetSensitivity: 0.70,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_MEDIUM',
      strainToken: 'ROD_STRAIN_MEDIUM',
      snapToken:   'ROD_SNAP',
    }),
  }),

  ROD_MEDIUM_SPINNING: Object.freeze({
    id:     'ROD_MEDIUM_SPINNING',
    class:  'SPINNING',
    label:  'Medium Spinning Rod',
    lengthIn: 78,   // 6'6"
    tier:   2,
    power:  'M',
    action: 'FAST',
    lureWeightRangeOz: Object.freeze({ min: 0.25, max: 1.00, sweet: 0.50 }),
    maxLineTension:    13,
    compliance:        0.55,
    hooksetSensitivity: 0.75,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_MEDIUM',
      strainToken: 'ROD_STRAIN_MEDIUM',
      snapToken:   'ROD_SNAP',
    }),
  }),

  ROD_MH_CASTING: Object.freeze({
    id:     'ROD_MH_CASTING',
    class:  'CASTING',
    label:  'Medium-Heavy Casting Rod',
    lengthIn: 84,   // 7'0"
    tier:   3,
    power:  'MH',
    action: 'FAST',
    lureWeightRangeOz: Object.freeze({ min: 0.50, max: 1.50, sweet: 0.75 }),
    maxLineTension:    18,
    compliance:        0.42,
    hooksetSensitivity: 0.82,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_HEAVY',
      strainToken: 'ROD_STRAIN_HEAVY',
      snapToken:   'ROD_SNAP',
    }),
  }),

  ROD_HEAVY_CASTING: Object.freeze({
    id:     'ROD_HEAVY_CASTING',
    class:  'CASTING',
    label:  'Heavy Casting Rod',
    lengthIn: 84,   // 7'0"
    tier:   3,
    power:  'H',
    action: 'XFAST',
    lureWeightRangeOz: Object.freeze({ min: 0.75, max: 2.50, sweet: 1.25 }),
    maxLineTension:    23,
    compliance:        0.28,
    hooksetSensitivity: 0.88,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_HEAVY',
      strainToken: 'ROD_STRAIN_HEAVY',
      snapToken:   'ROD_SNAP',
    }),
  }),

  ROD_FLIPPER_XH: Object.freeze({
    id:     'ROD_FLIPPER_XH',
    class:  'FLIPPING',
    label:  'Extra-Heavy Flipping Stick',
    lengthIn: 90,   // 7'6"
    tier:   4,
    power:  'XH',
    action: 'XFAST',
    lureWeightRangeOz: Object.freeze({ min: 1.00, max: 3.50, sweet: 2.00 }),
    maxLineTension:    30,
    compliance:        0.15,
    hooksetSensitivity: 0.95,
    durability:        1.0,
    audio: Object.freeze({
      swishToken:  'ROD_SWISH_HEAVY',
      strainToken: 'ROD_STRAIN_HEAVY',
      snapToken:   'ROD_SNAP',
    }),
  }),

});

// ============================================================================
// LURE CATALOG (D-044, D-046, D-048)
// ============================================================================
//
// All 9 categories present (D-046, LOCKED):
//   CRANKBAIT, JIG, WORM, SPINNERBAIT, TOPWATER, JERKBAIT, SPOON, SWIMBAIT, LIVE_BAIT
//
// Schema fields (D-044):
//   id, category, label, tier, weightOz, profile,
//   presentation { runDepthM, actionType, retrieveStyles[], noiseProfile },
//   snagRiskModifier,    — [0,1]; 0 = snag-free; 1 = high snag risk
//   presentationProfile, — 'REACTION' | 'FINESSE' | 'NATURAL' | 'AGGRESSIVE'
//   sizeProfile,         — 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'MAGNUM'
//   colorClass,          — 'NATURAL' | 'BRIGHT' | 'DARK' | 'METALLIC' | 'TRANSPARENT'
//   speciesAffinity,     — { [speciesId]: number [0,1] } (D-048: hand-tuned; 0.5 = neutral)
//   durability,          — initial durability [0,1]
//   audio { splashToken, retrieveToken, strikeToken }

/** @type {Readonly<Record<string, Readonly<object>>>} */
const LURE_CATALOG = Object.freeze({

  // ---- CRANKBAIT ----

  LURE_SHALLOW_CRANK: Object.freeze({
    id:       'LURE_SHALLOW_CRANK',
    category: 'CRANKBAIT',
    label:    'Shallow Crankbait',
    tier:     1,
    weightOz: 0.50,
    profile:  'LIPLESS_SQUARE',
    presentation: Object.freeze({
      runDepthM:      0.80,
      actionType:     'CRANKBAIT_WOBBLE',
      retrieveStyles: Object.freeze(['STEADY', 'STOP_AND_GO']),
      noiseProfile:   'MODERATE',
    }),
    snagRiskModifier:    0.30,
    presentationProfile: 'REACTION',
    sizeProfile:         'MEDIUM',
    colorClass:          'BRIGHT',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.80,
      SMALLMOUTH_BASS: 0.65,
      SPOTTED_BASS:    0.70,
      BLUEGILL:        0.20,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_WOBBLE',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  LURE_DEEP_DIVER: Object.freeze({
    id:       'LURE_DEEP_DIVER',
    category: 'CRANKBAIT',
    label:    'Deep-Diving Crankbait',
    tier:     2,
    weightOz: 0.75,
    profile:  'DEEP_BILL',
    presentation: Object.freeze({
      runDepthM:      4.50,
      actionType:     'CRANKBAIT_WOBBLE',
      retrieveStyles: Object.freeze(['STEADY', 'PAUSE_AND_BURN']),
      noiseProfile:   'LOUD',
    }),
    snagRiskModifier:    0.50,
    presentationProfile: 'REACTION',
    sizeProfile:         'MEDIUM',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.70,
      SMALLMOUTH_BASS: 0.80,
      SPOTTED_BASS:    0.75,
      RAINBOW_TROUT:   0.45,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_WOBBLE',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  // ---- JIG ----

  LURE_SWIM_JIG: Object.freeze({
    id:       'LURE_SWIM_JIG',
    category: 'JIG',
    label:    'Swim Jig',
    tier:     1,
    weightOz: 0.375,
    profile:  'SWIM_HEAD',
    presentation: Object.freeze({
      runDepthM:      1.00,
      actionType:     'JIG_SWIM',
      retrieveStyles: Object.freeze(['STEADY', 'LIFT_AND_FALL']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.20,
    presentationProfile: 'NATURAL',
    sizeProfile:         'MEDIUM',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.85,
      SMALLMOUTH_BASS: 0.60,
      SPOTTED_BASS:    0.75,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_MEDIUM',
    }),
  }),

  LURE_FOOTBALL_JIG: Object.freeze({
    id:       'LURE_FOOTBALL_JIG',
    category: 'JIG',
    label:    'Football Jig',
    tier:     2,
    weightOz: 0.75,
    profile:  'FOOTBALL_HEAD',
    presentation: Object.freeze({
      runDepthM:      4.00,
      actionType:     'JIG_HOP',
      retrieveStyles: Object.freeze(['DRAG', 'LIFT_AND_DROP']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.35,
    presentationProfile: 'NATURAL',
    sizeProfile:         'LARGE',
    colorClass:          'DARK',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.90,
      SMALLMOUTH_BASS: 0.85,
      SPOTTED_BASS:    0.80,
      CATFISH:         0.50,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  // ---- WORM ----

  LURE_PLASTIC_WORM_6IN: Object.freeze({
    id:       'LURE_PLASTIC_WORM_6IN',
    category: 'WORM',
    label:    '6-Inch Plastic Worm',
    tier:     1,
    weightOz: 0.20,
    profile:  'STRAIGHT_TAIL',
    presentation: Object.freeze({
      runDepthM:      1.50,
      actionType:     'WORM_DRAG',
      retrieveStyles: Object.freeze(['DRAG', 'SHAKE', 'DEAD_STICK']),
      noiseProfile:   'SILENT',
    }),
    snagRiskModifier:    0.15,
    presentationProfile: 'FINESSE',
    sizeProfile:         'SMALL',
    colorClass:          'DARK',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.85,
      SMALLMOUTH_BASS: 0.70,
      SPOTTED_BASS:    0.75,
      BLUEGILL:        0.30,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_SOFT',
    }),
  }),

  LURE_CREATURE_BAIT: Object.freeze({
    id:       'LURE_CREATURE_BAIT',
    category: 'WORM',
    label:    'Creature Bait',
    tier:     2,
    weightOz: 0.35,
    profile:  'CLAW_TAIL',
    presentation: Object.freeze({
      runDepthM:      2.00,
      actionType:     'WORM_DRAG',
      retrieveStyles: Object.freeze(['DRAG', 'LIFT_AND_FALL', 'DEAD_STICK']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.20,
    presentationProfile: 'NATURAL',
    sizeProfile:         'MEDIUM',
    colorClass:          'DARK',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.90,
      SMALLMOUTH_BASS: 0.65,
      SPOTTED_BASS:    0.70,
      CATFISH:         0.55,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_MEDIUM',
    }),
  }),

  // ---- SPINNERBAIT ----

  LURE_WILLOW_SPINNER: Object.freeze({
    id:       'LURE_WILLOW_SPINNER',
    category: 'SPINNERBAIT',
    label:    'Willow Leaf Spinnerbait',
    tier:     1,
    weightOz: 0.50,
    profile:  'DOUBLE_WILLOW',
    presentation: Object.freeze({
      runDepthM:      1.20,
      actionType:     'SPINNER_RETRIEVE',
      retrieveStyles: Object.freeze(['STEADY', 'SLOW_ROLL']),
      noiseProfile:   'MODERATE',
    }),
    snagRiskModifier:    0.10,   // spinnerbait is mostly snag-resistant
    presentationProfile: 'REACTION',
    sizeProfile:         'MEDIUM',
    colorClass:          'METALLIC',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.80,
      SMALLMOUTH_BASS: 0.60,
      SPOTTED_BASS:    0.70,
      RAINBOW_TROUT:   0.35,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SPINNER',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  LURE_COLORADO_SPINNER: Object.freeze({
    id:       'LURE_COLORADO_SPINNER',
    category: 'SPINNERBAIT',
    label:    'Colorado Blade Spinnerbait',
    tier:     2,
    weightOz: 0.75,
    profile:  'SINGLE_COLORADO',
    presentation: Object.freeze({
      runDepthM:      2.00,
      actionType:     'SPINNER_RETRIEVE',
      retrieveStyles: Object.freeze(['SLOW_ROLL', 'LIFT_AND_FALL']),
      noiseProfile:   'LOUD',
    }),
    snagRiskModifier:    0.10,
    presentationProfile: 'AGGRESSIVE',
    sizeProfile:         'LARGE',
    colorClass:          'METALLIC',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.75,
      SMALLMOUTH_BASS: 0.55,
      SPOTTED_BASS:    0.65,
      CATFISH:         0.40,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_SPINNER',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  // ---- TOPWATER ----

  LURE_PENCIL_POPPER: Object.freeze({
    id:       'LURE_PENCIL_POPPER',
    category: 'TOPWATER',
    label:    'Pencil Popper',
    tier:     1,
    weightOz: 0.50,
    profile:  'STICK_BAIT',
    presentation: Object.freeze({
      runDepthM:      0.0,   // surface lure
      actionType:     'WALK_THE_DOG',
      retrieveStyles: Object.freeze(['TWITCH', 'WALK_THE_DOG']),
      noiseProfile:   'MODERATE',
    }),
    snagRiskModifier:    0.15,
    presentationProfile: 'AGGRESSIVE',
    sizeProfile:         'MEDIUM',
    colorClass:          'BRIGHT',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.85,
      SMALLMOUTH_BASS: 0.70,
      SPOTTED_BASS:    0.75,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_TOPWATER',
      retrieveToken: 'LURE_RETRIEVE_TOPWATER',
      strikeToken:   'LURE_STRIKE_TOPWATER',
    }),
  }),

  LURE_WALKING_FROG: Object.freeze({
    id:       'LURE_WALKING_FROG',
    category: 'TOPWATER',
    label:    'Hollow-Body Frog',
    tier:     2,
    weightOz: 0.625,
    profile:  'HOLLOW_BODY',
    presentation: Object.freeze({
      runDepthM:      0.0,
      actionType:     'FROG_WALK',
      retrieveStyles: Object.freeze(['WALK_THE_DOG', 'PAUSE']),
      noiseProfile:   'SUBTLE',   // silent approach over pads
    }),
    snagRiskModifier:    0.05,   // weedless by design
    presentationProfile: 'NATURAL',
    sizeProfile:         'MEDIUM',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.92,   // top pick in heavy cover
      SMALLMOUTH_BASS: 0.40,
      SPOTTED_BASS:    0.60,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_TOPWATER',
      retrieveToken: 'LURE_RETRIEVE_TOPWATER',
      strikeToken:   'LURE_STRIKE_TOPWATER',
    }),
  }),

  // ---- JERKBAIT ----

  LURE_SUSPENDING_JERKBAIT: Object.freeze({
    id:       'LURE_SUSPENDING_JERKBAIT',
    category: 'JERKBAIT',
    label:    'Suspending Jerkbait',
    tier:     1,
    weightOz: 0.50,
    profile:  'MINNOW',
    presentation: Object.freeze({
      runDepthM:      1.50,
      actionType:     'JERK_AND_PAUSE',
      retrieveStyles: Object.freeze(['TWITCH', 'STOP_AND_GO', 'DEAD_STICK']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.25,
    presentationProfile: 'REACTION',
    sizeProfile:         'SMALL',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.70,
      SMALLMOUTH_BASS: 0.88,   // smallmouth loves suspending jerkbaits
      SPOTTED_BASS:    0.75,
      RAINBOW_TROUT:   0.60,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_TWITCH',
      strikeToken:   'LURE_STRIKE_MEDIUM',
    }),
  }),

  LURE_GLIDE_BAIT: Object.freeze({
    id:       'LURE_GLIDE_BAIT',
    category: 'JERKBAIT',
    label:    'Glide Bait',
    tier:     3,
    weightOz: 1.00,
    profile:  'GLIDER',
    presentation: Object.freeze({
      runDepthM:      0.50,
      actionType:     'JERK_AND_PAUSE',
      retrieveStyles: Object.freeze(['SLOW_GLIDE', 'TWITCH', 'FIGURE_EIGHT']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.20,
    presentationProfile: 'REACTION',
    sizeProfile:         'LARGE',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.75,
      SMALLMOUTH_BASS: 0.80,
      SPOTTED_BASS:    0.70,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_TWITCH',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  // ---- SPOON ----

  LURE_CASTING_SPOON: Object.freeze({
    id:       'LURE_CASTING_SPOON',
    category: 'SPOON',
    label:    'Casting Spoon',
    tier:     1,
    weightOz: 0.625,
    profile:  'TRADITIONAL_SPOON',
    presentation: Object.freeze({
      runDepthM:      1.00,
      actionType:     'SPOON_FLUTTER',
      retrieveStyles: Object.freeze(['STEADY', 'LIFT_AND_FALL']),
      noiseProfile:   'MODERATE',
    }),
    snagRiskModifier:    0.30,
    presentationProfile: 'REACTION',
    sizeProfile:         'MEDIUM',
    colorClass:          'METALLIC',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.65,
      SMALLMOUTH_BASS: 0.75,
      RAINBOW_TROUT:   0.85,
      CATFISH:         0.45,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_SPINNER',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  LURE_FLUTTER_SPOON: Object.freeze({
    id:       'LURE_FLUTTER_SPOON',
    category: 'SPOON',
    label:    'Flutter Spoon',
    tier:     2,
    weightOz: 1.00,
    profile:  'ELONGATED_SPOON',
    presentation: Object.freeze({
      runDepthM:      5.00,
      actionType:     'SPOON_FLUTTER',
      retrieveStyles: Object.freeze(['FREE_FALL', 'LIFT_AND_DROP']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.40,
    presentationProfile: 'NATURAL',
    sizeProfile:         'LARGE',
    colorClass:          'METALLIC',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.60,
      SMALLMOUTH_BASS: 0.80,
      RAINBOW_TROUT:   0.90,
      CATFISH:         0.55,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_MEDIUM',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  // ---- SWIMBAIT ----

  LURE_PADDLE_TAIL: Object.freeze({
    id:       'LURE_PADDLE_TAIL',
    category: 'SWIMBAIT',
    label:    'Paddle-Tail Swimbait',
    tier:     2,
    weightOz: 0.75,
    profile:  'SOFT_PADDLE',
    presentation: Object.freeze({
      runDepthM:      1.00,
      actionType:     'SWIM_STEADY',
      retrieveStyles: Object.freeze(['STEADY', 'SLOW_ROLL']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.15,
    presentationProfile: 'NATURAL',
    sizeProfile:         'MEDIUM',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.85,
      SMALLMOUTH_BASS: 0.75,
      SPOTTED_BASS:    0.80,
      RAINBOW_TROUT:   0.50,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_MEDIUM',
    }),
  }),

  LURE_WAKE_SWIMBAIT: Object.freeze({
    id:       'LURE_WAKE_SWIMBAIT',
    category: 'SWIMBAIT',
    label:    'Wake Swimbait',
    tier:     3,
    weightOz: 1.50,
    profile:  'WAKE_BAIT',
    presentation: Object.freeze({
      runDepthM:      0.30,   // near-surface wake
      actionType:     'WAKE_SWIM',
      retrieveStyles: Object.freeze(['SLOW_ROLL', 'PAUSE']),
      noiseProfile:   'MODERATE',
    }),
    snagRiskModifier:    0.20,
    presentationProfile: 'NATURAL',
    sizeProfile:         'MAGNUM',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.82,   // big profile = big bass
      SMALLMOUTH_BASS: 0.55,
      SPOTTED_BASS:    0.60,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_TOPWATER',
      retrieveToken: 'LURE_RETRIEVE_TOPWATER',
      strikeToken:   'LURE_STRIKE_HARD',
    }),
  }),

  // ---- LIVE_BAIT ----
  // Live bait entries are also in the BAIT catalog below (same id).
  // The LURE side describes the presentation profile; the BAIT side adds vigor fields.
  // damageItem() detects live bait by checking BAIT_CATALOG first.

  LURE_NIGHTCRAWLER: Object.freeze({
    id:       'LURE_NIGHTCRAWLER',
    category: 'LIVE_BAIT',
    label:    'Nightcrawler',
    tier:     1,
    weightOz: 0.10,
    profile:  'WORM',
    presentation: Object.freeze({
      runDepthM:      1.50,
      actionType:     'LIVE_DRIFT',
      retrieveStyles: Object.freeze(['DRIFT', 'SLOW_DRAG']),
      noiseProfile:   'SILENT',
    }),
    snagRiskModifier:    0.10,
    presentationProfile: 'NATURAL',
    sizeProfile:         'SMALL',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.70,
      SMALLMOUTH_BASS: 0.80,
      RAINBOW_TROUT:   0.90,
      BLUEGILL:        0.95,
      CATFISH:         0.85,
      CRAPPIE:         0.75,
    }),
    durability: 1.0,   // vigor is tracked separately in BAIT_CATALOG
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_SOFT',
    }),
  }),

  LURE_MINNOW: Object.freeze({
    id:       'LURE_MINNOW',
    category: 'LIVE_BAIT',
    label:    'Live Minnow',
    tier:     1,
    weightOz: 0.05,
    profile:  'BAITFISH',
    presentation: Object.freeze({
      runDepthM:      1.00,
      actionType:     'LIVE_DRIFT',
      retrieveStyles: Object.freeze(['DRIFT', 'SLOW_RETRIEVE']),
      noiseProfile:   'SUBTLE',
    }),
    snagRiskModifier:    0.05,
    presentationProfile: 'NATURAL',
    sizeProfile:         'MICRO',
    colorClass:          'NATURAL',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.75,
      SMALLMOUTH_BASS: 0.85,
      RAINBOW_TROUT:   0.80,
      BLUEGILL:        0.70,
      CRAPPIE:         0.90,
      CATFISH:         0.65,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_SOFT',
    }),
  }),

  LURE_LEECH: Object.freeze({
    id:       'LURE_LEECH',
    category: 'LIVE_BAIT',
    label:    'Leech',
    tier:     1,
    weightOz: 0.08,
    profile:  'LEECH',
    presentation: Object.freeze({
      runDepthM:      2.00,
      actionType:     'LIVE_DRIFT',
      retrieveStyles: Object.freeze(['DRIFT', 'SLOW_DRAG', 'DEAD_STICK']),
      noiseProfile:   'SILENT',
    }),
    snagRiskModifier:    0.08,
    presentationProfile: 'NATURAL',
    sizeProfile:         'MICRO',
    colorClass:          'DARK',
    speciesAffinity: Object.freeze({
      LARGEMOUTH_BASS: 0.65,
      SMALLMOUTH_BASS: 0.88,   // leech is a smallmouth favourite
      RAINBOW_TROUT:   0.75,
      BLUEGILL:        0.80,
      CRAPPIE:         0.70,
    }),
    durability: 1.0,
    audio: Object.freeze({
      splashToken:   'LURE_SPLASH_SOFT',
      retrieveToken: 'LURE_RETRIEVE_SLOW',
      strikeToken:   'LURE_STRIKE_SOFT',
    }),
  }),

});

// ============================================================================
// BAIT CATALOG (D-044, D-051)
// ============================================================================
//
// Live Bait is a CONSUMABLE with a vigor state [0,100] (D-051).
// Vigor degrades per cast, per nibble, per hookset, and over time.
// When vigor reaches 0 the bait is lost; the slot becomes unusable
// for the rest of the tournament (H-017 broken bait stays in slot).
//
// Vigor decay rates:
//   vigorLossPerCast    — percentage points lost each time bait is cast
//   vigorLossPerNibble  — lost per nibble event during retrieve / soak
//   vigorLossPerHookset — lost per hookset attempt (successful or not)
//   vigorDecayPerMin    — passive time-based loss per in-game minute
//
// The initial vigor for a freshly purchased bait item is 100.
// Runtime vigor is stored in stateStore (hub.inventory.bait or tournament.activeTackle.bait).
//
// Bait IDs deliberately share the prefix with their LURE_CATALOG counterpart so
// damageItem() can detect the bait type by checking BAIT_CATALOG[id] first.

/** @type {Readonly<Record<string, Readonly<object>>>} */
const BAIT_CATALOG = Object.freeze({

  LURE_NIGHTCRAWLER: Object.freeze({
    id:                 'LURE_NIGHTCRAWLER',
    label:              'Nightcrawler',
    initialVigor:       100,
    vigorLossPerCast:   10,
    vigorLossPerNibble: 5,
    vigorLossPerHookset: 12,
    vigorDecayPerMin:   1.5,   // slow passive decay
  }),

  LURE_MINNOW: Object.freeze({
    id:                 'LURE_MINNOW',
    label:              'Live Minnow',
    initialVigor:       100,
    vigorLossPerCast:   8,
    vigorLossPerNibble: 4,
    vigorLossPerHookset: 10,
    vigorDecayPerMin:   2.0,   // minnows fade faster out of the bucket
  }),

  LURE_LEECH: Object.freeze({
    id:                 'LURE_LEECH',
    label:              'Leech',
    initialVigor:       100,
    vigorLossPerCast:   7,
    vigorLossPerNibble: 3,
    vigorLossPerHookset: 9,
    vigorDecayPerMin:   1.0,   // tougher organism; slowest passive decay
  }),

});

// ============================================================================
// Damage amount constants for rods and lures
// (Live bait uses vigorLoss* from BAIT_CATALOG; these apply to rods and lures only)
// ============================================================================

const DURABILITY_LOSS = Object.freeze({
  rod: Object.freeze({
    cast:    0.005,  // rods are durable; normal casting wear is negligible
    catch:   0.020,  // landing a fish stresses the blank
    snag:    0.010,  // snagged, pulled free
  }),
  lure: Object.freeze({
    cast:    0.003,  // minor finish wear per cast
    catch:   0.030,  // treble hooks bend; body dings on teeth
    snag:    0.080,  // dragging through cover is the main lure killer
  }),
});

// ============================================================================
// Derived lookup maps
// ============================================================================

/** @type {ReadonlyArray<string>} */
export const ALL_ROD_IDS  = Object.freeze(Object.keys(ROD_CATALOG));
/** @type {ReadonlyArray<string>} */
export const ALL_LURE_IDS = Object.freeze(Object.keys(LURE_CATALOG));
/** @type {ReadonlyArray<string>} */
export const ALL_BAIT_IDS = Object.freeze(Object.keys(BAIT_CATALOG));

// ============================================================================
// State reducers
// ============================================================================

/**
 * ITEM_DURABILITY_CHANGED — updates rod or lure durability in the correct partition.
 *
 * Payload: { itemId: string, itemType: 'rod'|'lure', newDurability: number }
 *
 * H-017 (b): durability writes are ALWAYS accepted regardless of mode —
 * this reducer unconditionally applies the change to whichever partition is live.
 */
stateStore.registerReducer('ITEM_DURABILITY_CHANGED', (state, { itemId, itemType, newDurability }) => {
  const listKey = itemType === 'rod' ? 'rods' : 'lures';
  const updateList = list =>
    list.map(item => item.id === itemId ? { ...item, durability: newDurability } : item);

  if (state.mode === 'TOURNAMENT_ACTIVE') {
    if (!state.tournament.activeTackle) return state;
    return {
      ...state,
      tournament: {
        ...state.tournament,
        activeTackle: {
          ...state.tournament.activeTackle,
          [listKey]: updateList(state.tournament.activeTackle[listKey] ?? []),
        },
      },
    };
  }

  return {
    ...state,
    hub: {
      ...state.hub,
      inventory: {
        ...state.hub.inventory,
        [listKey]: updateList(state.hub.inventory[listKey]),
      },
    },
  };
});

/**
 * BAIT_VIGOR_CHANGED — updates live-bait vigor in the correct partition.
 *
 * Payload: { baitId: string, newVigor: number }
 *
 * H-017 (b): vigor writes are ALWAYS accepted regardless of mode.
 * newVigor is clamped to [0,100] by the reducer (not by the caller).
 */
stateStore.registerReducer('BAIT_VIGOR_CHANGED', (state, { baitId, newVigor }) => {
  const clamped = Math.max(0, Math.min(100, newVigor));
  const updateBait = list =>
    list.map(b => b.id === baitId ? { ...b, vigor: clamped } : b);

  if (state.mode === 'TOURNAMENT_ACTIVE') {
    if (!state.tournament.activeTackle) return state;
    return {
      ...state,
      tournament: {
        ...state.tournament,
        activeTackle: {
          ...state.tournament.activeTackle,
          bait: updateBait(state.tournament.activeTackle.bait ?? []),
        },
      },
    };
  }

  return {
    ...state,
    hub: {
      ...state.hub,
      inventory: {
        ...state.hub.inventory,
        bait: updateBait(state.hub.inventory.bait),
      },
    },
  };
});

/**
 * LOADOUT_ADD — adds one item to hub.activeTackle.
 *
 * Payload: { slotType: 'rods'|'lures'|'bait', itemId: string }
 *
 * H-017 (a): set-membership writes silently rejected during TOURNAMENT_ACTIVE.
 * (The JS API addToLoadout() throws before dispatching; this is a safety net.)
 * Duplicate ids within the same slotType are silently ignored.
 */
stateStore.registerReducer('LOADOUT_ADD', (state, { slotType, itemId }) => {
  if (state.mode === 'TOURNAMENT_ACTIVE') return state; // H-017 safety net

  const existing = state.hub.activeTackle ?? { rods: [], lures: [], bait: [] };
  const list = existing[slotType] ?? [];

  if (list.some(item => item.id === itemId)) return state; // already present

  // Determine initial state for the new item
  let newItem;
  if (slotType === 'bait') {
    const baitDef = BAIT_CATALOG[itemId];
    newItem = { id: itemId, vigor: baitDef ? baitDef.initialVigor : 100, count: 1 };
  } else {
    const itemType = slotType === 'rods' ? 'rod' : 'lure';
    const invList  = state.hub.inventory[slotType] ?? [];
    const invItem  = invList.find(i => i.id === itemId);
    newItem = { id: itemId, durability: invItem?.durability ?? 1.0 };
    void itemType; // itemType used for clarity above; unused in expression
  }

  return {
    ...state,
    hub: {
      ...state.hub,
      activeTackle: {
        ...existing,
        [slotType]: [...list, newItem],
      },
    },
  };
});

/**
 * LOADOUT_REMOVE — removes one item from hub.activeTackle.
 *
 * Payload: { slotType: 'rods'|'lures'|'bait', itemId: string }
 *
 * H-017 (a): set-membership writes silently rejected during TOURNAMENT_ACTIVE.
 */
stateStore.registerReducer('LOADOUT_REMOVE', (state, { slotType, itemId }) => {
  if (state.mode === 'TOURNAMENT_ACTIVE') return state; // H-017 safety net

  const existing = state.hub.activeTackle;
  if (!existing) return state;

  return {
    ...state,
    hub: {
      ...state.hub,
      activeTackle: {
        ...existing,
        [slotType]: (existing[slotType] ?? []).filter(item => item.id !== itemId),
      },
    },
  };
});

/**
 * LOADOUT_REMOVE_ALL — clears hub.activeTackle to an empty loadout.
 *
 * Payload: {} (no payload needed)
 * H-017 (a): silently rejected during TOURNAMENT_ACTIVE.
 * Used by setActiveTackle() before re-populating from a plan.
 */
stateStore.registerReducer('LOADOUT_REMOVE_ALL', (state) => {
  if (state.mode === 'TOURNAMENT_ACTIVE') return state;
  return {
    ...state,
    hub: {
      ...state.hub,
      activeTackle: { rods: [], lures: [], bait: [] },
    },
  };
});

// NOTE: ACTIVE_TACKLE_SET reducer is owned by stateStore.js (writes to hub.activeTackle).
// equipment.js does NOT register a competing ACTIVE_TACKLE_SET.
// Tournament-partition freeze is handled by TOURNAMENT_ENTERED (stateStore.js).

/**
 * INVENTORY_ITEM_ACQUIRED — adds a newly purchased item to hub.inventory.
 *
 * Payload: { itemType: 'rod'|'lure'|'bait', itemId: string, count?: number }
 * Dispatched by hubShops.js (Phase 6+).
 * Ignores the dispatch if itemId is not in a known catalog.
 */
stateStore.registerReducer('INVENTORY_ITEM_ACQUIRED', (state, { itemType, itemId, count = 1 }) => {
  if (itemType === 'rod') {
    if (!ROD_CATALOG[itemId]) return state;
    const exists = state.hub.inventory.rods.some(r => r.id === itemId);
    if (exists) return state; // already owned; shops handle stacking separately
    return {
      ...state,
      hub: {
        ...state.hub,
        inventory: {
          ...state.hub.inventory,
          rods: [...state.hub.inventory.rods, { id: itemId, durability: 1.0 }],
        },
      },
    };
  }

  if (itemType === 'lure') {
    if (!LURE_CATALOG[itemId]) return state;
    const exists = state.hub.inventory.lures.some(l => l.id === itemId);
    if (exists) return state;
    return {
      ...state,
      hub: {
        ...state.hub,
        inventory: {
          ...state.hub.inventory,
          lures: [...state.hub.inventory.lures, { id: itemId, durability: 1.0 }],
        },
      },
    };
  }

  if (itemType === 'bait') {
    if (!BAIT_CATALOG[itemId]) return state;
    const baitDef = BAIT_CATALOG[itemId];
    const existing = state.hub.inventory.bait.find(b => b.id === itemId);
    if (existing) {
      // Stack bait count; vigor is per-unit (simplified: treat as single stack)
      return {
        ...state,
        hub: {
          ...state.hub,
          inventory: {
            ...state.hub.inventory,
            bait: state.hub.inventory.bait.map(b =>
              b.id === itemId ? { ...b, count: b.count + count } : b,
            ),
          },
        },
      };
    }
    return {
      ...state,
      hub: {
        ...state.hub,
        inventory: {
          ...state.hub.inventory,
          bait: [
            ...state.hub.inventory.bait,
            { id: itemId, count, vigor: baitDef.initialVigor },
          ],
        },
      },
    };
  }

  return state;
});

// ============================================================================
// Public API — catalog reads
// ============================================================================

/**
 * Returns the frozen rod definition from the catalog.
 *
 * @param {string} id
 * @returns {Readonly<object>}
 * @throws {Error} if id is not a registered rod.
 */
export function getRod(id) {
  const def = ROD_CATALOG[id];
  if (!def) throw new Error(`equipment.getRod: unknown rod "${id}"`);
  return def;
}

/**
 * Returns the frozen lure definition from the catalog.
 * Live Bait items (category LIVE_BAIT) are also in the lure catalog for
 * presentation/affinity data; see getBait() for vigor management.
 *
 * @param {string} id
 * @returns {Readonly<object>}
 * @throws {Error} if id is not a registered lure.
 */
export function getLure(id) {
  const def = LURE_CATALOG[id];
  if (!def) throw new Error(`equipment.getLure: unknown lure "${id}"`);
  return def;
}

/**
 * Returns the frozen bait definition (vigor decay rates etc.) from the catalog.
 * Only Live Bait items have a bait catalog entry.
 *
 * @param {string} id
 * @returns {Readonly<object>}
 * @throws {Error} if id is not a registered bait item.
 */
export function getBait(id) {
  const def = BAIT_CATALOG[id];
  if (!def) throw new Error(`equipment.getBait: unknown bait "${id}"`);
  return def;
}

// ============================================================================
// Public API — mutable state
// ============================================================================

/**
 * Applies durability or vigor damage to an item in the active state partition.
 *
 * H-017 (b): this function is ALWAYS writable regardless of game mode.
 * It dispatches to stateStore; the reducer targets the correct partition
 * (hub.inventory during HUB/BRIEFING, tournament.activeTackle during TOURNAMENT_ACTIVE).
 *
 * For live bait items the `kind` maps to vigor loss (D-051); for rods and lures
 * it maps to durability loss. Supported `kind` values:
 *   'cast'    — each cast deducts wear
 *   'nibble'  — fish nibble during retrieve/soak (bait only)
 *   'hookset' — hookset attempt (bait loses more than cast; rods/lures minor)
 *   'catch'   — successful catch (stresses rod; dings lure trebles)
 *   'snag'    — lure dragged through structure; major lure damage
 *   'time'    — passive time-based decay (bait only; called by clock.every handler)
 *
 * Durability and vigor floor at 0 (handled by reducer clamp / Math.max).
 * A rod at 0 durability or bait at 0 vigor stays in its slot — NOT auto-replaced (H-017).
 *
 * @param {string} id   — item catalog id
 * @param {string} kind — damage kind (see above)
 */
export function damageItem(id, kind) {
  // Live bait: vigor path
  if (BAIT_CATALOG[id]) {
    _damageVigor(id, kind);
    return;
  }

  // Rod path
  if (ROD_CATALOG[id]) {
    _damageDurability(id, 'rod', kind);
    return;
  }

  // Lure path
  if (LURE_CATALOG[id]) {
    _damageDurability(id, 'lure', kind);
    return;
  }

  throw new Error(`equipment.damageItem: unknown item id "${id}"`);
}

/**
 * Returns the current vigor [0,100] for a live-bait item.
 *
 * Reads from the appropriate state partition based on current mode:
 *   HUB / TOURNAMENT_BRIEFING → hub.inventory.bait
 *   TOURNAMENT_ACTIVE          → tournament.activeTackle.bait
 *
 * Returns 0 for unknown bait ids or missing inventory entries.
 *
 * @param {string} baitId
 * @returns {number} vigor in [0,100]
 */
export function vigor(baitId) {
  const state = stateStore.getState();
  let baitList;

  if (state.mode === 'TOURNAMENT_ACTIVE') {
    baitList = state.tournament.activeTackle?.bait ?? [];
  } else {
    baitList = state.hub.inventory?.bait ?? [];
  }

  const entry = baitList.find(b => b.id === baitId);
  return entry ? entry.vigor : 0;
}

// ============================================================================
// Public API — loadout management (H-017 set-membership boundary)
// ============================================================================

/**
 * Adds an item to hub.activeTackle.
 *
 * H-017 (a): throws if called during TOURNAMENT_ACTIVE.
 * The rigging surface (tournament.js, D-069) must ensure this is only called
 * during HUB or TOURNAMENT_BRIEFING modes.
 *
 * @param {'rods'|'lures'|'bait'} slotType
 * @param {string} itemId
 * @throws {Error} during TOURNAMENT_ACTIVE.
 * @throws {Error} if itemId is not in any catalog.
 */
export function addToLoadout(slotType, itemId) {
  _requireMutableLoadout('addToLoadout');
  if (!ROD_CATALOG[itemId] && !LURE_CATALOG[itemId] && !BAIT_CATALOG[itemId]) {
    throw new Error(`equipment.addToLoadout: unknown item id "${itemId}"`);
  }
  stateStore.dispatch({ type: 'LOADOUT_ADD', payload: { slotType, itemId } });
}

/**
 * Removes an item from hub.activeTackle.
 *
 * H-017 (a): throws if called during TOURNAMENT_ACTIVE.
 *
 * @param {'rods'|'lures'|'bait'} slotType
 * @param {string} itemId
 * @throws {Error} during TOURNAMENT_ACTIVE.
 */
export function removeFromLoadout(slotType, itemId) {
  _requireMutableLoadout('removeFromLoadout');
  stateStore.dispatch({ type: 'LOADOUT_REMOVE', payload: { slotType, itemId } });
}

/**
 * Replaces hub.activeTackle with a complete plan object.
 *
 * H-017 (a): throws if called during TOURNAMENT_ACTIVE.
 * Used by tournament.js TOURNAMENT_BRIEFING rigging surface to set a full
 * loadout at once (e.g., after default-rigging to Rowboat capacity).
 *
 * @param {{ rods: Array, lures: Array, bait: Array }} plan
 * @throws {Error} during TOURNAMENT_ACTIVE.
 */
export function setActiveTackle(plan) {
  _requireMutableLoadout('setActiveTackle');
  // Write the full plan to hub.activeTackle via stateStore's ACTIVE_TACKLE_SET (D-069).
  stateStore.dispatch({ type: 'ACTIVE_TACKLE_SET', payload: { activeTackle: plan } });
}

/**
 * Returns the current activeTackle from the appropriate state partition.
 *
 * @returns {{ rods: Array, lures: Array, bait: Array } | null}
 */
export function getActiveTackle() {
  const state = stateStore.getState();
  if (state.mode === 'TOURNAMENT_ACTIVE') {
    return state.tournament.activeTackle ?? null;
  }
  return state.hub.activeTackle ?? null;
}

/**
 * Validates the current activeTackle against the active boat's maxRods / maxLures (D-067).
 *
 * Called by tournament.js TOURNAMENT_BRIEFING to gate TOURNAMENT_ACTIVE transition (D-069).
 * An empty activeTackle is permitted (warns, not rejected); over-cap is rejected outright.
 *
 * @returns {{ valid: boolean, overRods: number, overLures: number, empty: boolean }}
 */
export function validateLoadout() {
  let boatStats;
  try { boatStats = boats.activeBoatStats(); } catch { boatStats = { maxRods: 2, maxLures: 5 }; }

  const tackle = getActiveTackle() ?? { rods: [], lures: [], bait: [] };
  const rodCount  = tackle.rods?.length  ?? 0;
  const lureCount = tackle.lures?.length ?? 0;

  const overRods  = Math.max(0, rodCount  - boatStats.maxRods);
  const overLures = Math.max(0, lureCount - boatStats.maxLures);

  return {
    valid:     overRods === 0 && overLures === 0,
    overRods,
    overLures,
    empty:     rodCount === 0 && lureCount === 0,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Throws H-017 error if the current mode is TOURNAMENT_ACTIVE.
 * @param {string} caller — function name for the error message
 */
function _requireMutableLoadout(caller) {
  const mode = stateStore.getState().mode;
  if (mode === 'TOURNAMENT_ACTIVE') {
    throw new Error(
      `equipment.${caller}: H-017 violation — activeTackle set-membership is ` +
      `frozen during TOURNAMENT_ACTIVE. Only durability/vigor state writes are permitted.`,
    );
  }
}

/**
 * Computes and dispatches a vigor reduction for a live-bait item (D-051).
 * @param {string} baitId
 * @param {string} kind — 'cast' | 'nibble' | 'hookset' | 'time'
 */
function _damageVigor(baitId, kind) {
  const baitDef = BAIT_CATALOG[baitId];
  if (!baitDef) return;

  let loss = 0;
  switch (kind) {
    case 'cast':    loss = baitDef.vigorLossPerCast;    break;
    case 'nibble':  loss = baitDef.vigorLossPerNibble;  break;
    case 'hookset': loss = baitDef.vigorLossPerHookset; break;
    case 'time':    loss = baitDef.vigorDecayPerMin;    break;
    default:        loss = 0; // unknown kind: no-op
  }

  if (loss <= 0) return;

  const currentVigor = vigor(baitId);
  stateStore.dispatch({ type: 'BAIT_VIGOR_CHANGED', payload: { baitId, newVigor: currentVigor - loss } });
}

/**
 * Computes and dispatches a durability reduction for a rod or lure.
 * @param {string} id
 * @param {'rod'|'lure'} itemType
 * @param {string} kind — 'cast' | 'hookset' | 'catch' | 'snag'
 */
function _damageDurability(id, itemType, kind) {
  const lossTable = DURABILITY_LOSS[itemType];
  if (!lossTable) return;

  const loss = lossTable[kind] ?? 0;
  if (loss <= 0) return;

  // Read current durability from the appropriate partition
  const state = stateStore.getState();
  const listKey = itemType === 'rod' ? 'rods' : 'lures';
  let list;

  if (state.mode === 'TOURNAMENT_ACTIVE') {
    list = state.tournament.activeTackle?.[listKey] ?? [];
  } else {
    list = state.hub.inventory?.[listKey] ?? [];
  }

  const item = list.find(i => i.id === id);
  if (!item) return; // item not in inventory; no-op

  stateStore.dispatch({ type: 'ITEM_DURABILITY_CHANGED', payload: { itemId: id, itemType, newDurability: Math.max(0, item.durability - loss) } });
}
