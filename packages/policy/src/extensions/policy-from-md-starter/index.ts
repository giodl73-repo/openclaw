/**
 * `@openclaw/policy/extractors-starter` — claws-shaped reference
 * generator pack. Each extractor is sourced from a real openclaw
 * canonical artifact (SOUL.md, TOOLS.md, etc.) and uses
 * `findOcPaths` / `resolveOcPath` from oc-path to
 * locate concept-bearing nodes.
 *
 * The starter pack IS the framework's first consumer. Any plugin
 * that wants to extend the policy generator with deployment-
 * specific concepts (e.g., a custom `gateway-policy` artifact)
 * authors its own `PolicyExtractorSpec` and concatenates it with
 * `STARTER_EXTRACTORS_V0`.
 *
 * @module @openclaw/policy/extensions/policy-from-md-starter
 */

import type {
  DenyRule,
  ToolSpec,
} from '../../plugin-sdk/policy/types.js';
import type { PolicyExtractorSpec } from '../../plugin-sdk/policy/api.js';
import { denyRulesFromSoulMd } from './extractors/deny-rules-from-soul-md.js';
import { toolsFromToolsMd } from './extractors/tools-from-tools-md.js';

export { denyRulesFromSoulMd } from './extractors/deny-rules-from-soul-md.js';
export { toolsFromToolsMd } from './extractors/tools-from-tools-md.js';
export { mdPolicyGenerator, type MdGeneratorInput } from './generator.js';

/**
 * Deny-rule extractors. Run with `runExtractors({ specs: STARTER_DENY_RULE_EXTRACTORS_V0, files })`.
 */
export const STARTER_DENY_RULE_EXTRACTORS_V0: readonly PolicyExtractorSpec<DenyRule>[] = [
  denyRulesFromSoulMd,
];

/**
 * Tool-spec extractors. Run with `runExtractors({ specs: STARTER_TOOL_EXTRACTORS_V0, files })`.
 */
export const STARTER_TOOL_EXTRACTORS_V0: readonly PolicyExtractorSpec<ToolSpec>[] = [
  toolsFromToolsMd,
];
