/**
 * Doctor health contribution registry — global runtime registry
 * mirroring the pinch + policy-substrate pattern. Plugin authors
 * register contributions at module-init time; doctor flows
 * discover via `listDoctorHealthContributions()`.
 *
 * **The plugin-shape pattern**: every openclaw plugin that ships
 * rules / fixers / trackers / generators uses the same shape:
 *   1. Define your spec (here: `DoctorHealthContribution` —
 *      typically built via `ocPathFixerContribution(spec)`)
 *   2. Top-level `register*(spec)` call in your module
 *   3. Consumer imports your module → registration fires
 *   4. Doctor flow discovers via `list*()`
 *
 * @module @openclaw/oc-doctor/registry
 */

import type { DoctorHealthContribution } from './types.js';

const REGISTRY = new Map<string, DoctorHealthContribution>();

/**
 * Register a doctor health contribution. Call at module-init time
 * so the doctor flow sees it before dispatch. Re-registering the
 * same id replaces the previous spec (last-writer-wins; useful
 * for tests and operator-controlled overrides).
 */
export function registerDoctorHealthContribution(
  contribution: DoctorHealthContribution,
): void {
  REGISTRY.set(contribution.id, contribution);
}

/**
 * Look up a registered contribution by id. Returns `null` if not
 * registered.
 */
export function getDoctorHealthContribution(
  id: string,
): DoctorHealthContribution | null {
  return REGISTRY.get(id) ?? null;
}

/**
 * Enumerate all registered contributions. Used by hosts that want
 * to surface available fixers to operators (e.g., `openclaw doctor
 * --list`) and by the doctor flow itself.
 */
export function listDoctorHealthContributions(): readonly DoctorHealthContribution[] {
  return [...REGISTRY.values()];
}

/**
 * Test helper: clear the registry. NOT exported from the package
 * barrel; tests import from this module directly.
 */
export function _clearDoctorHealthContributionRegistry(): void {
  REGISTRY.clear();
}
