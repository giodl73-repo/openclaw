# `@openclaw/oc-doctor` — design

Status: pre-RFC, drafting on the fork at `giodl73-repo/openclaw`. Filed 2026-05-05 by giodl@microsoft.com / Microsoft. Depends on the OcPath substrate (`docs/reference/oc-paths-substrate-design.md`) and pinch lint (`docs/reference/pinch-lint-design.md`).

## Summary

A new SDK package `@openclaw/oc-doctor` that defines an `OcPathFixerSpec` adapter shape — plugin authors register fixers (mutating, additive, or regenerative) that operate on canonical workspace artifacts via the universal OcPath addressing from PR-1. The substrate explicitly does NOT add a new top-level CLI verb; it slots into the existing `openclaw doctor` command via the upstream's existing per-plugin `doctor-contract-api.{ts,js}` extension surface (`src/plugins/doctor-contract-registry.ts`).

The package ships starter fixer packs (md / jsonc / jsonl / yaml-as-lobster) that pair one-for-one with pinch's starter rule packs — a finding from the linter is repaired by the matching fixer.

## Problem

Pinch (sister substrate, PR-2) gives plugins a way to FLAG problems in workspace artifacts. There's no shared way to FIX them. Today every plugin that wants to do "validate + fix" rolls its own:

- The existing `openclaw doctor` command discovers per-plugin compatibility rules via `doctor-contract-registry.ts` — but each plugin ships ad-hoc legacy-config rules + ad-hoc normalizers, not a shared fixer-spec shape.
- Plugins that want to fix workspace markdown (e.g., add a missing `## Boundaries` section) have no shared adapter to express the fix as `(read AST, return new AST)` — they manually parse, mutate, emit.
- Cross-file fixers (e.g., "if AGENTS.md references a tool, ensure TOOLS.md has an entry") have no contract for accessing sibling files.

## What changes

### 1. `OcPathFixerSpec` contract

```ts
interface OcPathFixerSpec {
  readonly id: string;                       // 'starter-v0/agents/insert-boundaries-section'
  readonly description: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly tier: 'additive' | 'mutating' | 'regenerative';   // operator-gated
  readonly appliesTo: string;                // glob: 'AGENTS.md', '*.jsonc', '*.lobster'

  detect(input: DetectInput): Promise<readonly OcPathFixerFinding[]>;
  fix(input: FixInput): Promise<string>;
}
```

`detect` walks the AST + reports findings; `fix` produces the new bytes. Both are async and may consult `siblingFiles` (read-only access to the rest of the workspace) — supports cross-file fixers natively.

Three tiers reflect blast radius:
- **`additive`**: only inserts content (e.g., add a missing section). Always safe; runs by default.
- **`mutating`**: changes existing content (e.g., normalize a value). Operator opts in.
- **`regenerative`**: rewrites a whole file from sources (e.g., regenerate `policy.jsonc` from MD when it drifts). Highest risk; explicit `--fix-regenerative` flag.

### 2. `registerOcPathFixer` SDK verb

```ts
api.registerOcPathFixer(spec: OcPathFixerSpec): void;
```

One new SDK verb. Plugin authors call it at module-init time. The substrate exposes the registry via:

```ts
import { listOcPathFixers, _clearFixerRegistry } from '@openclaw/oc-doctor';
```

### 3. Integration into existing `openclaw doctor`

Upstream's `src/plugins/doctor-contract-registry.ts` already loads per-plugin `doctor-contract-api.{ts,js}` files. Plugins that want to ship OcPath fixers add a `doctor-contract-api.ts` that calls `registerOcPathFixer` for each spec. The `openclaw doctor` command's existing pipeline reads the registry; the OcPath fixers join the existing `legacyConfigRules` / `normalizeCompatibilityConfig` / `sessionRouteStateOwners` extension surface.

**Naming note**: The earlier pre-RFC referred to a hypothetical `api.registerDoctorHealthContribution` SDK verb. That name doesn't exist upstream; the actual extension surface is the per-plugin `doctor-contract-api.ts` file mechanism. This spec corrects the naming.

### 4. Starter fixer packs

| Pack | Pair-with rule | Tier | What it fixes |
|------|----------------|------|---------------|
| `starter-v0/agents/insert-boundaries-section` | starter-v0/agents/missing-boundaries | additive | inserts `## Boundaries\n\n- (TODO: list operator boundaries)\n` |
| `starter-v0/memory/snap-scope` | starter-v0/memory/invalid-scope-value | mutating | rewrites scope to nearest allowed value |
| `starter-v0/skill/snap-tier` | starter-v0/skill/invalid-tier-value | mutating | rewrites tier to T1/T2/T3 |
| `jsonc-starter-v0/config/add-plugins-stub` | jsonc/config/missing-plugins | additive | inserts empty `"plugins": { "entries": {} }` |
| `jsonc-starter-v0/config/redact-secret-literal` | jsonc/config/secret-as-literal | mutating | replaces literal token with `${SECRET_REF:...}` placeholder |
| `jsonl-starter-v0/session/append-terminal-event` | jsonl/session/no-terminal-event | additive | appends `{"event":"end",...}` line |
| `lobster-yaml-starter-v0/step/swap-shell-to-pipeline` | lobster/step/shell-tool-collision | mutating | rewrites `command:` key to `pipeline:` for in-process tool tokens |

7 starter fixers in v0. Each pairs with a pinch starter rule. Tier classification is auditable: `additive` is the default tier (operators don't think about it); `mutating`/`regenerative` require explicit operator opt-in.

## Goals

- One `OcPathFixerSpec` shape across all four file kinds.
- No new top-level CLI verb. The `openclaw doctor` surface is preserved; oc-doctor extends it via the existing plugin contract mechanism.
- Three-tier fixer classification (additive / mutating / regenerative) gives operators a sensible default + explicit opt-in for higher-blast-radius fixes.
- Cross-file fixers via `siblingFiles` — supports policy-regenerate-on-drift and similar checks that need workspace-wide context.
- Pairs one-for-one with pinch starter rules: every flag has a matching fix.

## Non goals

- A new operator-facing CLI verb. Operators run `openclaw doctor`; oc-doctor's fixers join that pipeline.
- Linting. That's pinch's job. Fixers MAY internally call detect() + fix() but the rule shape is separate.
- Schema enforcement. Fixers operate on shape/content; schema validation is a different abstraction.

## Integration into openclaw

This branch (`substrate/oc-doctor`) adds the substrate package + spec. The actual integration into `src/plugins/doctor-contract-registry.ts` is a small upstream contract addition:

1. **Extend `PluginDoctorContractEntry`** to optionally carry `ocPathFixers: OcPathFixerSpec[]`. Plugins that ship them populate the field; plugins that don't, don't.

2. **Doctor pipeline reads the field** — for each plugin's contract entry, if `ocPathFixers` is non-empty, dispatch them through the OcDoctor adapter. Findings join the existing doctor-output stream.

3. **No top-level CLI verb added** — `openclaw doctor` keeps its current surface; behavior expands.

This is the deferred contract addition. The substrate package itself can be reviewed and merged independently of the upstream pipeline change; the wiring is a follow-up PR.

## Open questions

- **Tier defaults**: today `additive` is the default; `mutating` / `regenerative` require flags. Maintainers may want to graduate specific fixers (e.g., trivially-safe normalizations) to default.
- **Fixer-rule pairing**: today the convention is "rule id `X/missing-Y`" pairs with "fixer id `X/insert-Y` or `X/snap-Y`". Loose convention; should it be enforced?
- **`registerOcPathFixer` duplicate-id semantics**: throw vs last-writer-wins? Today: throw (matching pinch's pattern).

## Test surface

- `packages/oc-doctor/tests/` — 537 tests across N files (claws-hapi side). Covers fixer-spec contract types, registry, three-tier classification, sibling-files access, the 7 starter fixers, idempotency assertions, test harness.
- Real-world validation: 25-fixture suite at `validation/` (claws-hapi side).

## Provenance

Drafted with Claude Opus 4.7 (1M context) by giodl@microsoft.com. Companion specs at `docs/reference/oc-paths-substrate-design.md` (PR-1 dependency), `docs/reference/pinch-lint-design.md` (PR-2 — pairs one-for-one with these fixers), `docs/reference/lkg-cage-design.md` (PR-4 sister substrate).
