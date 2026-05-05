/**
 * Trusted-tool-policy adapter — bridges our `PolicyIR` /
 * `evaluateDecision` shape to the upstream
 * `registerTrustedToolPolicy` slot at
 * `openclaw-core/src/plugins/host-hooks.ts`.
 *
 * **Strategic frame**: per the upstream PR-1 framing, policy lives
 * INSIDE LKG-tracked artifacts; the existing
 * `registerTrustedToolPolicy` runner already accepts conforming
 * `PluginTrustedToolPolicyRegistration` impls. This adapter is the
 * concrete bridge — a host loads a `PolicyIR` (from disk, an LKG
 * store, or anywhere), constructs the evaluator, and registers it.
 *
 * The adapter is intentionally minimal: ~50 LoC of pure mapping
 * code. The host wires the result into upstream's existing slot;
 * no new SDK verb is added.
 *
 *   import { policyTrustedToolPolicy, loadPolicyIRFromFile } from
 *     '@openclaw/plugin-sdk/policy';
 *
 *   const policy = await loadPolicyIRFromFile('policy.jsonc');
 *   api.registerTrustedToolPolicy(
 *     policyTrustedToolPolicy({ id: 'policy-from-md', policy }),
 *   );
 *
 * @module @openclaw/plugin-sdk/policy/adapter
 */

import { promises as fs } from 'node:fs';
import type { Decision, PolicyIR } from './types.js';
import { evaluateDecision, type ToolCallInput } from './runtime.js';

/**
 * Minimal event shape consumed by the adapter. Structural subset
 * of upstream's `PluginHookToolEvent` — only the fields the
 * adapter actually reads. Hosts can pass the full upstream event
 * directly; TypeScript's structural typing means a wider shape
 * still satisfies this interface.
 */
export interface PolicyToolEvent {
  /** Tool name being invoked. Matches `ToolSpec.id` in the IR. */
  readonly toolName: string;
  /** Tool call arguments (free-form). Used for tag-substring deny matching. */
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * Upstream `PluginToolPolicyDecision` shape (structural). Defined
 * here so the adapter doesn't import from `@openclaw/plugin-sdk`
 * (which exists upstream but not in this prototype's dep graph).
 * The host's actual `PluginToolPolicyDecision` MUST be assignable
 * from this shape; if upstream's shape differs structurally, hosts
 * write a thin wrapper (or upstream's shape grows to match).
 *
 * Maps our `Decision`:
 *   - `{kind:'allow'}` → `{decision:'allow'}`
 *   - `{kind:'deny',reason,rule?}` → `{decision:'block',reason}`
 *   - `{kind:'requires-approval',reason}` → `{decision:'requires-approval',reason}`
 *   - `{kind:'params',mutate}` → `{decision:'mutate-params',mutate}`
 *
 * The verb name change `deny` → `block` reflects upstream's choice
 * of vocabulary; semantics are identical.
 */
export type PluginToolPolicyDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly reason: string; readonly rule?: string }
  | { readonly decision: 'requires-approval'; readonly reason: string }
  | { readonly decision: 'mutate-params'; readonly mutate: Readonly<Record<string, unknown>> };

/**
 * Pure mapping from our `Decision` shape to upstream's
 * `PluginToolPolicyDecision` shape. Exported so plugin authors who
 * want to drive the evaluator from a non-trusted-tool surface
 * (debugging, custom hooks, alternate runners) can re-use it.
 */
export function mapDecisionToHostShape(d: Decision): PluginToolPolicyDecision {
  switch (d.kind) {
    case 'allow':
      return { decision: 'allow' };
    case 'deny':
      return d.rule !== undefined
        ? { decision: 'block', reason: d.reason, rule: d.rule }
        : { decision: 'block', reason: d.reason };
    case 'requires-approval':
      return { decision: 'requires-approval', reason: d.reason };
    case 'params':
      return { decision: 'mutate-params', mutate: d.mutate };
  }
}

/**
 * Build a pure evaluator function from a loaded PolicyIR. The
 * returned closure produces our `Decision` shape (NOT mapped to
 * upstream); useful for callers that want to inspect the structured
 * Decision before downstream conversion. For direct registration,
 * use `policyTrustedToolPolicy` below.
 */
export function makePolicyEvaluator(
  policy: PolicyIR,
): (event: PolicyToolEvent) => Decision {
  return (event) => {
    const call: ToolCallInput =
      event.args !== undefined
        ? { toolId: event.toolName, args: event.args }
        : { toolId: event.toolName };
    return evaluateDecision(policy, call);
  };
}

/**
 * Registration spec for upstream's `registerTrustedToolPolicy`.
 * Structural subset of `PluginTrustedToolPolicyRegistration`.
 */
export interface PolicyTrustedToolRegistration {
  readonly id: string;
  evaluate(event: PolicyToolEvent): PluginToolPolicyDecision;
}

export interface PolicyTrustedToolPolicyOptions {
  /** Stable id for the registration; appears in audit logs. */
  readonly id: string;
  /** The PolicyIR this guardrail evaluates against. */
  readonly policy: PolicyIR;
}

/**
 * Build a registration spec the host wires into
 * `api.registerTrustedToolPolicy(...)`. Closes the E2E gap from
 * PolicyIR (data) → Decision (computed) → host wire format
 * (registered).
 *
 * The closure captures `policy` by reference. Hosts that hot-swap
 * the active PolicyIR on a new LKG promote SHOULD re-register with
 * a fresh adapter, OR pass a getter for `policy` if upstream's
 * registration shape supports late-binding.
 */
export function policyTrustedToolPolicy(
  opts: PolicyTrustedToolPolicyOptions,
): PolicyTrustedToolRegistration {
  const evaluator = makePolicyEvaluator(opts.policy);
  return {
    id: opts.id,
    evaluate(event) {
      return mapDecisionToHostShape(evaluator(event));
    },
  };
}

/**
 * Convenience helper: read a PolicyIR from disk. Pairs with
 * `policyTrustedToolPolicy` for the common case of "load the IR
 * the gateway wrote, register a guardrail against it."
 *
 * Does NOT verify `policyId` against the body — callers SHOULD
 * call `computePolicyId(body)` and compare before trusting the IR.
 * The `openclaw-policy check` CLI does this verification; hosts
 * that want it inline run it themselves.
 */
export async function loadPolicyIRFromFile(path: string): Promise<PolicyIR> {
  const raw = await fs.readFile(path, 'utf-8');
  return JSON.parse(raw) as PolicyIR;
}
