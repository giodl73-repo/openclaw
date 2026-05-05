/**
 * Runtime helpers consumed by guardrails: produce the approval list
 * from a PolicyIR, and evaluate a single tool call against the IR.
 *
 * Strategic frame: the guardrail closes over a loaded PolicyIR (via
 * the upstream `registerTrustedToolPolicy` slot) and converts each
 * incoming tool call into a `Decision`. This module is the policy-
 * substrate-side helper that does the actual logic — guardrail
 * adapters compose it with the host's Decision wire format.
 *
 * Decision rules implemented here (v0):
 *
 *   1. **Deny** — any matching DenyRule fires (`when.tool === id`,
 *      `when.capability ∈ tool.capabilities`, or `when.tag` substring
 *      against tool id / call args). First match wins, and `reason`
 *      threads through.
 *   2. **Requires-approval** — the tool's `risk` is `'critical'`,
 *      OR its capabilities include `IRREVERSIBLE_EXTERNAL`.
 *   3. **Allow** — otherwise.
 *
 * The `params` decision shape (substrate-mutated args) is reserved
 * for fixers like `redact-secret-literal` and isn't produced by this
 * v0 evaluator; it's a forward-compatibility slot.
 *
 * @module @openclaw/plugin-sdk/policy/runtime
 */

import type {
  Decision,
  DenyRule,
  PolicyIR,
  ToolSpec,
} from './types.js';

/**
 * One approval-required entry in the derived list. Carries the
 * tool's id + a structured reason so UIs can render "Tool X needs
 * approval because: irreversible external action" without
 * re-deriving from the IR.
 */
export interface ApprovalRequirement {
  readonly toolId: string;
  readonly risk: ToolSpec['risk'];
  readonly capabilities: readonly string[];
  /** Human-readable rationale. */
  readonly reason: string;
}

/**
 * Compute the derived approvals list from a PolicyIR. A guardrail
 * UI uses this to render "tools that require approval" without
 * walking the full evaluator for every call.
 *
 * Default rule: a tool requires approval iff
 *   - `risk === 'critical'`, OR
 *   - capabilities include `IRREVERSIBLE_EXTERNAL`.
 */
export function approvalListFor(policy: PolicyIR): readonly ApprovalRequirement[] {
  const out: ApprovalRequirement[] = [];
  for (const tool of policy.tools) {
    const reasons: string[] = [];
    if (tool.risk === 'critical') reasons.push('risk=critical');
    if (tool.capabilities.includes('IRREVERSIBLE_EXTERNAL')) {
      reasons.push('capability=IRREVERSIBLE_EXTERNAL');
    }
    if (reasons.length === 0) continue;
    out.push({
      toolId: tool.id,
      risk: tool.risk,
      capabilities: tool.capabilities,
      reason: reasons.join(', '),
    });
  }
  return out;
}

/**
 * Input to `evaluateDecision` — the tool call the guardrail wants
 * to make a decision on.
 */
export interface ToolCallInput {
  readonly toolId: string;
  /**
   * Free-form args. The evaluator scans values (and tool id) for
   * substring matches against `DenyRule.when.tag` patterns. Args
   * may be omitted by callers that just want a coarse decision.
   */
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * Evaluate a single tool call against the PolicyIR. Returns the
 * `Decision` shape from the upstream contract.
 *
 * Order of operations:
 *   1. If the tool is unknown to the policy, return `deny` (closed
 *      world — tools must be declared in `oc://TOOLS.md/Tools`).
 *   2. If any DenyRule matches, return `deny` with the rule's reason.
 *   3. If the tool is on the approvals list, return `requires-approval`.
 *   4. Otherwise `allow`.
 */
export function evaluateDecision(
  policy: PolicyIR,
  call: ToolCallInput,
): Decision {
  const tool = policy.tools.find((t) => t.id === call.toolId);
  if (tool === undefined) {
    return {
      kind: 'deny',
      reason: `unknown-tool: ${call.toolId}`,
    };
  }

  const denyMatch = matchAnyDenyRule(policy.denyRules, tool, call);
  if (denyMatch !== null) {
    return {
      kind: 'deny',
      reason: denyMatch.reason,
      rule: denyMatch.id,
    };
  }

  const approvals = approvalListFor(policy);
  const needsApproval = approvals.some((a) => a.toolId === tool.id);
  if (needsApproval) {
    const entry = approvals.find((a) => a.toolId === tool.id)!;
    return {
      kind: 'requires-approval',
      reason: entry.reason,
    };
  }

  return { kind: 'allow' };
}

function matchAnyDenyRule(
  rules: readonly DenyRule[],
  tool: ToolSpec,
  call: ToolCallInput,
): DenyRule | null {
  for (const rule of rules) {
    const w = rule.when;
    if (w.tool !== undefined && w.tool === tool.id) return rule;
    if (
      w.capability !== undefined &&
      tool.capabilities.includes(w.capability)
    ) {
      return rule;
    }
    if (w.tag !== undefined) {
      const tag = w.tag.toLowerCase();
      // Substring match against tool id and string-valued args. The
      // tag is a normalized fingerprint produced by the deny-rule
      // extractor (`*never*share*restricted*` etc.), so the match
      // is structural; the exact pattern format is the
      // extractor's contract.
      if (tool.id.toLowerCase().includes(stripStars(tag))) return rule;
      if (call.args !== undefined) {
        for (const v of Object.values(call.args)) {
          if (typeof v !== 'string') continue;
          if (tagMatchesValue(tag, v)) return rule;
        }
      }
    }
  }
  return null;
}

function stripStars(tag: string): string {
  return tag.replace(/^\*+|\*+$/g, '').replace(/\*+/g, ' ').trim();
}

function tagMatchesValue(tag: string, value: string): boolean {
  // Tag is `*kw1*kw2*kw3*` — every keyword must appear in `value`
  // (case-insensitive) for the tag to match. Empty tag matches
  // everything (trivial deny).
  const keywords = tag
    .split('*')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (keywords.length === 0) return true;
  const lower = value.toLowerCase();
  return keywords.every((k) => lower.includes(k));
}
