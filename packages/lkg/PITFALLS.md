# LKG Recovery Substrate Pitfalls

Pitfall IDs used inside this package — by tests, by inline `// L-NNN`
comments, and by error messages.

**Scope**: ONLY the LKG recovery substrate's pitfall taxonomy. This is
a **separate namespace** from:
  - `oc-path/PITFALLS.md` (P-NNN — OcPath syntax / verb pitfalls)
  - claws-side `docs/PITFALLS.md` (P-NNN — broader governance taxonomy)

The package boundary disambiguates the prefix.

Each pitfall is locked by at least one test. `MITIGATED` = substrate
defends; `REJECTED` = the store rejects with `LKGError`; `CALLER` =
caller's responsibility, documented limit; `DEFERRED` = v1+ work,
currently a documented gap.

## Path / registration

| ID | Status | Pitfall |
| --- | --- | --- |
| L-001 | REJECTED | Tracker registered with non-absolute path → `LKG_TRACKER_PATH_INVALID` |
| L-002 | REJECTED | Tracker path outside store root → `LKG_TRACKER_PATH_INVALID` (defaults to enforce; callers can opt out via `forbidPathsOutsideRoot: false`) |
| L-003 | REJECTED | Same path registered twice → `LKG_TRACKER_PATH_COLLISION` |
| L-004 | CALLER | Multi-tenant collisions: callers instantiate one `FsLKGStore` per tenant scope. The contract has no `tenantId` argument; cross-tenant collisions are structurally impossible. |

## Read / parse / validate

| ID | Status | Pitfall |
| --- | --- | --- |
| L-010 | MITIGATED | Read failure on `observe` → `outcome: 'failed'` with diagnostic; audit-recorded |
| L-011 | MITIGATED | Tracker `parse` throws → `outcome: 'failed'` with scrubbed reason (sentinel-refusal + control-char strip + 256-byte cap) |
| L-012 | MITIGATED | Tracker `validate` throws → `outcome: 'failed'` with scrubbed reason. Validator failures on secret-bearing parsed values can't leak through audit. |

## Sentinel guard (cross-cut with `oc-path`)

| ID | Status | Pitfall |
| --- | --- | --- |
| L-020 | MITIGATED | Active file bytes contain `__OPENCLAW_REDACTED__` → refused at observe; never promoted as known-good |
| L-021 | MITIGATED | Substring-form sentinel (`prefix__OPENCLAW_REDACTED__suffix`) refused — same threat model as the substrate's emit-time guard (oc-paths A2 finding) |
| L-022 | MITIGATED | Defense-in-depth: hash-stable `.lkg` companion bearing the sentinel is refused at recover (catches a pathological case where a poisoned companion was promoted before this guard existed) |

## Promote / recover

| ID | Status | Pitfall |
| --- | --- | --- |
| L-030 | MITIGATED | `.lkg` companion hash drift (someone tampered with the file) → recovery refuses with `lkg-companion-tampered` |
| L-031 | MITIGATED | `.lkg` companion missing → `outcome: 'skipped'` with `'no-lkg-available'` (first-invalid-observe with no fallback) |
| L-032 | MITIGATED | `tracker.shouldRecover` returns false → skipped with `plugin-local-invalidity` (host degrades around the broken portion instead of whole-file recovery) |
| L-033 | MITIGATED | Atomic-ish promote: write to `.lkg.tmp`, then rename. Crash mid-rename is recovered next observe (next read sees old `.lkg`, current is still the bad bytes; recover proceeds). |
| L-034 | CALLER | Concurrent observes of the same path: the store has no internal lock. Callers either single-thread observes per path OR accept the FS racing semantics (last-rename-wins for the `.lkg` companion). |

## AbortSignal / cancellation

| ID | Status | Pitfall |
| --- | --- | --- |
| L-040 | MITIGATED | Pre-aborted observe returns `failed-aborted` before reading (no fs hit) |
| L-041 | MITIGATED | Mid-observe abort: signal checked between every I/O boundary (read, parse, validate, promote-write, recover-write) |
| L-042 | MITIGATED | `readLastKnownGood` with pre-aborted signal throws `LKGError(LKG_ABORTED)` |

## OcPath integration (cross-cut)

| ID | Status | Pitfall |
| --- | --- | --- |
| L-050 | MITIGATED | Tracker without `ocPath` declared → audit events carry only filesystem path (no synthesized `oc://` field). Backward-compatible. |
| L-051 | MITIGATED | Tracker with `ocPath` → every observation outcome AND audit envelope carries the workspace-relative URI for cross-substrate correlation. |
| L-052 | CALLER | If the tracker's filesystem `path` and `ocPath.file` disagree (e.g., `path = '/abs/foo.jsonc'` but `ocPath` formats as `oc://bar.jsonc`), the store doesn't reconcile — the audit shows what the tracker declared. |

## Bounding box

| ID | Status | Pitfall |
| --- | --- | --- |
| L-060 | MITIGATED | All four oc-paths kinds (md / jsonc / jsonl / yaml/.lobster) round-trip through promote → corrupt → recover. The mechanism is byte-level, so kind-agnosticism is structural; `tests/extensions/lkg-fs/bounding-box.test.ts` locks the claim with one round-trip per kind. |
| L-061 | MITIGATED | Companion-path conventions (`.lkg`, `.clobbered.<ts>`) APPEND rather than replacing the original extension — `AGENTS.md.lkg`, `gateway.jsonc.lkg`, `session.jsonl.lkg`, `wf.lobster.lkg` all coexist cleanly. |

## Deferred / v1+

| ID | Status | Pitfall |
| --- | --- | --- |
| L-100 | DEFERRED | Cross-tracker invariants (e.g., "if config and policy disagree on `gateway.mode`, suspicious") — no shape for these in v0. Per-tracker heuristics work. |
| L-101 | DEFERRED | `attestation` slot enforcement: contract carries the slot, doesn't require populating it. Compliance-grade deployments want host-policy enforcement; out of scope for v0. |
| L-102 | DEFERRED | State-file granularity: shared `lkg-health.json` namespace-keyed by tracker path vs one file per tracker vs pluggable persistence. v0 picks shared-file (mirrors upstream's existing config-LKG shape). |
| L-103 | DEFERRED | Suspicious-reasons composability across trackers — v0 only supports per-tracker. |

## Test mapping

Every entry above maps to one or more test cases. New pitfalls land
here AND in tests simultaneously — neither side moves alone.
