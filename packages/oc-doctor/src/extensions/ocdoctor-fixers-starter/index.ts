/**
 * `ocdoctor-fixers-starter` — starter-v0 fixer pack.
 *
 * Six starter fixers covering 6/10 lint rules with paired auto-fixes.
 * Two main fix patterns:
 *   1. append-section (agents/add-boundaries-stub,
 *      user/add-preferences-stub, identity/add-trust-level-stub,
 *      tools/add-guidance-table-stub)
 *   2. frontmatter-edit (memory/add-scope-default,
 *      skill/add-required-frontmatter-stub)
 *
 * Each pairs 1:1 with a `starter-v0` lint rule and is additive +
 * idempotent (re-running is no-op). Wraps into `DoctorHealthContribution`
 * via `ocPathFixerContribution` and registers through upstream's
 * existing `registerDoctorHealthContribution` slot — NO new SDK verb
 * introduced.
 *
 * **Convention** (matches paired lint rules): every detect finding in
 * this pack uses `line: 1` as the insertion-point anchor. The new
 * section / frontmatter key is being inserted, so there's no specific
 * line to point at — the file head is the conventional anchor for
 * "missing structure" findings. The fix() body decides where the
 * inserted bytes actually land (e.g., append-stub fixers append at
 * file end regardless of the diagnostic line).
 *
 * The four `starter-v0` rules WITHOUT paired auto-fixers
 * (agents/empty-tools-section, agents/duplicate-tool-key,
 * memory/invalid-scope-value, skill/invalid-tier-value) require human
 * judgment — auto-correction would either guess at user intent or
 * destroy existing content. They stay advisory-only by design.
 *
 * Upstream destination: `openclaw-core/extensions/ocdoctor-fixers-starter/`.
 *
 * @module @openclaw/oc-doctor/fixers-starter
 */

import { ocPathFixerContribution } from '../../plugin-sdk/oc-doctor/adapter.js';
import type {
  DoctorHealthContribution,
  OcPathFixerSpec,
} from '../../plugin-sdk/oc-doctor/types.js';

import { agentsAddBoundariesStub } from './fixers/agents-add-boundaries-stub.js';
import { agentsSeedToolsTodo } from './fixers/agents-seed-tools-todo.js';
import { identityAddTrustLevelStub } from './fixers/identity-add-trust-level-stub.js';
import { memoryAddScopeDefault } from './fixers/memory-add-scope-default.js';
import { memorySnapScope } from './fixers/memory-snap-scope.js';
import { skillAddRequiredFrontmatterStub } from './fixers/skill-add-required-frontmatter-stub.js';
import { skillSnapTier } from './fixers/skill-snap-tier.js';
import { toolsAddGuidanceTableStub } from './fixers/tools-add-guidance-table-stub.js';
import { userAddPreferencesStub } from './fixers/user-add-preferences-stub.js';

export const STARTER_FIXERS_V0: readonly OcPathFixerSpec<unknown>[] = [
  agentsAddBoundariesStub,
  toolsAddGuidanceTableStub,
  memoryAddScopeDefault,
  skillAddRequiredFrontmatterStub,
  identityAddTrustLevelStub,
  userAddPreferencesStub,
];

/**
 * Optional second-tier fixers — each requires a domain decision
 * (placeholder tone, target enum value, etc.) so they ship behind an
 * opt-in. Configurable via `OcPathFixerSpec.defaultOptions`.
 *
 * Operators register these explicitly when they want auto-correction
 * for the lint rules `agents/empty-tools-section`,
 * `memory/invalid-scope-value`, `skill/invalid-tier-value`.
 */
export const STARTER_FIXERS_V0_OPTIONAL: readonly OcPathFixerSpec<unknown>[] = [
  agentsSeedToolsTodo,
  memorySnapScope,
  skillSnapTier,
];

export const STARTER_FIXERS_V0_CONTRIBUTIONS: readonly DoctorHealthContribution[] =
  STARTER_FIXERS_V0.map(ocPathFixerContribution);

// Self-register on import. Mirrors the policy-substrate + pinch
// pattern: importing the starter pack module registers its
// contributions with the global registry. Consumers who want every
// starter fixer available to their CLI / runner just `import
// '@openclaw/oc-doctor/fixers-starter'` and the registration fires
// automatically.
import { registerDoctorHealthContribution } from '../../plugin-sdk/oc-doctor/registry.js';
for (const c of STARTER_FIXERS_V0_CONTRIBUTIONS) {
  registerDoctorHealthContribution(c);
}

/**
 * Register every fixer in `starter-v0` against the host's API.
 *
 *   import { registerStarterFixersV0 } from '@openclaw/ocdoctor-fixers-starter';
 *   registerStarterFixersV0(api.registerDoctorHealthContribution);
 */
export function registerStarterFixersV0(
  register: (contribution: DoctorHealthContribution) => void,
): void {
  for (const c of STARTER_FIXERS_V0_CONTRIBUTIONS) {
    register(c);
  }
}

export {
  agentsAddBoundariesStub,
  agentsSeedToolsTodo,
  identityAddTrustLevelStub,
  memoryAddScopeDefault,
  memorySnapScope,
  skillAddRequiredFrontmatterStub,
  skillSnapTier,
  toolsAddGuidanceTableStub,
  userAddPreferencesStub,
};
