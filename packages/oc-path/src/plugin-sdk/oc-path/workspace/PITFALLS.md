# Workspace Manifest Pitfalls

Pitfall IDs used inside the workspace-manifest module — by tests
(`tests/plugin-sdk/oc-path/workspace/manifest-adversarial.test.ts`),
inline `// W-NNN` comments, and consumer error messages.

**Scope**: ONLY the workspace-manifest layer (`buildWorkspaceManifest`,
`OPENCLAW_WORKSPACE_ROLES`, `roleForBasename`). This is a **separate
namespace** from:
  - `oc-paths-substrate/PITFALLS.md` (P-NNN — OcPath syntax / verb pitfalls)
  - `lkg-recovery-substrate/PITFALLS.md` (L-NNN — LKG substrate)
  - `lkg-recovery-git/PITFALLS.md` (G-NNN — git-backed LKG impl)

The W-NNN namespace is local to the manifest module. Each pitfall is
locked by at least one test. Status legend:

| Status | Meaning |
| --- | --- |
| MITIGATED | Manifest defends against this with a test that locks the behavior. |
| CALLER | Caller's responsibility, with a documented limit / surface. |
| DEFERRED | Known gap, scoped to a follow-up. |

## Path / traversal

| ID | Status | Pitfall |
| --- | --- | --- |
| W-001 | MITIGATED | Symlink to a file inside the workspace → `Dirent.isFile()` returns false for symlinks (Dirent reports the entry's own type, not the target's), so the walker silently skips it. Pre-empts path traversal via crafted symlinks pointing outside the workspace. |
| W-002 | MITIGATED | Symlink loop (e.g., `self → .`) → not entered for the same reason; no infinite walk possible. |
| W-003 | CALLER | The walker uses the workspace dir verbatim. Callers that need symlink resolution before walking should `realpath()` the dir themselves. The manifest has no opinion about how the workspace root was named. |

## Depth / DoS

| ID | Status | Pitfall |
| --- | --- | --- |
| W-040 | MITIGATED | Deeply nested directory (300+ levels) → walk stops at `MAX_WALK_DEPTH = 256`. Real workspaces don't nest beyond ~10 levels; the cap is generous but bounded. |
| W-041 | CALLER | Many files in one directory (millions) → `fs.readdir` returns them all in one shot; manifest entry array grows linearly. No memory cap. Callers operating on hostile-input workspaces should monitor memory or pre-filter. |

## Filename pathology

| ID | Status | Pitfall |
| --- | --- | --- |
| W-060 | MITIGATED | Filename containing oc-path-reserved chars (`?`, `&`, `%`, control chars) → synthesized `oc://...` URI fails `parseOcPath`; entry is silently dropped from the manifest. |
| W-061 | MITIGATED | Path producing an over-length oc-path (>4096 bytes when joined with `oc://` prefix + `relPath`) → `parseOcPath` throws `OC_PATH_TOO_LONG`; entry dropped. (Also frequently caught earlier by `MAX_WALK_DEPTH`.) |
| W-062 | CALLER | Filename containing characters illegal on the caller's filesystem (e.g., `<`, `>`, `:`, `\` on Windows). The manifest doesn't try to "fix" these — it walks what `fs.readdir` returns. |
| W-063 | CALLER | Unicode normalization mismatches between filesystem and consumer code. The manifest preserves the FS bytes verbatim; `parseOcPath` normalizes to NFC at the parse step. Cross-platform consumers should NFC-normalize their lookup keys. |

## Companion-pattern false positives

| ID | Status | Pitfall |
| --- | --- | --- |
| W-070 | MITIGATED | Filename like `data.clobbered.test.md` (legitimate user file, not an LKG companion) → the companion regex anchors on `.clobbered.<ISO-date>` (`\.clobbered\.\d{4}-\d{2}-\d{2}`), so user files with `.clobbered.` in the middle are NOT filtered. |
| W-071 | CALLER | Third-party tool that uses `.lkg` as its native extension → `endsWith('.lkg')` filters those too. Callers needing `.lkg` semantics for non-LKG files must use `extraRoles` with a custom role ID and a more specific matcher (the canonical filter still trumps). |
| W-072 | DEFERRED | Companion files that the LKG impl might add in the future (e.g., `.lkg.bak`, `.lkg.tmp`) → not currently filtered. Not a problem today; revisit when/if the LKG store grows new companion shapes. |

## Custom matcher safety

| ID | Status | Pitfall |
| --- | --- | --- |
| W-091 | MITIGATED | `extraRole.matchesBasename` throws → `findMatchingRole` wraps each call in try/catch; thrown predicate behaves like "no match" instead of crashing the whole walk. Defends self-host extensions that ship a buggy matcher. |
| W-092 | CALLER | Custom matcher with quadratic complexity over the basename (e.g., regex catastrophic backtracking) → not bounded. Callers ship matchers they trust; the manifest doesn't validate predicate runtime. |
| W-093 | CALLER | `extraRole.matchesBasename` is called once per file walked. Callers that need expensive role-membership checks should cache the predicate's results themselves. |

## Role precedence

| ID | Status | Pitfall |
| --- | --- | --- |
| W-052 | MITIGATED | `extraRoles` cannot override canonical role assignments. Canonical roles are checked first; the first matcher to return true wins. Locks the canonical → consumer contract: `AGENTS.md` always plays role `agents.md`. |
| W-053 | CALLER | Two `extraRoles` with overlapping matchers → first one in the array wins. Caller controls ordering. |

## Walk-time concurrency

| ID | Status | Pitfall |
| --- | --- | --- |
| W-020 | CALLER | A file is renamed/deleted between `readdir` and use → `readdir` returns a snapshot; the in-flight walk uses what was there at the time. The manifest reflects "what the workspace looked like during the walk," not a strongly consistent view. |
| W-021 | CALLER | Concurrent `buildWorkspaceManifest` calls on the same dir → both walk independently, both safe. Output may differ if files change between calls. The manifest has no internal coordination. |
| W-030 | MITIGATED | Permission denied on a subdirectory → the readdir try/catch silently skips it. The manifest contract is "best-effort tour," not "strict filesystem audit." |

## AbortSignal / cancellation

| ID | Status | Pitfall |
| --- | --- | --- |
| W-100 | MITIGATED | Pre-aborted signal → walk returns an empty manifest before any I/O. |
| W-101 | MITIGATED | Mid-walk abort → walk returns the partial manifest collected so far. The byKind / byRole counts reflect the partial state honestly. |

## Test mapping

Every pitfall above is exercised by at least one test in
`tests/plugin-sdk/oc-path/workspace/manifest-adversarial.test.ts` (or
the base `manifest.test.ts` for non-adversarial coverage). New
pitfalls land in this file AND a test simultaneously — neither side
moves alone.
