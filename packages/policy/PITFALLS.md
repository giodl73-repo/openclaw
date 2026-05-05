# policy Pitfalls

Substrate / SDK-level pitfalls for `@openclaw/policy` — by
tests across `tests/plugin-sdk/policy/*`, inline `// POL-NNN`
comments, and consumer error messages.

**Scope**: ONLY the substrate code under `src/plugin-sdk/policy/`
plus the starter generator pack. This is a **separate namespace**
from:
  - `policy/src/cli/PITFALLS.md` (CLI-POLICY-NNN — `openclaw-policy` CLI)
  - `oc-path/PITFALLS.md` (P-NNN — OcPath syntax / verbs)
  - `oc-path/src/plugin-sdk/oc-path/workspace/PITFALLS.md` (W-NNN — manifest walker)
  - `lkg/PITFALLS.md` (LKG-NNN — recovery semantics)

Each pitfall is locked by at least one test. Status legend:

| Status | Meaning |
| --- | --- |
| MITIGATED | Substrate defends against this with a test that locks the behavior. |
| CALLER | Caller's responsibility, with a documented limit / surface. |
| DEFERRED | Known gap, scoped to a follow-up. |

## Canonicalization (RFC 8785 JCS)

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-001 | MITIGATED | Object members are emitted in **codepoint sort order** of keys, not lexicographic by locale. Capital `A` (U+0041) sorts BEFORE lowercase `a` (U+0061). Two generators that disagree on key order still produce the same `policyId`. (`CN-02`, `CP-03`) |
| POL-002 | MITIGATED | `undefined` object values are **skipped**, not emitted as `null`. Mirrors `JSON.stringify` convention. Producers must use explicit `null` if absence-as-value is meaningful — otherwise the field disappears from the canonical bytes. (`CN-05`) |
| POL-003 | MITIGATED | Non-finite numbers (`NaN`, `±Infinity`) **throw** rather than serializing to `null`. They aren't JSON-representable; silently dropping them would break determinism. PolicyIR doesn't currently emit fractional numbers, so the float path is rarely hit; revisit `canonicalizeNumber` if floats are introduced. (`CN-06`) |
| POL-004 | MITIGATED | Arrays preserve **insertion order** — they are NOT sorted. Producers that want deterministic arrays must pre-sort by `id` (or another stable key) before handing the value to `canonicalize`. The starter generator dedupes-then-emits in declaration order. (`CN-03`, `BPI-03`) |
| POL-005 | CALLER | `canonicalize` supports JSON-shape values only: scalars, plain objects, arrays. Date / BigInt / Map / Set / typed-array inputs throw with a `TypeError`. Callers serializing exotic types must reduce them to JSON-shape first. |

## policyId hash

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-010 | MITIGATED | `computePolicyId(body)` requires the input to be `Omit<PolicyIR, 'policyId'>`. Passing the **full IR including `policyId`** produces a different hash and silently breaks integrity checks. The TS type forbids it; runtime callers MUST destructure off `policyId` first. The CLI's `check` does this correctly (`runCmdCheck`). (`CP-01`, `CP-02`, `CP-03`, `CP-04`) |
| POL-011 | MITIGATED | `policyId` includes `generatedAt` and `generatedFrom` in its body — every regeneration produces a **different** `policyId` even when the policy SHAPE is identical. Use `computePolicyShapeHash` (POL-012) for drift detection; `policyId` only proves integrity within a single artifact. (`CSH-02`, `CSH-03`) |
| POL-012 | MITIGATED | `computePolicyShapeHash(ir)` excludes `policyId`, `generatedAt`, `generatedFrom` so two regenerations of the same sources produce the same shape hash. This is the **load-bearing primitive for drift detection**. The CLI's workspace-mode `check` uses it. (`CSH-01`, `CSH-04`, `CSH-05`, `CSH-06`) |

## Decision evaluation runtime

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-020 | MITIGATED | **Closed-world tool evaluation**: `evaluateDecision` returns `deny` for any tool not declared in `PolicyIR.tools`. There is no allowlist-by-default; tools must be explicitly added before they can be allowed. The deny reason includes `unknown-tool` so callers can distinguish "denied by rule" from "denied because undeclared." (`ED-01`, `PE-02`, `PT-03`, `CLI-08`) |
| POL-021 | MITIGATED | Tag-deny matching is **keyword-AND substring** (case-insensitive). The pattern `*never*share*restricted*` requires `never` AND `share` AND `restricted` to all appear (in any order) in the stringified args. A single missing keyword silently doesn't match — no warning. Operators authoring deny tags should test the match explicitly. (`ED-06`, `PE-03`, `CLI-09`) |
| POL-022 | MITIGATED | Decision precedence is **deny > requires-approval > params > allow**. A deny rule fires before the approval check; a tool that's both critical-risk AND matches a deny rule produces a deny, not a requires-approval. (`ED-07`) |
| POL-023 | MITIGATED | `requires-approval` triggers on `risk: 'critical'` **OR** `capabilities: ['IRREVERSIBLE_EXTERNAL']`. The OR semantics mean a low-risk tool with `IRREVERSIBLE_EXTERNAL` still requires approval (e.g., `delete-file` is low-risk read-write but irreversible). (`AL-01`, `AL-02`, `AL-03`) |
| POL-024 | MITIGATED | `approvalListFor(policy)` returns the **derived** subset of tools needing approval based on (POL-023). Each entry includes a `reason` explaining which gate fired. Callers SHOULD NOT cache this list across policy changes — recompute after every regeneration. (`AL-04`) |

## Generator framework + registry

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-030 | MITIGATED | `registerPolicyGenerator(spec)` uses a `Map`; **last-write wins** on duplicate id. Re-registering the same id silently overwrites the prior spec. Use `getPolicyGenerator(id)` after registration to verify which generator is active. The `_clearPolicyGeneratorRegistry()` helper exists for tests; production code MUST NOT call it. |
| POL-031 | MITIGATED | Generator packs (`extensions/policy-from-md-starter/generator.ts`) self-register on **import**. Consumers must import the pack module before calling `getPolicyGenerator` — otherwise the registry is empty. The CLI imports `extensions/policy-from-md-starter/generator.js` for this reason; downstream binaries do the same. |
| POL-032 | CALLER | `PolicyGenerator.generate(content, anchor)` receives an `LKGFingerprint` anchor that is recorded in the IR's `generatedFrom`. **Threading the wrong anchor** produces an IR whose `generatedFrom` doesn't match the LKG observation that the workspace would produce next — causing a TOCTOU mismatch when downstream evaluators check `ctx.lkgFingerprint`. Callers MUST thread the actual anchor from `LKGStore.observe()` at production time. |
| POL-033 | MITIGATED | The starter md generator dedupes tools by `id` with **last-writer-wins** semantics: if `TOOLS.md` declares the same tool twice, the second declaration overwrites the first. Same applies to deny rules by `id`. Lint / doctor packs SHOULD flag duplicate ids upstream of the generator so operators don't rely on this implicit ordering. (`BPI-03`) |

## Trusted-tool-policy adapter

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-040 | MITIGATED | `policyTrustedToolPolicy(opts)` captures `opts.policy` **by reference** in the closure. Hot-swapping the active PolicyIR on a new LKG promotion REQUIRES re-registering with a fresh adapter — the previously-registered closure keeps pointing at the old IR. If upstream's registration shape grows late-binding, callers can pass a getter; until then, re-register. (`PE-01`, `PT-01`) |
| POL-041 | MITIGATED | `mapDecisionToHostShape` performs a **verb rename** (`deny` → `block`, `params` → `mutate-params`) but **preserves semantics**. The `reason` and `rule` fields flow through unchanged. Audit-log readers consuming both shapes must understand the equivalence. (`AD-01`, `AD-02`, `AD-03`, `AD-04`, `AD-05`) |
| POL-042 | CALLER | `loadPolicyIRFromFile(path)` does **NOT** verify `policyId` against the body. Callers SHOULD compute `computePolicyId(body)` and compare before trusting the IR — OR run `openclaw-policy check <path>` upstream of registration. The convenience helper exists for the common-case fast path; integrity is a separate concern. (`LP-01`) |
| POL-043 | MITIGATED | The adapter's `PluginToolPolicyDecision` shape is defined **structurally** to avoid importing from `@openclaw/plugin-sdk` (which exists upstream but not in this prototype's dep graph). Hosts whose actual `PluginToolPolicyDecision` is structurally compatible can use the adapter directly; if upstream's shape diverges, hosts wrap the adapter result in a thin shim. |

## Tool & DenyRule extraction (starter pack)

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-050 | MITIGATED | `denyRulesFromSoulMd` lifts each `## Boundaries` bullet into a `DenyRule` with id `SOUL-N` (1-indexed). Reordering bullets renames their ids — operators editing `SOUL.md` should be aware that bullet position is load-bearing for cross-version diffs. (`PE-DR-01`, `PE-DR-02`) |
| POL-051 | MITIGATED | `toolsFromToolsMd` parses lines of the form `### <id> # <RISK>, <CAP>, ...` from the `## Tools` section. The risk token is normalized (`R5` → `critical`); unknown risk tokens default to `medium` rather than throwing — a lint rule SHOULD flag unrecognized tokens upstream. |
| POL-052 | MITIGATED | The starter generator supports per-tool **sensitivity overrides** via two forms: explicit `sensitivity:<level>` (canonical, lint-rule rewriteable) and legacy bare-word (`### t # R3, READ, public`). Explicit form wins; unknown explicit tokens fall through to capability-derived defaults rather than throwing. Bare-word matching is **token-level** (split on `,\s+`) — substrings like `public-api` in tool ids do NOT trigger. (`PE-TL-04`, `PE-TL-05`, `PE-TL-06`, `PE-TL-07`, `PE-TL-08`) |

## Workspace conventions

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-060 | MITIGATED | `POLICY_PATH = 'policy.jsonc'` at the workspace root — treated as **config**, not a snapshot-internal IR. Lint rules / doctor fixers / oc-paths address it via `oc://policy.jsonc/...`. Callers hard-coding the legacy `.openclaw/policy/policy-ir.json` path will fail; migrate via the `POLICY_PATH` import. |
| POL-061 | CALLER | `policy.jsonc` is canonical-named via `POLICY_PATH`. Generators / doctor fixers writing to a non-canonical name (e.g., `policy.dev.jsonc`) MUST NOT expect lint/doctor extensions to find them — the manifest walker only matches the canonical role. |

## Caller obligations

| ID | Status | Pitfall |
| --- | --- | --- |
| POL-070 | CALLER | `PolicyIR.generatedFrom: LKGFingerprint` is the load-bearing TOCTOU anchor. Production hosts MUST thread the actual fingerprint observed at generation time (via `LKGStore.observe()` or equivalent) — substituting a synthetic content-hash (as the CLI does for convenience) breaks downstream guarantees that an evaluator can verify it's reading the same bytes the generator saw. |
| POL-072 | CALLER | Generator authors implementing `PolicyGenerator<TValidated>` MUST treat `TValidated` as already-validated — the generator is NOT a validation boundary. Run schema / lint / doctor checks upstream of `generate(...)`; the generator's job is the pure mapping. |

## Test mapping

Every MITIGATED pitfall above maps to one or more test cases in
`tests/plugin-sdk/policy/*` or the CLI tests. New pitfalls land
here AND a test simultaneously — neither side moves alone.
