# OcPath Substrate Pitfalls

Pitfall IDs used inside this package — by `wave-23-pitfalls.test.ts`, by
inline `// P-NNN` comments in `find.ts`, `oc-path.ts`, and elsewhere.

**Scope**: ONLY the OcPath substrate's pitfall taxonomy. This is a
**separate namespace** from the claws-side governance taxonomy in
`/docs/PITFALLS.md` (which numbers a different set of pitfalls — e.g.,
P-033 there is "Memory poisoning"). The two namespaces deliberately
overlap in number range; the prefix context (`oc-paths-substrate/`
vs. claws root) disambiguates.

Each pitfall is locked by at least one test. `MITIGATED` = substrate
defends; `REJECTED` = parser/runner rejects with `OcPathError`;
`CALLER` = caller's responsibility, documented limit; `DEFERRED` = v1+
work, currently `.skip` placeholders in the test file.

## Encoding

| ID | Status | Pitfall |
| --- | --- | --- |
| P-001 | MITIGATED | Strips leading UTF-8 BOM from path string |
| P-002 | MITIGATED | Normalizes paths to Unicode NFC |
| P-003 | REJECTED | Whitespace in identifier-shaped segments |
| P-003 | MITIGATED | Whitespace allowed inside predicate values (content) |
| P-004 | REJECTED | Control characters and null bytes |
| P-005 | DEFERRED | Slash literal in key — v1: quoted segments |
| P-006 | DEFERRED | Dot literal in key — v1: quoted segments |
| P-008 | REJECTED | Empty segments |
| P-009 | REJECTED | Empty dotted sub-segments |
| P-010 | REJECTED | Scheme-only path (`oc://`) |
| P-011 | REJECTED | Control characters (alias of P-004) |
| P-012 | MITIGATED | Predicate value containing `/` round-trips |
| P-013 | MITIGATED | Predicate value containing `.` round-trips |
| P-014 | REJECTED | Empty predicate key or empty predicate value |
| P-015 | MITIGATED | Bracket segment with no operator accepted as literal sentinel |
| P-016 | REJECTED | Mismatched brackets and mismatched braces |
| P-017 | DEFERRED | Nested unions `{a,{b,c}}` — v1: parser stack |
| P-018 | REJECTED | Empty union or union with empty alternative |
| P-019 | DEFERRED | Wildcard inside wildcard — v1: pattern composition |

## Numeric / addressing

| ID | Status | Pitfall |
| --- | --- | --- |
| P-020 | MITIGATED | Negative numeric key behavior — array index vs literal map key |
| P-021 | MITIGATED | `$last` literal in a yaml key shadowed by positional sentinel |
| P-023 | MITIGATED | `parseOcPath ∘ formatOcPath` round-trip idempotent |
| P-025 | DEFERRED | Leading-zero numeric `01` — v1: explicit form |
| P-026 | REJECTED | `?` outside the query-separator position |
| P-027 | DEFERRED | `&` in segments — v1: percent-encoding |
| P-028 | DEFERRED | Percent-encoded segments — v1: rfc3986 layer |
| P-029 | MITIGATED | Numeric coercion is locale-independent |
| P-030 | MITIGATED | Boolean coercion is exact-match lowercase |
| P-040 | MITIGATED | Negative-index magnitude bounded |

## Performance / limits

| ID | Status | Pitfall |
| --- | --- | --- |
| P-031 / P-033 | MITIGATED | Walker depth cap (`MAX_TRAVERSAL_DEPTH = 256`) — kills runaway `**` recursion + yaml-anchor cycles |
| P-032 | REJECTED | Path strings exceeding `MAX_PATH_LENGTH = 4096` |

## Caller responsibility

| ID | Status | Pitfall |
| --- | --- | --- |
| P-034 | CALLER | AST mutation between `resolveOcPath` and consumer reads (caller invariant) |
| P-035 | CALLER | Stale paths from a prior `findOcPaths` after AST mutation |

## Sentinel + injection

| ID | Status | Pitfall |
| --- | --- | --- |
| P-036 | MITIGATED | Sentinel guard at emit time (`__OPENCLAW_REDACTED__` rejected) |
| P-037 | MITIGATED | Path-injection — control chars / NUL / BOM / `?` / `&` / `%` / empty file slot / backslash-escape attempts (8 sub-cases a–h) |
| P-038 | MITIGATED | Predicate-value injection — regex metachars literal, nested brackets literal, `=` in value, control chars rejected, empty body rejected, no-operator parses as sentinel, unsupported operator parses as literal (7 sub-cases a–g) |

## Test mapping

Every entry above maps to one or more `it('P-NNN ...')` cases in
`tests/scenarios/wave-23-pitfalls.test.ts`. New pitfalls land here AND
in the test file simultaneously — neither side moves alone.
