# LKG Recovery Git Pitfalls

Pitfall IDs used inside this package — by tests, by inline `// G-NNN`
comments, and by error messages.

**Scope**: ONLY the git-backed `LKGStore` impl. This is a **separate
namespace** from:
  - `lkg/PITFALLS.md` (L-NNN — substrate contracts +
    FS-backed reference impl)
  - `oc-path/PITFALLS.md` (P-NNN — OcPath syntax / verb
    pitfalls)
  - claws-side `docs/PITFALLS.md` (P-NNN — broader governance taxonomy)

The package boundary disambiguates the prefix.

The git store inherits the substrate-level contract — most of the
L-NNN guarantees (path validation, sentinel guard, abort threading,
err scrub, ocPath threading) hold the same way here, just dispatched
through `git commit` / `git checkout HEAD` instead of `.lkg`
companions. This file lists git-SPECIFIC pitfalls; for the universal
ones, see `lkg/PITFALLS.md`.

Each pitfall is locked by at least one test. `MITIGATED` = store
defends; `REJECTED` = `LKGError` thrown; `CALLER` = caller's
responsibility, documented limit; `DEFERRED` = v1+ work.

## Repo / registration

| ID | Status | Pitfall |
| --- | --- | --- |
| G-001 | REJECTED | `repoRoot` must be `git init`-ed by the caller. The store does not auto-init. |
| G-002 | REJECTED | Tracker path outside `repoRoot` → `LKG_TRACKER_PATH_INVALID` (defaults to enforce; opt-out via `forbidPathsOutsideRoot: false`) |
| G-003 | REJECTED | Same path registered twice → `LKG_TRACKER_PATH_COLLISION` |
| G-004 | CALLER | Multi-tenant collisions: callers instantiate one `GitLKGStore` per tenant scope. Cross-tenant collisions are structurally impossible. |
| G-005 | CALLER | `core.autocrlf=true` on the host config will mangle byte-level round trips on Windows. Tests pin `core.autocrlf=false` + `core.eol=lf` per-repo; production callers should do the same when they care about byte-exact recovery. |

## Sentinel guard (cross-cut with L-A2/B4)

| ID | Status | Pitfall |
| --- | --- | --- |
| G-010 | MITIGATED | Active file bytes contain `__OPENCLAW_REDACTED__` → refused at observe; never committed. |
| G-011 | MITIGATED | Substring-form sentinel (`prefix__OPENCLAW_REDACTED__suffix`) refused. |
| G-012 | MITIGATED | Defense-in-depth: HEAD bytes containing the sentinel (writer-side bug bypassed observe-side guard) → recover refuses with `lkg-companion-poisoned`. |

## Promote / recover

| ID | Status | Pitfall |
| --- | --- | --- |
| G-020 | MITIGATED | First-time observe on a fresh repo with valid bytes → commits to HEAD. Outcome = `promoted`. |
| G-021 | MITIGATED | Re-observe of unchanged bytes does NOT create a duplicate commit (HEAD blob sha already matches). Outcome = `valid`. |
| G-022 | MITIGATED | Invalid bytes WITH a prior HEAD commit → `git checkout HEAD -- <relPath>` restores; bad bytes preserved at `.clobbered.<ts>`. |
| G-023 | MITIGATED | Invalid bytes WITHOUT a prior HEAD commit → `outcome: 'skipped'` with `'no-lkg-available'`. |
| G-024 | MITIGATED | `tracker.shouldRecover` returns false → skipped with `plugin-local-invalidity` (host degrades around the broken portion). |
| G-025 | MITIGATED | Concurrent identical-content writes from two trackers in the same repo → same git blob sha → no contention in `.git/objects/`. The git CAS gives free deduplication; the FS-backed store does not. |
| G-026 | CALLER | Concurrent observes of the SAME path: ref updates serialize through git's lockfile, but the working-tree write that immediately precedes the commit is NOT serialized. Callers either single-thread observes per path OR accept last-write-wins on the working tree. |

## AbortSignal / cancellation

| ID | Status | Pitfall |
| --- | --- | --- |
| G-030 | MITIGATED | Pre-aborted observe returns `failed-aborted` before reading (no fs hit, no git invocation). |
| G-031 | MITIGATED | `readLastKnownGood` with pre-aborted signal throws `LKGError(LKG_ABORTED)`. |
| G-032 | MITIGATED | Abort checked before commit (between validate and `git add`). Abort during `git checkout HEAD` is not interrupted — git's own retry semantics apply. |

## OcPath integration (cross-cut with L-OcPathIntegration)

| ID | Status | Pitfall |
| --- | --- | --- |
| G-040 | MITIGATED | Tracker without `ocPath` declared → audit events carry only filesystem path. Backward-compatible. |
| G-041 | MITIGATED | Tracker with `ocPath` → every observation outcome AND audit envelope carries the workspace-relative URI. |
| G-042 | MITIGATED | `shouldRecover` snapshot includes `parsed: TParsed` so kind-specific predicates can run oc-paths queries against the parsed AST. |

## Bounding box

| ID | Status | Pitfall |
| --- | --- | --- |
| G-050 | MITIGATED | All four oc-paths kinds (md / jsonc / jsonl / yaml/.lobster) round-trip through promote → corrupt → recover. The mechanism is byte-level (git blob sha), so kind-agnosticism is structural; `tests/extensions/lkg-git/bounding-box.test.ts` locks the claim with one round-trip per kind. |
| G-051 | MITIGATED | Content-addressable parity: identical bytes across two tracker paths in the same repo produce identical blob shas. This is the deduplication property the FS-backed store does not have. |
| G-052 | MITIGATED | `.clobbered.<ts>` files are written outside git's index — they don't pollute the LKG history. (Callers who want long-term forensic retention add `.clobbered.*` to a tracked path, but the default is "ignored from git's view".) |

## Surface narrowing (cross-cut with L-D1)

| ID | Status | Pitfall |
| --- | --- | --- |
| G-060 | MITIGATED | The `git` / `gitBinary` invokers are NOT exported from `@openclaw/lkg-git`. Callers that need to shell out to git use `node:child_process` (or a vetted wrapper) directly so the store's invocation policy can evolve without breaking consumers. |

## Deferred / v1+

| ID | Status | Pitfall |
| --- | --- | --- |
| G-100 | DEFERRED | Three-way merge: when an upstream agent's commit and a local edit both promote different bytes for the same tracker, the store currently last-write-wins on commit. v1+ explores `git merge -X theirs/ours` with policy-driven conflict resolution. |
| G-101 | DEFERRED | Pack / gc tuning: the store does not configure `gc.auto`. Long-running deployments may want to schedule gc to keep `.git/` size bounded. |
| G-102 | DEFERRED | Submodule / worktree handling: the current store assumes a flat work tree. Nested `.git` dirs (submodules, worktrees) are out of scope for v0. |
| G-103 | DEFERRED | Signed commits: no GPG/SSH signing on LKG-produced commits. Compliance deployments may want host-policy enforcement; out of scope for v0. |

## Test mapping

Every entry above maps to one or more test cases. New pitfalls land
here AND in tests simultaneously — neither side moves alone.
