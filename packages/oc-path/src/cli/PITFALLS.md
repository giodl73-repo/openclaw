# openclaw-path CLI Pitfalls

Pitfall IDs used inside the `openclaw-path` CLI module — by tests
(`tests/cli/cli-adversarial.test.ts`), inline `// CLI-OCPATH-NNN`
comments, and consumer error messages.

**Scope**: ONLY the `openclaw-path` CLI surface (argument parsing,
subcommand dispatch, I/O, output emit). This is a **separate
namespace** from:
  - `oc-paths-substrate/PITFALLS.md` (P-NNN — OcPath syntax / verb pitfalls)
  - `oc-paths-substrate/src/plugin-sdk/oc-path/workspace/PITFALLS.md` (W-NNN — manifest walker)
  - `pinch/src/cli/PITFALLS.md` (CLI-PINCH-NNN — pinch CLI)

The CLI-OCPATH-NNN namespace mirrors the CLI-PINCH-NNN pattern so
both CLI surfaces share a consistent adversarial story. Each pitfall
is locked by at least one test. Status legend:

| Status | Meaning |
| --- | --- |
| MITIGATED | CLI defends against this with a test that locks the behavior. |
| CALLER | Caller's responsibility, with a documented limit / surface. |
| DEFERRED | Known gap, scoped to a follow-up. |

## Argument parsing

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-OCPATH-001 | MITIGATED | Unknown subcommand → non-zero exit code with structured error on stderr. The error payload identifies the offending subcommand. |
| CLI-OCPATH-002 | MITIGATED | Empty argv (`openclaw-path`) → prints help, exits 0. Friendliest default; matches `git` / most modern CLI frameworks. |
| CLI-OCPATH-003 | MITIGATED | Subcommand without required positional (e.g., `validate` with no path) → non-zero exit with structured error. |

## I/O failures

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-OCPATH-010 | MITIGATED | `emit <missing-file>` → non-zero exit with a structured error on stderr. The error message is sentinel-scrubbed. |
| CLI-OCPATH-011 | MITIGATED | `resolve <oc-path> --cwd <missing-dir>` → non-zero exit; readFile error is caught and emitted as a structured error. |
| CLI-OCPATH-012 | MITIGATED | `set <oc-path> <value> --file <missing> --dry-run` → non-zero exit; even in dry-run mode the read pass fires before the dry-run barrier. |

## Output / TTY

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-OCPATH-020 | MITIGATED | `--json` forces JSON output regardless of TTY detection. Output is parseable as JSON. |
| CLI-OCPATH-021 | MITIGATED | `--human` forces human-readable output regardless of TTY. Subcommands that don't define a human formatter fall back to JSON; the flag still works without error. |

## Sentinel scrub at output boundary

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-OCPATH-030 | MITIGATED | `scrubSentinel(s)` replaces every occurrence of `__OPENCLAW_REDACTED__` with `[REDACTED]`. Pure unit-locked function; **exported** so other openclaw-CLI authors (pinch, future `openclaw lkg`, `openclaw policy`) can re-use it without re-implementing. |
| CLI-OCPATH-031 | MITIGATED | The `emit()` helper unconditionally calls `scrubSentinel(...)` on every payload — both JSON and human paths. Defense-in-depth: even if a future subcommand surfaces raw file content (e.g., `cat <file>`-style verb), the CLI MUST NOT print sentinel bytes verbatim. |
| CLI-OCPATH-032 | MITIGATED | `emitError()` also scrubs error messages before writing to stderr. Pre-empts the leak path where a caller passed a sentinel-bearing `oc://` path string and the parser's error message echoed it back. |

## Per-subcommand pitfalls

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-OCPATH-040 | MITIGATED | `set <oc-path>` without a value argument → non-zero exit. |
| CLI-OCPATH-041 | MITIGATED | `find <pattern>` with a malformed predicate (`[broken-predicate`) → parser rejects, non-zero exit. |
| CLI-OCPATH-042 | MITIGATED | `emit <file>` byte-fidelity round-trip on a clean md file — exit 0 + JSON-parseable result. Locks the round-trip claim that motivated shipping the `emit` subcommand in the first place. |

## Caller obligations

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-OCPATH-050 | CALLER | The CLI is **LKG-unaware** by design (v0). `set` writes raw bytes through the substrate emit — if the file is LKG-tracked, the next `LKGStore.observe()` decides whether to promote/recover. A `--via-lkg` flag is deferred to v1+ when the LKG package surfaces a public `batch` operation; until then, callers wanting LKG semantics must drive the LKG store themselves. `--dry-run` preserves bytes correctly. |
| CLI-OCPATH-051 | CALLER | Sentinel scrub at output is defense-in-depth, not a substitute for substrate-level guards. Callers writing rules / fixers / hooks that surface raw content SHOULD scrub the content themselves before returning it; the CLI scrub is the last line, not the first. |
| CLI-OCPATH-052 | CALLER | Exit-code semantics: non-zero on any error. Callers writing CI scripts should rely on `$?`, not stderr-grep, since error formatting may evolve. |

## Test mapping

Every pitfall above maps to a test case in
`tests/cli/cli-adversarial.test.ts`. New pitfalls land here AND a
test simultaneously — neither side moves alone.
