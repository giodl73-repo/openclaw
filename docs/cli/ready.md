---
summary: "CLI reference for `openclaw ready` (hosting readiness checks)"
read_when:
  - You need a container or supervisor readiness probe for OpenClaw
  - You want a machine-readable answer for whether OpenClaw is ready to serve
title: "openclaw ready"
---

# `openclaw ready`

Check whether the current OpenClaw process is ready for its selected hosting
profile. Use this command from container readiness probes, service supervisors,
or deployment scripts that need a single pass/fail signal.

```bash
openclaw ready
openclaw ready --json
openclaw ready --timeout 2500
openclaw ready --expect-profile container --json
```

`openclaw ready` exits `0` when the readiness evaluation passes and exits
non-zero when any required condition fails.

## Options

| Flag                         | Default | Description                                           |
| ---------------------------- | ------- | ----------------------------------------------------- |
| `--json`                     | `false` | Print machine-readable readiness JSON.                |
| `--timeout <ms>`             | `10000` | Gateway RPC connection timeout in milliseconds.       |
| `--expect-profile <profile>` | unset   | Fail when the runtime selected a different profile.   |

## Readiness model

The selected hosting profile defines the runtime contract OpenClaw evaluates.
If no profile is selected, the effective profile is `local`. Select a profile
with `hosting.profile`, `OPENCLAW_HOSTING_PROFILE`, or `openclaw gateway run
--hosting-profile <profile>`.

The built-in profiles are `local`, `container`, `reverse-proxy`, `managed`, and
`node-mode`. The default `local` profile verifies that OpenClaw can load
configuration, reach the Gateway, use the current workspace, and load required
plugins. The human-readable output is intentionally compact:

```text
ready: local
```

When OpenClaw is not ready, the command prints stable failure reasons:

```text
not ready: GatewayUnavailable
```

`--json` returns the same result with condition details:

```json
{
  "profile": "local",
  "ready": false,
  "conditions": [
    {
      "type": "ProfileSelected",
      "status": "True",
      "reason": "ProfileSelected",
      "message": "Runtime selected the local hosting profile."
    },
    {
      "type": "GatewayResponding",
      "status": "False",
      "reason": "GatewayUnavailable",
      "message": "Gateway did not respond to the readiness request."
    }
  ],
  "failures": ["GatewayUnavailable"]
}
```

Use `--expect-profile` in host manifests when the host must prove it started
the intended profile. A mismatch returns `ready: false` and the stable failure
reason `ProfileMismatch`; the flag does not select the profile.

## Custom profiles and conditions

Custom profiles are declared under `hosting.profiles` and must use a namespaced
id such as `acme.managed`. Built-in profile names cannot be redefined.
Reusable custom criteria are declared once under `hosting.criteria`; profiles
then reference those criteria as required or optional:

```json
{
  "hosting": {
    "profile": "acme.managed",
    "criteria": {
      "acme.backup-ready": {
        "status": "True",
        "reason": "BackupReady",
        "message": "Backup volume restored."
      },
      "acme.telemetry-ready": {
        "status": "False",
        "reason": "TelemetryUnavailable"
      }
    },
    "profiles": {
      "acme.managed": {
        "extends": "container",
        "readiness": {
          "requiredCriteria": ["acme.backup-ready"],
          "optionalCriteria": ["acme.telemetry-ready"]
        }
      }
    }
  }
}
```

Required criteria block `ready=true` when their status is `False`. Optional
criteria appear in readiness output but do not block readiness.

## Node-mode readiness

`node-mode` is the profile for a controlled execution node or cell. It uses the
same `ready`, `health`, and `status --json` surfaces as the other profiles, then
adds node-specific conditions:

| Condition                | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `NodePairingReady`       | At least one approved node pairing exists.        |
| `ControlledTargetsReady` | OpenClaw has target inventory for execution.      |
| `CommandApprovalReady`   | Command approval posture is configured or known.  |
| `ControlChannelReady`    | The control channel to the Gateway was checked.   |
| `StateReady`             | Workspace and local state are usable.             |

Stable failure reasons include `NodePairingMissing`,
`ControlledTargetsMissing`, `CommandApprovalMissing`, and
`ControlChannelUnavailable`.

## Related

- [`openclaw status`](/cli/status) - local diagnostics and summary output
- [`openclaw health`](/cli/health) - full Gateway health snapshot
- [`openclaw gateway`](/cli/gateway) - run the Gateway with `--hosting-profile`
- [Gateway health](/gateway/health)
