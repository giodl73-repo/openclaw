# pinch CLI Pitfalls

Pitfall IDs used inside the pinch CLI module — by tests
(`tests/cli/cli-adversarial.test.ts`), inline `// CLI-PINCH-NNN`
comments, and consumer error messages.

**Scope**: ONLY the `pinch` CLI surface (argument parsing, dispatch,
I/O layer, output emit). This is a **separate namespace** from:
  - `pinch/PITFALLS.md` (top-level lint-runner pitfalls if/when added)
  - `oc-path/PITFALLS.md` (P-NNN — OcPath syntax)
  - `oc-path/src/plugin-sdk/oc-path/workspace/PITFALLS.md` (W-NNN — manifest walker)
  - `oc-path/src/cli/PITFALLS.md` (CLI-OCPATH-NNN — `openclaw-path` CLI; **TODO**)

The CLI-PINCH-NNN namespace is local to the pinch CLI. Each pitfall
is locked by at least one test. Status legend:

| Status | Meaning |
| --- | --- |
| MITIGATED | CLI defends against this with a test that locks the behavior. |
| CALLER | Caller's responsibility, with a documented limit / surface. |
| DEFERRED | Known gap, scoped to a follow-up. |

## Argument parsing

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-PINCH-001 | MITIGATED | First arg is an unknown flag (`pinch --bogus`) → stripped or rejected: global flags `--json` / `--human` are filtered before subcommand dispatch; unknown flags fall through to the subcommand slot and produce `unknown subcommand → exit 2`. |
| CLI-PINCH-002 | MITIGATED | Empty argv (`pinch`) → prints help, exits 0. Combined with the global-flag stripping: `pinch --json` is the same as `pinch --json help`. |
| CLI-PINCH-003 | MITIGATED | Unknown subcommand (typo, e.g., `pinch pintch`) → exit 2 with a structured error payload that identifies the offending token. |

## I/O failures

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-PINCH-010 | MITIGATED | `pinch lint <file>` on a missing file → I/O error caught, exit 2 with a structured error. |
| CLI-PINCH-011 | MITIGATED | `pinch run <missing-dir>` → manifest walker is best-effort (returns empty for unreadable dirs), exit 0 with `filesLinted: 0`. Behavior matches the manifest-side W-030 pitfall. |
| CLI-PINCH-012 | MITIGATED | `pinch lint <file.unknown>` → kind cannot be inferred from extension; exit 2 with a structured error. |
| CLI-PINCH-013 | DEFERRED | Workspace dir is a regular file (not a dir) — current behavior likely matches W-030 (silent skip), but no specific test. Add when a real consumer hits it. |

## Exit code semantics

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-PINCH-020 | MITIGATED | Only info-severity findings → exit 0 (info findings are surfaced but don't fail the run). Matches the convention used by lint runners across the ecosystem. |
| CLI-PINCH-021 | MITIGATED | `--severity-min warning` filters info-severity findings out of the diagnostics list AND adjusts exit code accordingly. |
| CLI-PINCH-022 | MITIGATED | Invalid `--severity-min` value (e.g., `--severity-min blah`) → silently defaults to 0 (info). No-op rather than a noisy error so misconfigured CI scripts don't block on parse-of-flag-value alone. |
| CLI-PINCH-023 | DEFERRED | Cancel via SIGINT / AbortSignal: not currently threaded through the runner from the CLI. Behavior on Ctrl-C is "node default" (immediate exit). Wire AbortSignal through `runCli` when a long-running test surface needs cancellation. |

## Output / TTY

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-PINCH-030 | MITIGATED | `--json` forces JSON output regardless of TTY detection. |
| CLI-PINCH-031 | MITIGATED | `--human` forces human-readable output regardless of TTY detection. Both flags are stripped from argv before subcommand dispatch so they don't pollute positional handling. |
| CLI-PINCH-032 | MITIGATED | Sentinel-in-content + clean run produces no leaked sentinel on stdout (current state — no starter rule echoes raw content; the unconditional scrub provides defense-in-depth). |
| CLI-PINCH-033 | MITIGATED | `scrubSentinel(s)` replaces every occurrence of `__OPENCLAW_REDACTED__` with `[REDACTED]`. Pure unit-locked function; exported so plugin authors writing their own CLI subcommands can re-use it. |
| CLI-PINCH-034 | MITIGATED | The emit helper unconditionally calls `scrubSentinel(...)` on every output (JSON and human paths). Regression test guards against accidental removal of the wrap. |
| CLI-PINCH-035 | DEFERRED | Broken-pipe handling (closed stdout mid-write, e.g., `pinch run | head -1`) → not currently handled. Node's default behavior is to throw EPIPE; the CLI catches at the dispatcher and exits 2. Document for now; wire graceful handling when a real consumer hits it. |

## Workspace conventions

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-PINCH-040 | MITIGATED | `pinch lint <file>` on a non-canonical-named markdown file (e.g., `notes.md`) parses successfully; the runner's `appliesTo` glob filters which rules fire. The CLI doesn't reject non-canonical names — that's a manifest-side concern. |
| CLI-PINCH-041 | MITIGATED | `pinch run <dir>` skips `.git`, `node_modules`, `dist`, etc. (per the manifest's default `skipDirNames`). Buried `AGENTS.md` files inside skipped dirs do NOT show up as findings. |

## Caller obligations

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-PINCH-050 | CALLER | Output-boundary scrub is defense-in-depth, not a substitute for the substrate's emit-time guard. Callers writing plugin rules that surface raw file content in diagnostic messages SHOULD scrub the content themselves before returning it to the runner; the CLI scrub is the last line, not the first. |
| CLI-PINCH-051 | CALLER | Exit-code semantics (0 / 1 / 2) are stable and CI-friendly; don't grep stderr for status — use `$?`. |

## Test mapping

Every pitfall above maps to one or more test cases. Locked status
(MITIGATED) requires at least one passing test; CALLER and DEFERRED
entries don't require tests but DO require the comment in code or
this document. New pitfalls land here AND a test simultaneously.
