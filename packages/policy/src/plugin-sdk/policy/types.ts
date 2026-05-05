/**
 * `@openclaw/plugin-sdk/policy` — type contract for the PolicyIR
 * artifact and the generator interface.
 *
 * Lands at `openclaw/openclaw` upstream as a types-only PR per
 * `lobster-docs/Tech/OpenClaw/specs/proposals/upstream/policy-anchoring/upstream-pr1-policyir.md`.
 *
 * Strategic frame (one sentence): policy is a generated artifact —
 * the gateway compiles validated workspace content into a stable
 * shape that any conforming guardrail can evaluate, and a single
 * `LKGFingerprint` anchor lets every decision cite the specific
 * version of policy it evaluated against.
 *
 * **Type-only**. ~150 LoC. No runtime, no daemon, no CLI verbs.
 *
 * @module @openclaw/plugin-sdk/policy
 */

import type { LKGFingerprint } from '@openclaw/lkg';

/**
 * Tier label used in `policy-ir.json` for cross-plane audit
 * alignment. Mirrors the convention shipped on
 * `DecisionEntry.effectiveTier` in the gateway audit log.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Sensitivity classification of a tool's data surface. Used to
 * compute capability bounds and to gate cross-tier flow in the
 * G-CHAIN provenance check.
 */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * Decision the guardrail emits per tool call. The policy IR enables
 * `Decision`s; the actual decision is computed at evaluate time by
 * an adapter that closes over a loaded PolicyIR.
 *
 *  - `allow` — the tool call may proceed unmodified.
 *  - `deny` — the tool call is blocked. `reason` and optional `rule`
 *    explain which deny rule fired.
 *  - `requires-approval` — operator interaction required before the
 *    tool call may proceed.
 *  - `params` — the call may proceed with mutated parameters; the
 *    `mutate` map carries the changes (e.g., redacted-secret
 *    substitutions).
 */
export type Decision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly rule?: string }
  | { readonly kind: 'requires-approval'; readonly reason: string }
  | { readonly kind: 'params'; readonly mutate: Readonly<Record<string, unknown>> };

/**
 * One tool surface declared in the workspace authoring source. The
 * generator extracts these from canonical openclaw artifacts (e.g.,
 * `oc://TOOLS.md/Tools/*`) and emits them into PolicyIR.
 */
export interface ToolSpec {
  /** Stable id; matches the basename used at `oc://TOOLS.md/Tools/<id>`. */
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly risk: RiskLevel;
  readonly sensitivity: Sensitivity;
}

/**
 * One deny rule declared in the workspace authoring source. The
 * generator extracts these from `oc://SOUL.md/Boundaries/*` (and
 * equivalent) and emits them into PolicyIR.
 */
export interface DenyRule {
  /** Stable id; e.g., `SOUL-1` for the first Boundaries bullet. */
  readonly id: string;
  readonly when: {
    readonly tool?: string;
    readonly capability?: string;
    readonly tag?: string;
  };
  readonly reason: string;
}

/**
 * The compiled policy artifact. Riding inside an LKG-tracked path,
 * the active PolicyIR is the byte-stable target every guardrail
 * evaluates against. Decisions anchor via `ctx.lkgFingerprint`.
 */
export interface PolicyIR {
  /** Schema version of this PolicyIR shape (semver). */
  readonly version: string;
  /**
   * Content hash of `(this body excluding policyId)` per RFC 8785
   * JCS. Two generators producing semantically-identical PolicyIR
   * MUST produce the same `policyId`.
   */
  readonly policyId: string;
  /** ISO-8601 UTC timestamp when this PolicyIR was generated. */
  readonly generatedAt: string;
  /**
   * The LKG fingerprint of the policy file at the moment this IR
   * was generated. Lets evaluators verify they're reading the IR
   * matching the workspace state they expect (closes the TOCTOU gap
   * between generation and evaluation).
   */
  readonly generatedFrom: LKGFingerprint;
  readonly tools: readonly ToolSpec[];
  readonly denyRules: readonly DenyRule[];
}

/**
 * Generator interface. Each consumer (claws / OPA / CEL / yaml /
 * future) ships its own `PolicyGenerator<TValidated>` impl declaring
 * what its validated input shape looks like. The output PolicyIR is
 * universal.
 */
export interface PolicyGenerator<TValidated> {
  /**
   * Generate a PolicyIR from validated content. Runs against a
   * known LKG fingerprint (the bytes that produced this IR); the
   * fingerprint is threaded through so `generatedFrom` is bound at
   * generation time.
   */
  generate(content: TValidated, anchor: LKGFingerprint): Promise<PolicyIR>;
}

/**
 * Conventional path under the workspace root where the policy
 * file lives. Treated as config (the same way `gateway.jsonc` is
 * config) — the gateway / generator manages it, but it's a
 * first-class workspace artifact like any other `.jsonc` config.
 *
 * Matches the manifest's existing `policy.jsonc` role; LKG-tracked
 * under that role; lint rules, doctor fixers, audit events all
 * address it via `oc://policy.jsonc/...` paths.
 *
 * Consumers of the upstream contract use this constant rather than
 * hard-coding the string. The "PolicyIR" name remains an internal
 * description of the in-memory shape; the file itself is just
 * `policy.jsonc` — no separate IR file.
 */
export const POLICY_PATH: 'policy.jsonc' = 'policy.jsonc';
