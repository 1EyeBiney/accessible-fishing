/**
 * AFish UI Manifest Registry — src/ui/index.js
 *
 * Single import point for all UI mount manifests.
 *
 * engine.js calls registerUiManifests() once, during boot (before the first
 * transitionTo call), so every manifest is registered before any mode can
 * attempt to mount a subsystem.
 *
 * Adding a new UI module (Phase 12+):
 *   1. Create src/ui/<module>.js exporting a `*Manifest` object.
 *   2. Import it here and add it to the _UI_MANIFESTS array.
 *   3. No changes to engine.js are required.
 */

import { registerMountManifest } from '../core/modeRouter.js';
import { focusTrapManifest }     from './focusTrap.js';
import { hubManifest }           from './hub.js';

// ---------------------------------------------------------------------------
// Ordered manifest list
// ---------------------------------------------------------------------------

/**
 * All UI manifests, in registration order.
 * modeRouter calls onMount/onUnmount in registration order, so manifests
 * that must be mounted first (e.g. focus / screen-reader layer) are listed
 * before manifests that depend on them.
 *
 * @type {import('../core/modeRouter.js').MountManifest[]}
 */
const _UI_MANIFESTS = [
  focusTrapManifest,
  hubManifest,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all UI manifests with modeRouter.
 *
 * Called once from engine.js boot(), before transitionTo(MODES.FOCUS_TRAP).
 * Idempotent — registerMountManifest replaces an existing manifest with the
 * same id, so calling this function more than once (e.g. in tests) is safe.
 */
export function registerUiManifests() {
  for (const manifest of _UI_MANIFESTS) {
    registerMountManifest(manifest);
  }
}
