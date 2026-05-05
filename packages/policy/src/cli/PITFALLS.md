# openclaw-policy CLI Pitfalls

Pitfall IDs used inside the `openclaw-policy` CLI module — by tests
(`tests/cli/cli.test.ts`), inline `// CLI-POLICY-NNN` comments, and
consumer error messages.

**Scope**: ONLY the `openclaw-policy` CLI surface (argument parsing,
subcommand dispatch, I/O, output emit). This is a **separate
namespace** from:
  - `policy/PITFALLS.md` (POL-NNN — substrate / SDK)
  - `oc-path/src/cli/PITFALLS.md` (CLI-OCPATH-NNN — `openclaw-path` CLI)
  - `pinch/src/cli/PITFALLS.md` (CLI-PINCH-NNN — pinch CLI)

The CLI-POLICY-NNN namespace mirrors the CLI-PINCH-NNN /
CLI-OCPATH-NNN patterns so all openclaw CLIs share a consistent
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
| CLI-POLICY-001 | MITIGATED | Empty argv (`openclaw-policy`) → prints help, exits 0. (`CLI-12`) |
| CLI-POLICY-002 | MITIGATED | Unknown subcommand → exit 2 with structured error on stderr identifying the offending token. (`CLI-11`) |
| CLI-POLICY-003 | MITIGATED | Global `--json` / `--human` flags are stripped from argv **before** subcommand dispatch — they don't pollute positional parsing. `openclaw-policy --json check <path>` is equivalent to `openclaw-policy check <path>` with JSON output forced. |

## `check` mode detection

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-010 | MITIGATED | `check <file>` (positional resolves to a regular file) → **integrity-only** mode: recompute `policyId` over the body, compare to the claimed value. Exit 1 on mismatch. (`CLI-05`, `CLI-06`) |
| CLI-POLICY-011 | MITIGATED | `check <dir>` (positional resolves to a directory) → **workspace** mode: integrity AND drift. Loads `<dir>/policy.jsonc` (or `--policy <override>`), regenerates from sources, compares shape hash. (`CLI-13`, `CLI-14`) |
| CLI-POLICY-012 | MITIGATED | `check <dir> --no-drift` opts out of regeneration. Skips drift detection but still runs integrity. Useful for fast CI gates that only need the cheap check. (`CLI-15`) |
| CLI-POLICY-013 | MITIGATED | `check <dir> --policy <path>` overrides the default `<dir>/policy.jsonc` location. Useful when policy lives at a non-canonical path during migrations. (`CLI-17`) |
| CLI-POLICY-014 | MITIGATED | `check <dir>` returns exit 1 when **either** integrity OR drift fails. Consumers checking just `$?` cannot distinguish without parsing the JSON payload's `integrity.ok` / `drift.drifted` fields. (`CLI-14`, `CLI-16`) |
| CLI-POLICY-015 | CALLER | `check`'s drift detection regenerates with a **content-hash workspace anchor** (not a real LKG fingerprint). Shape hash equality is what's compared — the anchor only flows into `generatedFrom`, which is excluded from shape hash by design. So drift correctness doesn't depend on the anchor; drift correctness DOES depend on the same generator running both at write-time and at check-time. Use `--generator <id>` if a non-default generator wrote the policy. |

## `generate`

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-020 | MITIGATED | `generate <dir>` without `--out` returns the IR in the JSON payload (`json.ir`) but **does NOT** write to disk. Callers piping through `jq .ir > file.json` get equivalent behavior; `--out` is the convenience path. (`CLI-03`) |
| CLI-POLICY-021 | MITIGATED | `generate --out <path>` writes the IR with a trailing newline + 2-space pretty-print. Callers consuming the file via `JSON.parse` are unaffected; byte-diff consumers should normalize. (`CLI-04`) |
| CLI-POLICY-022 | MITIGATED | `generate --generator <unknown-id>` → exit 2 with `ERR_UNKNOWN_GENERATOR`. Use `list-generators` to see registered ids. (`CLI-02`) |
| CLI-POLICY-023 | CALLER | `generate`'s workspace anchor is computed from manifest bytes (sha256 of `relPath\0raw`-concatenated streams). This is a **convenience** for the CLI; production hosts using the registered generator directly should thread an actual `LKGFingerprint` from `LKGStore.observe()` so `generatedFrom` matches the LKG-tracked observation. (See POL-070.) |

## `evaluate`

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-030 | MITIGATED | `evaluate <ir-path> <tool-id>` requires both positional args. Missing either → exit 2 with `ERR_USAGE`. |
| CLI-POLICY-031 | MITIGATED | `evaluate ... --args <json>` requires the value to parse as JSON. Malformed JSON → exit 2 with `ERR_PARSE`. |
| CLI-POLICY-032 | MITIGATED | Unknown tool produces `decision.kind === 'deny'` per closed-world (POL-020). Exit code is **0** because the CLI succeeded — denial is a legitimate decision, not an error. Consumers wanting "fail on deny" should grep `json.decision.kind` themselves. (`CLI-08`) |
| CLI-POLICY-033 | MITIGATED | Tag-deny matching requires **all keywords** in `--args` content. The deny tag `*never*share*restricted*` requires `never` AND `share` AND `restricted` to all appear (case-insensitive) in the stringified args. Test inputs missing one keyword silently pass through. (`CLI-09`, `ED-06`) |

## `diff`

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-040 | MITIGATED | `diff <a.json> <b.json>` requires two positional args. Missing one → exit 2 with `ERR_USAGE`. |
| CLI-POLICY-041 | MITIGATED | The diff is **semantic** (added / removed / modified by `id`), not byte. Two IRs with reordered tool arrays produce no diff (since order isn't compared); two IRs with the same tool ids but different capabilities produce a `modified` entry. (`CLI-10`) |
| CLI-POLICY-042 | MITIGATED | `diff <a> <b> --detail` surfaces per-field changes for modified entries (`{field, before, after}` triples in JSON; indented lines in human mode). Without `--detail`, modified entries carry an empty `fields` array — JSON shape is stable across both modes. The `id` field is excluded from per-field output (used to align entries). (`CLI-18`, `CLI-19`, `CLI-20`) |

## I/O / output

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-050 | MITIGATED | Read failures (missing file, EACCES, etc.) → exit 2 with `ERR_IO` and a structured stderr payload. The error message is sentinel-scrubbed before printing. |
| CLI-POLICY-051 | MITIGATED | Parse failures (malformed JSON in IR or `--args`) → exit 2 with `ERR_PARSE`. |
| CLI-POLICY-052 | MITIGATED | `scrubSentinel(s)` replaces every occurrence of `__OPENCLAW_REDACTED__` with `[REDACTED]`. Pure unit-locked function exported so plugin authors writing their own subcommands can re-use it. Mirrors CLI-PINCH-033 / CLI-OCPATH-030. |
| CLI-POLICY-053 | MITIGATED | The `emit()` helper unconditionally calls `scrubSentinel(...)` on every payload — JSON and human paths. Defense-in-depth: even if a future subcommand surfaces raw file content, the CLI MUST NOT print sentinel bytes verbatim. Mirrors CLI-PINCH-034 / CLI-OCPATH-031. |
| CLI-POLICY-054 | MITIGATED | `emitError()` also scrubs error messages before writing to stderr. Pre-empts the leak path where a caller passed a sentinel-bearing path string and the parser's error message echoed it back. Mirrors CLI-OCPATH-032. |

## TTY / formatting

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-060 | MITIGATED | `--json` forces JSON output regardless of TTY detection; `--human` forces human-readable. Both flags are stripped before subcommand dispatch (CLI-POLICY-003). |
| CLI-POLICY-061 | MITIGATED | Broken-pipe writes (closed stdout mid-write, e.g., `openclaw-policy generate large-ws \| head -1`) are handled gracefully: every write goes through `safeWrite`, which catches sync EPIPE / EOF / ECONNRESET; the dispatcher installs an async `'error'` handler on stdout/stderr that swallows the same codes; the outer try/catch in `runCli` returns 0 on EPIPE rather than 2. `isClosedPipeError` is exported so plugin authors writing custom subcommands can re-use it. (`CLI-21`) |

## Caller obligations

| ID | Status | Pitfall |
| --- | --- | --- |
| CLI-POLICY-070 | CALLER | Exit-code semantics are stable: 0 success, 1 violation (tampered IR / drift / deny-as-error if a consumer wraps it), 2 usage / parse / I/O. CI scripts SHOULD `$?` rather than grep stderr — error formatting may evolve. Mirrors CLI-PINCH-051 / CLI-OCPATH-052. |
| CLI-POLICY-071 | CALLER | Output-boundary scrub is defense-in-depth (CLI-POLICY-052/053/054), NOT a substitute for substrate-level guards. Plugin authors writing custom generators that surface raw file content in error messages SHOULD scrub the content themselves before returning it; the CLI scrub is the last line, not the first. Mirrors CLI-OCPATH-051. |
| CLI-POLICY-072 | CALLER | The CLI's workspace anchor is **content-hash, not a real LKG fingerprint** (CLI-POLICY-015 / CLI-POLICY-023). Hosts using the generator directly in production paths MUST thread an actual `LKGFingerprint` from `LKGStore.observe()` — the CLI's convenience anchor is for shell-level workflows. |

## Test mapping

Every MITIGATED pitfall maps to a test case in `tests/cli/cli.test.ts`
(or, where cited, a substrate test). New pitfalls land here AND a
test simultaneously.
