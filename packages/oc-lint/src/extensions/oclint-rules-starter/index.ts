/**
 * `oclint-rules-starter` — starter-v0 starter rule pack.
 *
 * Ten rules at `info` severity drawn from common adversarial
 * authoring patterns. Demonstrates the `oc-lint` framework's value
 * without forcing upstream to ratify any opinion: operators see
 * lint output on `openclaw doctor` runs and can opt out per-rule
 * via host config; severities can graduate as community signal
 * accumulates (precedent: ESLint, Stylelint).
 *
 * Upstream destination: `openclaw-core/extensions/oclint-rules-starter/`.
 *
 * @module @openclaw/oc-lint/rules-starter
 */

import type { LintRule } from '../../plugin-sdk/oc-lint/types.js';
import type { RegisterLintRule } from '../../plugin-sdk/oc-lint/api-extension.js';
import { registerLintRule } from '../../plugin-sdk/oc-lint/registry.js';

import { agentsDuplicateToolKey } from './rules/agents-duplicate-tool-key.js';
import { agentsEmptyToolsSection } from './rules/agents-empty-tools-section.js';
import { agentsMissingBoundaries } from './rules/agents-missing-boundaries.js';
import { identityMissingTrustLevel } from './rules/identity-missing-trust-level.js';
import { memoryInvalidScopeValue } from './rules/memory-invalid-scope-value.js';
import { memoryMissingScope } from './rules/memory-missing-scope.js';
import { skillInvalidTier } from './rules/skill-invalid-tier.js';
import { skillMissingRequiredFrontmatter } from './rules/skill-missing-required-frontmatter.js';
import { toolsEmptyGuidanceTable } from './rules/tools-empty-guidance-table.js';
import { userMissingPreferences } from './rules/user-missing-preferences.js';

/**
 * The full starter-v0 pack as a flat array. Rule packs ship as
 * ordered lists so registration order is deterministic.
 */
export const STARTER_RULES_V0: readonly LintRule[] = [
  agentsEmptyToolsSection,
  agentsMissingBoundaries,
  agentsDuplicateToolKey,
  toolsEmptyGuidanceTable,
  memoryMissingScope,
  memoryInvalidScopeValue,
  skillMissingRequiredFrontmatter,
  skillInvalidTier,
  identityMissingTrustLevel,
  userMissingPreferences,
];

// Self-register on import. Mirrors the policy-substrate pattern:
// importing the starter pack module registers its rules with the
// global registry. Consumers who want every starter rule available
// to their CLI / runner just `import '@openclaw/oc-lint/rules-starter'`
// and the registration fires automatically.
for (const rule of STARTER_RULES_V0) {
  registerLintRule(rule);
}

/**
 * Register every rule in `STARTER_RULES_V0` against the host's API.
 * The host calls this once at extension activation:
 *
 *   import { registerStarterRulesV0 } from '@openclaw/oclint-rules-starter';
 *   registerStarterRulesV0(api.registerLintRule);
 */
export function registerStarterRulesV0(register: RegisterLintRule): void {
  for (const rule of STARTER_RULES_V0) {
    register(rule);
  }
}

// Re-export individual rules for callers that want to register a subset.
export {
  agentsDuplicateToolKey,
  agentsEmptyToolsSection,
  agentsMissingBoundaries,
  identityMissingTrustLevel,
  memoryInvalidScopeValue,
  memoryMissingScope,
  skillInvalidTier,
  skillMissingRequiredFrontmatter,
  toolsEmptyGuidanceTable,
  userMissingPreferences,
};
