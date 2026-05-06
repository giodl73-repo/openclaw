# `@openclaw/oc-path`

Substrate package for the openclaw workspace-walk + role-detection +
parsing layer. Backs the `openclaw path` verb and is consumed by
`openclaw-pinch`, `openclaw-cage`, `openclaw-policy`, and the doctor.

## What this package contains

- **Generic-MD AST** (`WorkspaceMdAst`, `AstBlock`, `AstItem`, `AstTable`, `AstCodeBlock`, `FrontmatterEntry`) — opinion-free addressing index over the 8 workspace files
- **OcPath types** + `parseOcPath` / `formatOcPath` / `isValidOcPath` — universal `oc://` addressing scheme
- **`parseWorkspaceMd(raw)`** — generic markdown parser; same parse path for all 8 workspace files (SOUL.md / AGENTS.md / MEMORY.md / TOOLS.md / IDENTITY.md / USER.md / HEARTBEAT.md / SKILL.md)
- **`resolveOcPath(ast, ocPath)`** — addressing index resolver (the load-bearing helper that lint rules and doctor fixers both consume)
- **`emit(ast)`** — byte-fidelity round-trip emitter with sentinel guard
- **`OcEmitSentinelError`** — substrate-level `__OPENCLAW_REDACTED__` rejection at the emit boundary

**Zero opinions about workspace-file content.** Per-file lint opinions ride in `oc-paths-lint` (PR-2). Doctor fixers ride in `oc-paths-doctor` (PR-3).

## Upstream destination map

Each prototype file maps 1:1 to its upstream destination. Transplant is `cp src/plugin-sdk/oc-path/* openclaw-core/src/plugin-sdk/oc-path/`.

| Prototype path | Upstream destination |
|---|---|
| `src/plugin-sdk/oc-path/oc-path.ts` | `openclaw-core/src/plugin-sdk/oc-path/oc-path.ts` |
| `src/plugin-sdk/oc-path/ast.ts` | `openclaw-core/src/plugin-sdk/oc-path/ast.ts` |
| `src/plugin-sdk/oc-path/parse.ts` | `openclaw-core/src/plugin-sdk/oc-path/parse.ts` |
| `src/plugin-sdk/oc-path/emit.ts` | `openclaw-core/src/plugin-sdk/oc-path/emit.ts` |
| `src/plugin-sdk/oc-path/resolve.ts` | `openclaw-core/src/plugin-sdk/oc-path/resolve.ts` |
| `src/plugin-sdk/oc-path/sentinel.ts` | `openclaw-core/src/plugin-sdk/oc-path/sentinel.ts` |
| `src/plugin-sdk/oc-path/slug.ts` | `openclaw-core/src/plugin-sdk/oc-path/slug.ts` |
| `src/plugin-sdk/oc-path/index.ts` | `openclaw-core/src/plugin-sdk/oc-path/index.ts` |
| `tests/plugin-sdk/oc-path/*.test.ts` | `openclaw-core/test/plugin-sdk/oc-path/*.test.ts` |
| `src/config-patches/io.ts.patch` | applies to `openclaw-core/src/config/io.ts` (chokepoint conversion at lines 1381 + 2082) |
| `src/config-patches/mutate.ts.patch` | applies to `openclaw-core/src/config/mutate.ts` (chokepoint conversion at line 112) |

## Build + test

```bash
npm run build  # tsc -p tsconfig.build.json
npm run test   # vitest run
```

## Status

Prototype shape lined up; tests pending. See [Phase 2 task #101](task://101) for tracking.
