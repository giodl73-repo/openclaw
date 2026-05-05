/**
 * `@openclaw/plugin-sdk/policy` — types contract + extractor framework.
 *
 * Upstream-shaped surface that lands at openclaw/openclaw per
 * `lobster-docs/Tech/OpenClaw/specs/proposals/upstream/policy-anchoring/upstream-pr1-policyir.md`.
 *
 * @module @openclaw/plugin-sdk/policy
 */

export type {
  Decision,
  DenyRule,
  PolicyGenerator,
  PolicyIR,
  RiskLevel,
  Sensitivity,
  ToolSpec,
} from './types.js';
export { POLICY_PATH } from './types.js';

export {
  SDK_VERSION,
  runExtractors,
  type ExtractorResult,
  type PolicyExtractFile,
  type PolicyExtractorContext,
  type PolicyExtractorSpec,
  type RunExtractorsOptions,
} from './api.js';

export {
  canonicalize,
  computePolicyId,
  computePolicyShapeHash,
} from './canonicalize.js';

export {
  POLICY_IR_VERSION,
  buildPolicyIR,
  type BuildPolicyIROptions,
} from './build.js';

export {
  approvalListFor,
  evaluateDecision,
  type ApprovalRequirement,
  type ToolCallInput,
} from './runtime.js';

export {
  getPolicyGenerator,
  listPolicyGenerators,
  registerPolicyGenerator,
  type PolicyGeneratorSpec,
} from './registry.js';

export {
  loadPolicyIRFromFile,
  makePolicyEvaluator,
  mapDecisionToHostShape,
  policyTrustedToolPolicy,
  type PluginToolPolicyDecision,
  type PolicyToolEvent,
  type PolicyTrustedToolPolicyOptions,
  type PolicyTrustedToolRegistration,
} from './adapter.js';

export type { WorkspacePolicyConfig } from './workspace-config.js';
