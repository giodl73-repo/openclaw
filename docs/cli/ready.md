---
summary: "CLI reference for `openclaw ready` (canonical Gateway readiness)"
read_when:
  - You need a scriptable readiness check for a running Gateway
title: "Ready"
---

# `openclaw ready`

Fetch the canonical readiness result from the running Gateway. This is the CLI projection of the same condition set used by Gateway `/ready`, `/readyz`, health, and status surfaces; it does not run a separate local evaluator.

## Options

| Flag                | Default      | Description                                                                |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `--json`            | `false`      | Print JSON; with `--watch`, emit one event per line.                       |
| `--timeout <ms>`    | `10000`      | Gateway connection timeout for each evaluation.                            |
| `--watch`           | `false`      | Emit the initial result and then semantic readiness changes.               |
| `--wait [duration]` | unset        | Wait for readiness, using `60s` when no duration is supplied.              |
| `--interval <ms>`   | mode default | Delay between evaluations (minimum `250`); requires `--watch` or `--wait`. |

```bash
openclaw ready
openclaw ready --json
openclaw ready --watch
openclaw ready --watch --json --interval 500
openclaw ready --wait 60s
openclaw ready --wait --json
openclaw ready --timeout 2500
openclaw ready criteria list
openclaw ready criteria inspect openclaw.workspace-writable --json
```

Human output identifies the producer, summarizes required/advisory counts, then
lists every condition with its subject, status, requirement, stable reason, and
diagnostic message. When a condition is not `True`, it also reports the existing
lifetime ID, generation, kind, and parent reference for the affected primary
and related subjects. This distinguishes a condition failure from replacement
or revision without requiring JSON parsing. `--json` returns the complete canonical result unchanged,
including `contractVersion`, `evaluatedAtMs`, the reconciled `identity.subjects` package, condition
subject references, `failures`, and `advisories`.

Repeated JSON results can be compared by `(subjectRef, type)`. Subject `id`
tracks the lifetime owned by that subject: host workload, process, Gateway
serving lifecycle, plugin resource, or node. `generation` tracks an
owner-defined revision of the same subject, such as active config or pairing
state. A Gateway keeps one ID across readiness evaluations, reload, and drain,
and receives a new ID when its serving lifecycle restarts.

## Watch mode

Watch mode continues through not-ready results and temporary Gateway
unavailability so operators can observe recovery. Evaluations run sequentially
and retain the independent `--timeout` bound. Signals cancel the active Gateway
call as well as the polling delay. Timestamp-only churn is ignored;
conditions are compared by `(subjectRef, type)` and subjects by `ref`. A new
subject `id` or `generation` is reported as replacement at a new lifetime.

With `--watch --json`, output is versioned JSON Lines: one complete `snapshot`
or `transition` event per line. Each event contains the current canonical
result or the structured Gateway-unavailable error. The watch facility polls
the existing readiness contract; it does not introduce a separate streaming
Gateway protocol.

When the Gateway cannot be reached or does not expose the readiness contract, `--json` returns `ready: false` with a structured `error.reason` and `error.message` instead of emitting a partial condition set.

## Exit codes

| Code  | Meaning                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | The Gateway reported ready. Advisory findings may still be present.                                                                    |
| `1`   | A required condition failed or was unknown, the Gateway was unavailable, or the running Gateway did not expose the readiness contract. |
| `130` | Watch mode was interrupted by `SIGINT`.                                                                                                |
| `143` | Watch mode was interrupted by `SIGTERM`.                                                                                               |

In watch mode, not-ready and unavailable states are observations rather than
process exits; the command remains active to report recovery.

## Wait mode

`openclaw ready --wait [duration]` polls sequentially until the canonical
result is ready or the total duration expires. The default duration is `60s`
and the default polling interval is `500ms`. Each Gateway call retains its own
`--timeout` bound, capped by the remaining total duration.

Wait mode emits only the final observation. Successful JSON output remains the
canonical readiness result, so the same command can gate Docker, Kubernetes,
systemd, OCC, or another host after it starts OpenClaw. On timeout, the command
exits `1` and emits the last canonical result when one was observed; if the
Gateway was never reachable, it emits a structured `GatewayReadinessTimeout`
error. Wait mode and watch mode are mutually exclusive.

## Criterion catalog

`openclaw ready criteria list` reports the selectable core and plugin criteria
registered by the running Gateway, their owner, availability, and current
`required`, `advisory`, or `unselected` state. Use
`openclaw ready criteria inspect <id>` to inspect one descriptor. Both commands
support `--json` and `--timeout`.

The catalog is read-only and observationally inert: enumeration does not run
criterion callbacks or perform a readiness evaluation. A criterion selected in
configuration but absent from the active registry remains visible with
`registered: false`, which makes activation and configuration drift
diagnosable.

## Related

- [`openclaw health`](/cli/health)
- [`openclaw status`](/cli/status)
- [Gateway health and readiness](/gateway/health)
