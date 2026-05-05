/**
 * `buildPolicyIR` — orchestrate extractor specs over a list of files
 * and compose a `PolicyIR`. Handles `policyId` computation (RFC 8785
 * JCS over the body) and stamps `generatedAt` + `generatedFrom`.
 *
 * This is the spine of the reference markdown generator: workspace
 * files → extractors → typed concepts → composed PolicyIR. Any
 * downstream generator (claws / OPA / CEL / yaml) implements
 * `PolicyGenerator<TValidated>` by calling this helper.
 *
 * @module @openclaw/plugin-sdk/policy/build
 */

import type { LKGFingerprint } from '@openclaw/lkg';
import type {
  DenyRule,
  PolicyIR,
  ToolSpec,
} from './types.js';
import {
  runExtractors,
  type PolicyExtractFile,
  type PolicyExtractorSpec,
} from './api.js';
import { computePolicyId } from './canonicalize.js';

/**
 * Schema version of the PolicyIR shape produced by this builder.
 * Mirrors `SDK_VERSION` for the plugin-sdk surface; the IR's own
 * `version` field is independent so the IR shape can evolve at a
 * different cadence than the SDK API.
 */
export const POLICY_IR_VERSION = '0.1.0';

export interface BuildPolicyIROptions {
  readonly files: readonly PolicyExtractFile[];
  readonly toolExtractors: readonly PolicyExtractorSpec<ToolSpec>[];
  readonly denyRuleExtractors: readonly PolicyExtractorSpec<DenyRule>[];
  /**
   * LKG fingerprint of the input bytes that produced this IR. The
   * gateway's policy plugin uses this to detect TOCTOU between
   * generation and evaluation.
   */
  readonly anchor: LKGFingerprint;
  /** Override "now" for deterministic tests. */
  readonly nowIso?: () => string;
  /** Optional cancellation. Forwarded to the runner. */
  readonly signal?: AbortSignal;
}

/**
 * Build a complete PolicyIR. Tools and deny rules are deduped by
 * `id` (last-writer-wins per spec id, then per rule id). PolicyId is
 * stamped last so it covers the full body.
 */
export function buildPolicyIR(opts: BuildPolicyIROptions): PolicyIR {
  const toolResults = runExtractors({
    specs: opts.toolExtractors,
    files: opts.files,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const denyResults = runExtractors({
    specs: opts.denyRuleExtractors,
    files: opts.files,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  // Dedupe by id: last writer wins. Two extractors emitting the same
  // tool id produces a single entry, with the later spec's value.
  const toolsById = new Map<string, ToolSpec>();
  for (const r of toolResults) toolsById.set(r.value.id, r.value);
  const denyById = new Map<string, DenyRule>();
  for (const r of denyResults) denyById.set(r.value.id, r.value);

  const tools = [...toolsById.values()];
  const denyRules = [...denyById.values()];

  const generatedAt = (opts.nowIso ?? (() => new Date().toISOString()))();
  const body: Omit<PolicyIR, 'policyId'> = {
    version: POLICY_IR_VERSION,
    generatedAt,
    generatedFrom: opts.anchor,
    tools,
    denyRules,
  };
  return {
    ...body,
    policyId: computePolicyId(body),
  };
}
