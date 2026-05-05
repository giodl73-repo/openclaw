# `@openclaw/policy` — design (PolicyIR + LKG anchoring)

Status: pre-RFC, drafting on the fork at `giodl73-repo/openclaw`. Filed 2026-05-05 by giodl@microsoft.com / Microsoft. Depends on the OcPath substrate (`docs/reference/oc-paths-substrate-design.md`) and the LKG cage (`docs/reference/lkg-cage-design.md`).

## Summary

A new SDK package `@openclaw/policy` introduces a **PolicyIR** — a compiled, content-addressable artifact that declares "tool X requires capability Y, sensitivity tier T" — plus an `evaluate` runtime that uses the existing `api.registerTrustedToolPolicy({ id, evaluate })` slot from upstream. The artifact is **LKG-tracked**: every decision context carries an `lkgFingerprint` of the active policy bytes, so guardrails can prove "decision was made against THIS exact policy" without rereading the file.

CLI: `openclaw policy generate | check | diff | evaluate | list-generators`. Generators ship as plugins (the reference one extracts from MD sources: TOOLS.md headings, SOUL.md deny rules, etc.).

## Problem

OpenClaw consumers want governance-as-data — declare "tool X requires capability Y, sensitivity tier T" once, compile it to a stable artifact, persist it with the user's workspace, and have any conforming guardrail evaluate it identically. Today every consumer rolls their own. claws alone has parallel implementations across `openclaw-policy/` (~6.2k LoC), `claws-sdk/src/governance/` (~1.7k LoC), and `claws-sdk/src/compliance/` (~3.1k LoC).

Without a shared artifact-shape contract:
- Governance drifts per-consumer.
- Policy-bearing artifacts can't cross ecosystem boundaries.
- Two guardrails reading the same policy file can disagree on what it permits (no canonical hash; no shape-equivalence check).
- A decision audit trail can't say "the policy that allowed this was hash X" — there's no shared notion of "the active policy bytes."

Enforcement is already solved upstream: `api.registerTrustedToolPolicy({ id, evaluate })` dispatches per-tool decisions. The missing piece is the **artifact-shape contract** that the runner evaluates against, and a way to thread the active policy's LKG fingerprint into the evaluator's context.

## What changes

### 1. PolicyIR contract

```ts
interface PolicyIR {
  readonly version: '0.1.0';
  readonly generatedAt: string;          // ISO-8601 UTC
  readonly generatedFrom: LKGFingerprint; // anchors to source bytes
  readonly tools: readonly ToolSpec[];
  readonly denyRules: readonly DenyRule[];
  readonly policyId: string;             // sha256 over canonical-shape bytes (RFC 8785 JCS)
}

interface ToolSpec {
  readonly id: string;
  readonly risk: 'low' | 'medium' | 'high' | 'critical';
  readonly capabilities: readonly string[];   // READ, WRITE, COMMUNICATE, IRREVERSIBLE_EXTERNAL, FLEET_PRIVILEGED, IDENTITY
  readonly sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
}

interface DenyRule {
  readonly id: string;
  readonly match: { tool: string; argPattern?: string };
  readonly reason: string;
}
```

The `policyId` is a deterministic hash over the canonical-shape (RFC 8785 JCS): two PolicyIRs with the same shape have the same `policyId` regardless of `generatedAt` / `generatedFrom`. That gives operators a "shape-sameness" probe for fleet audits ("are all 47 workspaces on the same policy SHAPE?").

### 2. `ctx.lkgFingerprint` in the decision context

The existing `api.registerTrustedToolPolicy({ id, evaluate })` runner gets one new context field:

```ts
type Decision = 'allow' | 'deny' | 'gated';

interface DecisionContext {
  // existing fields (tool id, args, agent identity, ...)
  readonly lkgFingerprint?: LKGFingerprint;   // NEW — anchors to active policy bytes
}
```

When the host loads a PolicyIR via the LKG substrate, the active fingerprint flows into the evaluator's context. Audit envelopes record `lkgFingerprint` so post-hoc reviews can replay against the EXACT policy that was active at decision time. Closes the "what policy was active when decision X happened?" forensics gap.

### 3. Generators as plugins

```ts
api.registerPolicyGenerator(spec: PolicyGeneratorSpec<TInput>): void;
```

A `PolicyGenerator` consumes input (typically MD sources via PR-1's `findOcPaths`) and emits a `PolicyIR`. The reference generator extracts:
- ToolSpecs from `TOOLS.md` `### name # R<n>, CAPS, sensitivity:level` headings
- DenyRules from `SOUL.md` `## Deny rules` bulleted lists
- Any `KEY=value` capabilities the tracker recognizes

Plugin authors register their own generators for non-MD sources (a JSON-config-driven generator, a CSV-driven enterprise-policy generator, etc.).

### 4. Drift detection

`openclaw policy check` compares the on-disk `policy.jsonc` shape hash with what the registered generator would produce from the current MD sources. Operators see "your policy.jsonc is stale; sources have moved on" without re-running generation. Closes the "did anyone update SOUL.md after the last regen?" question.

### 5. CLI: `openclaw policy`

```
openclaw policy generate [<dir>] [--write] [--dry-run]   — generate from MD sources
openclaw policy check [<dir>]                            — drift detection
openclaw policy diff [<dir>] [--against <policyId>]      — show what would change
openclaw policy evaluate [<dir>] --tool <id> --args <…>  — dry-run a decision
openclaw policy list-generators                           — enumerate registered generators
```

### 6. Trusted-tool-policy adapter

A small `claws-policy-runner` shim plugs into `api.registerTrustedToolPolicy` and dispatches per-tool decisions against the loaded PolicyIR. The PolicyIR sits at an LKG-tracked path (default: `policy.jsonc` at workspace root); recovery + drift detection ride for free.

## Goals

- **One artifact shape (PolicyIR)** that any guardrail evaluator can consume identically.
- **Content-addressable**: `policyId` = hash over canonical-shape bytes. Fleet audits become straightforward (compare hashes).
- **LKG-tracked**: PolicyIR rides at an LKG-tracked path. Recovery + drift + audit-correlation come from the cage substrate.
- **`ctx.lkgFingerprint`** in decision context: post-hoc audit can replay against the exact policy that was active.
- **Generator pluralism**: plugins register `PolicyGenerator`s for arbitrary inputs (MD, JSON, CSV, etc.). The reference MD generator ships in this PR.

## Non goals

- Replacing the existing `registerTrustedToolPolicy` runtime. PolicyIR is the artifact; the runtime stays as it is.
- A specific deny-rule expression language. v0 supports simple `(tool, argPattern)` matching; richer rule languages (CEL, OPA Rego) are v1+.
- Tenant-scoped policies. v0 is per-workspace; multi-tenant policy fan-out is a separate concern.

## Integration into openclaw

This branch (`substrate/policy`) demonstrates two integration points:

1. **`openclaw policy` CLI verb** — new `register.policy.ts` in `src/cli/program/` adds the `policy` parent command with pass-through dispatch. Same minimal-dispatcher pattern as `register.path.ts` / `register.pinch.ts` / `register.cage.ts`.

2. **Workspace dep** — `@openclaw/policy` added as a root workspace dep.

Two follow-up integrations sit in this branch's spec but are deferred to subsequent PRs:
- Threading `ctx.lkgFingerprint` into `api.registerTrustedToolPolicy`'s evaluator context — small contract addition in upstream's plugin host code.
- Wiring the trusted-tool-policy adapter as a default registration when PolicyIR is detected at the workspace's policy.jsonc path.

## Open questions

- **Where does `policy.jsonc` live?** Workspace root (`./policy.jsonc`) is the obvious default; per-environment overlays (`./policy.production.jsonc`) are v1+.
- **`policyId` collision**: deterministic hash; two policies with identical SHAPE have identical IDs. Useful for fleet audits but means edit timestamps don't change ID. Worth documenting as a feature, not a bug.
- **Generator dispute resolution**: if two registered generators target the same source, which wins? Today: throw. Could become last-writer-wins or explicit priority.

## Test surface

- `packages/policy/tests/` — 124 tests across N files (claws-hapi side). Covers PolicyIR types, shape-hash determinism, RFC 8785 JCS canonicalization, generator pluralism, drift detection, CLI bin + subcommands, evaluator integration.
- Real-world validation: 25-fixture suite at `validation/` (claws-hapi side).

## Provenance

Drafted with Claude Opus 4.7 (1M context) by giodl@microsoft.com. Full PR train at `docs/reference/`: oc-paths-substrate-design / pinch-lint-design / oc-doctor-design / lkg-cage-design / policy-anchoring-design — 5 substrates landing in linear stack on this fork.
