# `openclaw pinch` lint framework — design

Status: pre-RFC, drafting on the fork at `giodl73-repo/openclaw`. Filed 2026-05-05 by giodl@microsoft.com / Microsoft. Depends on the OcPath substrate (`docs/reference/oc-paths-substrate-design.md`).

## Summary

A new SDK package `@openclaw/oc-lint` (consumer-facing brand: `pinch`) gives any plugin a single `LintRule` shape that flags problems across all four file kinds (md, jsonc, jsonl, yaml). Rules consume the universal `OcAst` from PR-1 and inspect via `findOcPaths` / `resolveOcPath` — kind-narrow logic is the documented exception, not the default. Four starter rule packs ship in v0, each sourced from real user-filed openclaw or lobster issues.

The CLI verb is `openclaw pinch run | lint | list-rules`. The Cargo:Clippy ↔ OpenClaw:Pinch precedent: `pinch` is the cute, themed brand; `@openclaw/oc-lint` is the technical-precise package identity.

## Problem

There's no shared way for a plugin to flag a problem in a workspace artifact today. Each plugin author writes a kind-specific walker if they want to lint anything. Recurring complaint classes that lack a shared dispatcher:

- **Workspace markdown** — frontmatter validation failures (#54310, #54311, #57091, #69475), missing required fields, invalid enum values
- **Gateway config (JSONC)** — duplicate top-level keys (#76619), missing required keys (#74462), secrets-as-literals (#65623, #62438)
- **Session logs (JSONL)** — empty / malformed sessions (#13700 cluster), missing canonical event keys, no-terminal-event signals interrupted recovery
- **Lobster workflows** — shell-tool collision (`command: openclaw.invoke` → `127: not found`, openclaw/lobster #25, #26, #41), duplicate step IDs (#76, #77), undefined stdin refs (#41), mutually-exclusive body fields (#41)

Without a shared `oc://` address vocabulary to point at the offending node, no shared severity model, and no shared dispatch, every rule gets re-invented.

## What changes

### 1. `LintRule` contract

```ts
interface LintRule {
  readonly id: string;                  // 'jsonc-starter-v0/config/missing-plugins'
  readonly severity: 'info' | 'warning' | 'error';
  readonly description: string;
  readonly appliesTo: string;           // 'AGENTS.md' | '*.jsonc' | '*.lobster' | '*'
  check(ctx: { fileName: string; ast: OcAst }): readonly LintFinding[];
}
```

`check` is pure: no I/O, no AST mutation, deterministic output. A rule that throws is treated as the rule author's bug — surfaced as a diagnostic with the rule's declared severity, doesn't abort the run.

Diagnostics carry an `oc://` path so editors, doctor, and fixers can deep-link to the offending node.

### 2. `registerLintRule` SDK verb

```ts
api.registerLintRule(rule: LintRule): void;
```

One new verb. Plugin authors call it at module-init time; the global registry collects rules and the runner dispatches based on `appliesTo`.

### 3. `runLint` runner

```ts
runLint(opts: LintRunOptions): LintRunResult
```

Walks files, matches `appliesTo` globs, dispatches rules, collects diagnostics. Pure function. The HOST is responsible for walking the workspace + parsing files. Canonical wiring consumes PR-1's `buildWorkspaceManifest`.

### 4. Four starter rule packs (v0)

| Pack | Kind | Rules | Source |
|------|------|-------|--------|
| `starter-v0` | md | 10 (agents/empty-tools-section, agents/missing-boundaries, tools/empty-guidance-table, memory/missing-frontmatter-scope, memory/invalid-scope-value, skill/missing-required-frontmatter, skill/invalid-tier-value, identity/missing-trust-level, user/missing-preferences-section, agents/duplicate-tool-key) | claws-side scenario waves |
| `jsonc-starter-v0` | jsonc | 5 (config/missing-plugins, config/empty-plugins-entries, config/missing-version, config/secret-as-literal, config/no-duplicate-top-level-keys) | issues #74462, #76619, #65623, #62438 |
| `jsonl-starter-v0` | jsonl | 4 (session/empty-log, session/missing-event-key, session/malformed-line, session/no-terminal-event) | #13700 cluster |
| `lobster-yaml-starter-v0` | yaml (`*.lobster`) | 4 (step/shell-tool-collision, step/mutually-exclusive-body, step/duplicate-id, step/undefined-stdin-ref) | openclaw/lobster #25, #26, #41, #76, #77 |

Of 23 total starter rules, 21 use only `findOcPaths` / `resolveOcPath` / `match.line` for addressing — kind-narrow is the exception, not the default. The two exceptions (`session/missing-event-key`, `session/malformed-line`) are content-shape introspection rules that need to ask "is this jsonl line a JSON object?" — documented explicitly as the case where kind-narrow is correct.

### 5. CLI: `openclaw pinch`

```
openclaw pinch run [--cwd <dir>] [--severity-min <level>] [--skip <id>]... [--only <pat>]... [--severity <id>=<level>]...
openclaw pinch lint <file...>
openclaw pinch list-rules [--pack <name>]
openclaw pinch help
```

The runner is purely an extension surface; rule packs grow as plugins land. `pinch run` walks the workspace via PR-1's manifest and dispatches every registered rule.

## Goals

- One `LintRule` shape across all four file kinds. Plugin authors learn the shape once.
- Diagnostics are `oc://` addressed — editor deep-link works without a kind-specific path syntax.
- Starter rules teach the universal addressing pattern (21 of 23 use only `findOcPaths` / `resolveOcPath`).
- `registerLintRule` as the only new SDK verb. Everything else is consumer code.
- workspace.json `lint` section: per-workspace overrides for `--skip` / `--severity` / `--only`.

## Non goals

- Auto-fixing. That's `oc-doctor`'s job (sister substrate); pinch is observe-only.
- Cross-file rules. Rules see one file's AST at a time. Cross-file invariants (e.g., "tool referenced in AGENTS.md must exist in TOOLS.md") need the `siblingFiles` extension that `oc-doctor` uses for fixers.
- Schema validation. Pinch is for shape-and-content rules, not "does this file conform to schema X" — that's a different abstraction.

## Integration into openclaw

This branch (`substrate/pinch`) demonstrates two integration points:

1. **`openclaw pinch` CLI verb** — new `register.pinch.ts` in `src/cli/program/` adds the `pinch` parent command with pass-through dispatch to the substrate's CLI runner. Same registration pattern as `register.path.ts` from PR-1.

2. **Workspace dep** — `@openclaw/oc-lint` added as a root workspace dep so the upstream CLI surface can import the substrate's `runCli`. Architectural caveat: this is one-way (upstream depends on the substrate) which differs from upstream's existing `packages/*` pattern (currently no upstream→packages deps in `src/`). Worth a maintainer-confirmation before merge.

## Open questions

- **Pack naming**: `starter-v0` for md, vs `jsonc-starter-v0` / `jsonl-starter-v0` for the others. Asymmetric. v1 may rename to `md-starter-v0` for consistency.
- **Severity defaults**: today every starter rule defaults to `info`. Maintainers may want to graduate specific rules (e.g., `lobster-yaml-starter-v0/step/shell-tool-collision`) to `error` — that's a community-signal call, not v0.
- **`registerLintRule` duplicate-id semantics**: throw vs last-writer-wins? Today: throw. Test helper `_clearLintRuleRegistry()` exists for tests.

## Test surface

- `packages/oc-lint/tests/` — 462 tests across 23 files. Covers contract types, registry, runner, all 4 starter packs, CLI argument parsing, severity overrides, output formatting (TTY-aware human/JSON), pipe-guard, sentinel scrub.
- Real-world validation: 25-fixture suite at `validation/` (claws-hapi side) runs the substrate against 13 community OpenClaw-shaped repos plus 12 synthetic edge-case fixtures. Triggers found: F-002 (3 of 4 lint packs unreachable from CLI bootstrap, fixed), F-003 (CLAUDE.md not in canonical roles, open), F-005 (secret-as-literal false-positive on zero-filled placeholder hashes, open).

## Provenance

Drafted with Claude Opus 4.7 (1M context) by giodl@microsoft.com. Companion specs at `docs/reference/oc-paths-substrate-design.md` (PR-1 dependency) and `docs/reference/oc-doctor-design.md` (sister substrate).
