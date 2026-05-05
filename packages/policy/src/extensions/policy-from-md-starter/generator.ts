/**
 * `mdPolicyGenerator` — markdown-shaped reference impl of
 * `PolicyGenerator<TValidated>`. Self-registers under id `'md'`
 * when imported.
 *
 * Input shape: `{ files: PolicyExtractFile[] }` — already-parsed
 * workspace files. The CLI / fs-pipeline does the manifest walk
 * + per-kind parse before handing the array here.
 *
 * Output: `PolicyIR` with `policyId` stamped (RFC 8785 JCS hash).
 *
 * @module @openclaw/policy/extensions/policy-from-md-starter/generator
 */

import type { LKGFingerprint } from '@openclaw/lkg';
import type {
  PolicyGenerator,
  PolicyIR,
} from '../../plugin-sdk/policy/types.js';
import {
  buildPolicyIR,
  type PolicyExtractFile,
  type PolicyExtractorSpec,
} from '../../plugin-sdk/policy/index.js';
import { registerPolicyGenerator } from '../../plugin-sdk/policy/registry.js';
import { denyRulesFromSoulMd } from './extractors/deny-rules-from-soul-md.js';
import { toolsFromToolsMd } from './extractors/tools-from-tools-md.js';

const TOOL_EXTRACTORS = [toolsFromToolsMd] as const;
const DENY_RULE_EXTRACTORS = [denyRulesFromSoulMd] as const;

/**
 * Validated input shape this generator consumes — just the parsed
 * files. The CLI walker handles discovery + parsing.
 */
export interface MdGeneratorInput {
  readonly files: readonly PolicyExtractFile[];
}

export const mdPolicyGenerator: PolicyGenerator<MdGeneratorInput> = {
  async generate(content, anchor: LKGFingerprint): Promise<PolicyIR> {
    return buildPolicyIR({
      files: content.files,
      toolExtractors: TOOL_EXTRACTORS as readonly PolicyExtractorSpec<import('../../plugin-sdk/policy/types.js').ToolSpec>[],
      denyRuleExtractors: DENY_RULE_EXTRACTORS as readonly PolicyExtractorSpec<import('../../plugin-sdk/policy/types.js').DenyRule>[],
      anchor,
    });
  },
};

registerPolicyGenerator({
  id: 'md',
  description:
    'Markdown workspace generator — reads canonical openclaw artifacts (SOUL.md, TOOLS.md, etc.) via findOcPaths and composes PolicyIR',
  generator: mdPolicyGenerator,
  requires: { sdkVersion: '0.1.0' },
});
