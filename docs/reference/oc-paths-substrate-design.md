# OcPath substrate — universal addressing for OpenClaw workspaces

Status: pre-RFC, drafting on the fork at `giodl73-repo/openclaw` for upstream feedback. Filed 2026-05-05 by giodl@microsoft.com / Microsoft.

## Summary

A new SDK package `@openclaw/oc-path` that gives every file the gateway treats as a workspace artifact a single addressing scheme: `oc://<file>[/<segment>...]`. Four file kinds (markdown, JSONC, JSONL, YAML) flow through one resolver, one setter, one workspace-walk verb, and one byte-stable round-trip. Plugins that today write bespoke parsers per file shape can flag, fix, or check anything in the workspace using the same three verbs (`resolveOcPath` / `setOcPath` / `findOcPaths`).

The substrate is **addressing-universal but encoding-per-kind**: the `oc://` URI is one shape; the AST behind it is a tagged union (`MdAst | JsoncAst | JsonlAst | YamlAst`) so kind-specific tools (markdown frontmatter, JSONC comments, JSONL line numbers, YAML anchors) keep their fidelity through emit. A substrate-level redaction sentinel is enforced at every emit boundary, closing the existing `__OPENCLAW_REDACTED__` literal-on-disk leak.

## Problem

OpenClaw today reads and writes four shapes of workspace artifact, each with ad-hoc handling:

1. **Markdown workspace files** (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `SKILL.md`). Bytes get read; `stripFrontMatter` discards the original on parse, so round-trip changes the file. Plugins that want to lint or fix anything in markdown write their own walker.
2. **JSONC config** (`openclaw.json`, plugin manifests). Writes go through `JSON.stringify(_, null, 2)` — eats user comments, eats key ordering, and writes redaction-sentinel literals to disk when a redacted view leaks through.
3. **JSONL session logs / audit / LKG checkpoints**. Line-oriented; consumers parse with hand-rolled readers; no shared addressing for "the third event in session X".
4. **YAML workflows** (`*.lobster`). Lobster's runtime parses these; users hit cryptic errors (`/bin/sh: 1: openclaw.invoke: not found`, see `openclaw/lobster #25 #26 #41`) because there's no static check before runtime.

These four shapes share neither addressing, parse-emit invariants, nor redaction guard. Every plugin that wants to flag a problem in any of them writes a bespoke walker. The gateway has no portable way to point an editor at "the offending node" without inventing a kind-specific path syntax. The `__OPENCLAW_REDACTED__` literal-on-disk regression is structural, not a bug fix you do once.

## What changes

### 1. The `OcPath` URI scheme

```
oc://<file>[/<segment1>[/<segment2>[/<segment3>]]][?session=<id>]
```

A 4-segment-max path (`file`, `section`, `item`, `field`). Each segment supports:

- **Insertion markers**: `+`, `+key`, `+nnn`
- **Wildcards** (find-only): `*` for one segment, `**` for zero-or-more
- **Positional tokens**: `$first`, `$last`, `-N`
- **Ordinal addressing**: `#0`, `#1` to disambiguate duplicate-slug items
- **Segment unions**: `{a,b,c}`
- **Value predicates**: `[key=val]`, `[key^=prefix]`, `[count<3]`, etc.
- **Quoted segments**: `"foo/bar"` for literal slashes
- **Kind-specific tokens**: `[frontmatter]` for MD, `Lnnn` for JSONL line addressing

The path syntax IS the type discriminator. A leaf path → string assignment. A `+`-suffixed path → insertion. A pattern-bearing path → `findOcPaths`. The substrate dispatches operation type from path syntax alone — callers don't pre-classify.

Every grammar feature traces to a real openclaw or lobster issue (evidence in the `findOcPaths` rule pack — `oc-doctor` PR is the consumer).

### 2. Tagged-union AST + universal verbs

```ts
type OcAst = MdAst | JsoncAst | JsonlAst | YamlAst;

resolveOcPath(ast: OcAst, path: OcPath): OcMatch | null;
setOcPath(ast: OcAst, path: OcPath, value: string): SetResult;
findOcPaths(ast: OcAst, pattern: OcPath): readonly OcPathMatch[];
```

Per-kind parsers and emitters (`parseMd` / `emitMd`, etc.) round-trip byte-for-byte: comments, key order, blank lines, frontmatter quoting all preserved. The redaction sentinel `__OPENCLAW_REDACTED__` is rejected at every `emit*` call — refuses to write the literal to disk. Defense in depth.

### 3. Workspace manifest

`buildWorkspaceManifest(rootDir)` walks the workspace, classifies each file by canonical role (`agents.md`, `tools.md`, `policy.jsonc`, `session.jsonl`, `*.lobster`, etc.), and returns a `WorkspaceManifest` keyed by `oc://` URIs. Lint, doctor, LKG, and policy substrates all consume this — single source of truth for "what's in the workspace".

### 4. `workspace.json` config loader

Optional file at workspace root. Each downstream substrate (lint, lkg, policy) owns its own section (`lint.skip[]`, `lkg.trackedRoles[]`, `policy.generators[]`, etc.). Loader uses `parseJsonc` so the file supports comments + trailing commas + key-order preservation — no JSON.parse footgun.

## Goals

- One `oc://` URI scheme per file, one resolve/set/find verb set, regardless of kind.
- Byte-stable round-trip for md / jsonc / jsonl / yaml. Emit a parsed AST and you get the original bytes (modulo edits you made).
- Substrate-level redaction sentinel at every emit boundary.
- Manifest-driven workspace walking so downstream substrates (lint/doctor/lkg/policy) all see the same file set.
- Workspace.json as the additive config surface — each substrate owns its own section.

## Non goals

- A new SDK API surface for plugins to declare their own file kinds. The four kinds (md, jsonc, jsonl, yaml) cover the openclaw artifact set today; adding a fifth is a future contract change.
- A general-purpose parsing toolkit. The substrate is sized for openclaw artifacts, not arbitrary Markdown / JSON / YAML in the wild.
- Eager workspace-wide indexing. The manifest is built on demand.

## Integration into openclaw

This branch (`substrate/oc-paths`) demonstrates four integration points:

1. **`openclaw path` CLI verb** — new `register.path.ts` in `src/cli/program/` adds `path resolve | set | find | validate | emit` subcommands. Operator-facing eval surface for oc-path expressions; analogous to `jq` for JSON.

2. **Replace `JSON.parse`/`stringify` on JSONC** at `src/config/io.ts` and `src/config/mutate.ts` with `parseJsonc`/`emitJsonc`. Closes the comment-eating bug; closes the `__OPENCLAW_REDACTED__`-on-disk regression because `emitJsonc` rejects sentinel-bearing values.

3. **Replace `loadWorkspaceBootstrapFiles`'s ad-hoc walker** with `buildWorkspaceManifest`. Same files, but every consumer now references `oc://` URIs in audit envelopes — cross-substrate correlation falls out free.

4. **Sentinel-DoS guardrail** at every `emit*` call. Closes `B1` from claws-side R2 review: refuse to write redacted-view bytes to disk no matter where they came from.

## Open questions

- **Where exactly does workspace.json live?** Workspace root is the obvious answer; CI-only / per-environment overlays are a v1 concern.
- **Sentinel byte vs string?** Today the sentinel is the literal string `__OPENCLAW_REDACTED__`. A byte-pattern would survive base64 round-trips at zero-cost — worth discussion.
- **Manifest caching**: today rebuild on every call. Memoize per-cwd? Probably v1.
- **Should the package live as a subpath of `@openclaw/plugin-sdk` instead of a top-level package?** Existing siblings (`@openclaw/sdk`, `@openclaw/memory-host-sdk`, `@openclaw/plugin-package-contract`) suggest top-level is fine, but maintainers may prefer subpath for plugin-author APIs.

## Test surface

- `packages/oc-path/tests/` — 743 tests across 46 files in the source repo (claws-hapi). Covers grammar parsing, AST verbs, per-kind round-trip, sentinel guard, manifest builder, workspace.json loader, and CLI bin.
- Real-world validation: 25-fixture suite at `validation/` runs the substrate against 13 community OpenClaw-shaped repos (zod, dyad, kitcn, hexis, stackflow, codebattle, banjo, dialtone, alkem-io-server, chordsheetjs, immich-discord-bot, aztec-editor-android, spec-to-agents, microsoft/spec-to-agents) plus 12 synthetic edge-case fixtures.

## Provenance

Drafted with Claude Opus 4.7 (1M context) by giodl@microsoft.com (claws monorepo / Microsoft). Full design narrative + sister substrate PRs (pinch lint, oc-doctor, lkg-cage, policy-anchoring) drafted at `lobster-docs` (Microsoft GHE internal); migration to public form lives on this fork's `substrate/*` branches.
