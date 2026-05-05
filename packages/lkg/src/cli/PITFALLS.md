# openclaw-cage CLI Pitfalls

Pitfall IDs used inside the `openclaw-cage` CLI module — by tests
(`tests/cli/cli.test.ts`), inline `// CLI-LKG-NNN` comments, and
consumer error messages.

**Scope**: ONLY the `openclaw-cage` CLI surface (argument parsing,
subcommand dispatch, I/O, output emit). This is a **separate
namespace** from:
  - `lkg/PITFALLS.md` (LKG-NNN — recovery semantics, observe contract)
  - `oc-path/src/cli/PITFALLS.md` (CLI-OCPATH-NNN — `openclaw-path` CLI)
  - `pinch/src/cli/PITFALLS.md` (CLI-PINCH-NNN — pinch CLI)
  - `policy-substrate/src/cli/PITFALLS.md` (CLI-POLICY-NNN — `openclaw-policy` CLI)

The CLI-LKG-NNN namespace mirrors the CLI-PINCH / CLI-OCPATH /
CLI-POLICY patterns so all four openclaw CLIs share a consistent
adversarial story. Each pitfall is locked by at least one test.
Status legend:

| Status | Meaning |
| --- | --- |
| MITIGATED | CLI defends against this with a test that locks the behavior. |
| CALLER | Caller's responsibility, with a documented limit / surface. |
| DEFERRED | Known gap, scoped to a follow-up. |

## Argument parsing

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-001 | MITIGATED | Empty argv (`openclaw-cage`) → prints help, exits 0. (`CLI-LKG-10`) |
| CLI-LKG-002 | MITIGATED | Unknown subcommand → exit 2 with structured error on stderr identifying the offending token. (`CLI-LKG-09`) |
| CLI-LKG-003 | MITIGATED | Global `--json` / `--human` flags are stripped from argv **before** subcommand dispatch — they don't pollute positional parsing. |

## Workspace observation

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-010 | MITIGATED | `status [<workspace-dir>]` defaults workspace to `process.cwd()` when no positional arg is given. (`CLI-LKG-03`) |
| CLI-LKG-011 | MITIGATED | `list-trackers` reports the **walked** file count separately from the **tracked** count — `walked` is what the manifest saw; `tracked` is the subset matching canonical roles. Operators debugging "why doesn't this file show up?" check both. (`CLI-LKG-02`) |
| CLI-LKG-012 | MITIGATED | `status` exit code: 0 if every observation produced a known-good outcome (`valid`, `promoted`, `recovered`, `skipped`); 1 if at least one `failed`. (`CLI-LKG-03`) |
| CLI-LKG-013 | DEFERRED | `status` doesn't currently support a `--filter <role>` flag to limit which canonical artifacts are observed. Useful when an operator wants to debug just `policy.jsonc` without re-observing the rest. Add when a real consumer hits it. |

## `observe` subcommand

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-020 | MITIGATED | `observe <file>` requires the positional. Missing → exit 2 with `ERR_USAGE`. (`CLI-LKG-06`) |
| CLI-LKG-021 | MITIGATED | `observe <file>` rejects files NOT in the canonical openclaw artifact list (`ERR_NOT_TRACKED`, exit 2). The LKG store is opinionated about which roles are tracked — observing arbitrary bytes is not the use case. (`CLI-LKG-07`) |
| CLI-LKG-022 | MITIGATED | `observe <file> --root <workspace-dir>` overrides the implicit `process.cwd()` workspace. Useful when invoking from outside the workspace. (`CLI-LKG-08`) |
| CLI-LKG-023 | MITIGATED | `observe`'s exit code mirrors the LKGObservation outcome: 0 for valid/promoted/recovered/skipped, 1 for `failed`. (`CLI-LKG-08`) |

## `fingerprint` subcommand

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-030 | MITIGATED | `fingerprint <file>` returns lowercase-hex sha256 over the raw file bytes — does NOT touch any LKG state. Useful for verifying that two copies of a file match across machines / branches. (`CLI-LKG-04`) |
| CLI-LKG-031 | MITIGATED | `fingerprint` without `<file>` → exit 2 with `ERR_USAGE`. (`CLI-LKG-05`) |
| CLI-LKG-032 | MITIGATED | `fingerprint`'s human-mode output format is `<hash>  <path>  (<bytes> bytes)` — single line, suitable for `tee`-into-checksum-file workflows. The shape mirrors `sha256sum`. |

## I/O / output

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-040 | MITIGATED | Read failures (missing file, EACCES, etc.) → exit 2 with `ERR_IO` and a structured stderr payload. The error message is sentinel-scrubbed. |
| CLI-LKG-041 | MITIGATED | `scrubSentinel(s)` replaces every occurrence of `__OPENCLAW_REDACTED__` with `[REDACTED]`. Pure unit-locked function exported so plugin authors writing their own subcommands can re-use it. Mirrors CLI-PINCH-033 / CLI-OCPATH-030 / CLI-POLICY-052. |
| CLI-LKG-042 | MITIGATED | The `emit()` helper unconditionally calls `scrubSentinel(...)` on every payload — JSON and human paths. Defense-in-depth: even if a future subcommand surfaces raw bytes (e.g., `cat <file>`-style verb), the CLI MUST NOT print sentinel bytes verbatim. |
| CLI-LKG-043 | MITIGATED | `emitError()` also scrubs error messages before writing to stderr. Pre-empts the leak path where a caller passed a sentinel-bearing path string and the parser's error message echoed it back. |

## TTY / formatting

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-050 | MITIGATED | `--json` forces JSON output regardless of TTY detection; `--human` forces human-readable. Both flags are stripped before subcommand dispatch (CLI-LKG-003). |
| CLI-LKG-051 | MITIGATED | Closed-pipe writes (sync EPIPE / EOF / ECONNRESET) are caught at the per-write boundary via `safeWrite`; async EPIPE on the `'error'` event is swallowed by `installPipeGuard`. The dispatcher's outer try/catch returns 0 on EPIPE rather than 2. Mirrors CLI-POLICY-061. (`CLI-LKG-11`) |

## Caller obligations

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-LKG-060 | CALLER | Exit-code semantics are stable: 0 success, 1 violation (failed observation), 2 usage / parse / I/O. CI scripts SHOULD `$?` rather than grep stderr — error formatting may evolve. Mirrors CLI-PINCH-051 / CLI-OCPATH-052 / CLI-POLICY-070. |
| CLI-LKG-061 | CALLER | The CLI is a thin shell around `LKGStore.observe()` — it is NOT a control plane. Production hosts wire trackers + observations directly via the SDK; the CLI exists for operator debugging, audit-log review, and CI integration. |
| CLI-LKG-062 | CALLER | `status` and `observe` re-walk the manifest on every invocation — there's no shared cache between subcommands. CI pipelines running `status` then `observe` pay the walk cost twice; for tight loops, drive the SDK directly. |

## Test mapping

Every MITIGATED pitfall maps to a test case in `tests/cli/cli.test.ts`.
New pitfalls land here AND a test simultaneously.
