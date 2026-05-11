---
summary: "CLI reference for `openclaw policy` conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need policy, evidence, and findings hashes for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled `policy` extension. Policy is an
enterprise conformance feature: it lets an operator express required workspace
posture in `policy.jsonc`, checks existing OpenClaw surfaces against those
requirements, and emits audit evidence that can be recorded.

Policy currently manages configured channels, model providers, and governed
tool declarations. For example, IT or a workspace operator can record that
Telegram is not an approved channel provider, restrict model refs to approved
providers, require governed tools to carry risk and sensitivity metadata, then
use `doctor --lint` as the shared conformance gate.

Policy is a conformance layer over existing OpenClaw settings. It does not add
a second channel configuration system. The final conformance signal is a clean
`doctor --lint` run; policy contributes findings to that shared lint surface
instead of creating a separate health gate.

Use policy when a workspace needs a durable statement such as "these channels
must not be enabled" or "governed tools must declare approval metadata" and a
repeatable way to prove that OpenClaw still conforms to that statement. Use
regular config and workspace docs alone when you only need local behavior and
do not need policy findings or attestation output.

## Enable

Enable the bundled policy extension before first use:

```bash
openclaw plugins enable policy
```

When policy is enabled, the extension registers policy health checks with the
shared health registry. Doctor then runs registered checks; doctor does not
load plugins itself. The extension remains enabled even if `policy.jsonc` is
missing, so doctor can report that the policy artifact needs to be restored or
added.

## Author Policy

Policy is authored, not generated from the user's current settings. A minimal
policy for channels, model providers, and tool metadata looks like this:

```jsonc
{
  "channels": {
    "denyRules": [
      {
        "id": "no-telegram",
        "when": { "provider": "telegram" },
        "reason": "Telegram is not approved for this workspace.",
      },
    ],
  },
  "models": {
    "providers": {
      "allow": ["openai", "anthropic"],
      "deny": ["openrouter"],
    },
  },
  "tools": {
    "settings": {
      "requireRisk": true,
      "requireSensitivity": true,
    },
  },
}
```

The rules are the authority. A category block is only a namespace; checks run
when a concrete rule is present. OpenClaw reads current `channels.*` settings
`models.providers.*`, selected agent model refs, and `TOOLS.md` declarations as
evidence, then reports observed state that does not conform.

## Commands

```bash
openclaw policy check
openclaw policy check --json
openclaw policy check --severity-min error
```

`policy check` runs only the policy check set and emits the observed workspace
evidence plus policy and evidence hashes. The same findings also appear in
`openclaw doctor --lint` when the policy extension is enabled, and
`doctor --lint` is the workspace-level gate.

Example JSON output:

```json
{
  "ok": true,
  "attestation": {
    "checkedAt": "2026-05-10T20:00:00.000Z",
    "policy": {
      "path": "policy.jsonc",
      "hash": "sha256:..."
    },
    "workspace": {
      "scope": "policy",
      "hash": "sha256:..."
    },
    "findingsHash": "sha256:...",
    "attestationHash": "sha256:..."
  },
  "evidence": {
    "channels": [
      {
        "id": "telegram",
        "provider": "telegram",
        "ocPath": "oc://openclaw.config/channels/telegram",
        "enabled": false
      }
    ],
    "modelProviders": [
      {
        "id": "openai",
        "ocPath": "oc://openclaw.config/models/providers/openai"
      }
    ],
    "modelRefs": [
      {
        "ref": "openai/gpt-5.5",
        "provider": "openai",
        "model": "gpt-5.5",
        "ocPath": "oc://openclaw.config/agents/defaults/model"
      }
    ],
    "tools": [
      {
        "id": "deploy",
        "ocPath": "oc://TOOLS.md/tools/deploy",
        "line": 12,
        "risk": "critical",
        "sensitivity": "restricted",
        "capabilities": ["IRREVERSIBLE_EXTERNAL"]
      }
    ]
  },
  "checksRun": 8,
  "checksSkipped": 0,
  "findings": []
}
```

The policy hash identifies the authored rule artifact. The evidence block
records the observed OpenClaw state used by the policy checks. The
`workspace.hash` value identifies that evidence payload for the checked scope.
The findings hash identifies the exact finding set returned by the check.
`checkedAt` records when the evaluation ran. The attestation hash identifies
the whole claim, including the timestamp and whether the result was clean.
Together, these form the audit tuple for this policy check.

If a later gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean policy
check. That single value binds the policy file, observed evidence, findings,
and check time used to justify the decision.

Policy findings can include both `target` and `requirement`. `target` is the
observed workspace thing that does not conform. `requirement` is the authored
policy rule that made it a finding. Both values are addresses today, usually
`oc://` paths, but the field names describe their policy role rather than the
address format.

## Configuration

Policy config lives under `plugins.entries.policy.config`:

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "enabled": true,
        "config": {
          "enabled": true,
          "requireRisk": true,
          "requireSensitivity": true,
          "runtimeToolPolicy": false,
          "workspaceRepairs": false,
          "expectedHash": "sha256:...",
          "path": "policy.jsonc",
        },
      },
    },
  },
}
```

| Setting              | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `enabled`            | Enable policy checks even before `policy.jsonc` exists.             |
| `requireRisk`        | Require governed tool declarations to include risk metadata.        |
| `requireSensitivity` | Require governed tool declarations to include sensitivity metadata. |
| `runtimeToolPolicy`  | Apply enabled tool requirements through the trusted tool hook.      |
| `workspaceRepairs`   | Allow `doctor --fix` to edit policy-managed workspace settings.     |
| `expectedHash`       | Optional hash-lock for the approved policy artifact.                |
| `path`               | Workspace-relative location of the policy artifact.                 |

Tool requirement booleans can also live under `tools.settings` in
`policy.jsonc`. Config wins when both places set the same value.

Set `plugins.entries.policy.config.enabled` to `false` to disable policy
checks for a workspace.

## Checks

Policy currently verifies:

| Check id                                 | Finding                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `policy/policy-jsonc-missing`            | Policy is enabled but `policy.jsonc` is missing.                   |
| `policy/policy-hash-mismatch`            | Policy does not match configured `expectedHash`.                   |
| `policy/channels-denied-provider`        | An enabled channel matches a channel deny rule.                    |
| `policy/models-denied-provider`          | A configured model provider or model ref uses a denied provider.   |
| `policy/models-unapproved-provider`      | A configured model provider or model ref is outside the allowlist. |
| `policy/tools-missing-risk-level`        | A governed tool declaration is missing risk metadata.              |
| `policy/tools-missing-sensitivity-token` | A governed tool declaration is missing sensitivity metadata.       |
| `policy/tools-unknown-sensitivity-token` | A governed tool declaration uses an unknown sensitivity value.     |

Example JSON finding:

```json
{
  "checkId": "policy/channels-denied-provider",
  "severity": "error",
  "message": "Channel 'telegram' uses denied provider 'telegram'.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/channels/telegram",
  "target": "oc://openclaw.config/channels/telegram",
  "requirement": "oc://policy.jsonc/channels/denyRules/#0",
  "fixHint": "Telegram is not approved for this workspace."
}
```

Example tool finding:

```json
{
  "checkId": "policy/tools-missing-risk-level",
  "severity": "error",
  "message": "TOOLS.md tool 'deploy' has no explicit risk classification.",
  "source": "policy",
  "path": "TOOLS.md",
  "line": 12,
  "ocPath": "oc://TOOLS.md/tools/deploy",
  "target": "oc://TOOLS.md/tools/deploy",
  "requirement": "oc://policy.jsonc/tools/settings/requireRisk"
}
```

Example model-provider finding:

```json
{
  "checkId": "policy/models-unapproved-provider",
  "severity": "error",
  "message": "Model ref 'anthropic/claude-sonnet-4.7' uses unapproved provider 'anthropic'.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  "target": "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  "requirement": "oc://policy.jsonc/models/providers/allow"
}
```

## Repair

`doctor --lint` and `policy check` are read-only.

`doctor --fix` only edits policy-managed workspace settings when
`workspaceRepairs` is explicitly enabled. Without that opt-in, policy checks
report what they would repair and leave settings unchanged.

In this version, repair can disable channels that are enabled in OpenClaw config
but denied by `channels.denyRules`.

## Runtime Tool Policy

OpenClaw config can also opt into a small runtime tool gate:

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "enabled": true,
        "config": {
          "enabled": true,
          "runtimeToolPolicy": true,
        },
      },
    },
  },
}
```

When `runtimeToolPolicy` is enabled, the bundled policy extension registers an
OpenClaw trusted tool policy. It uses the same `policy.jsonc` requirements and
`TOOLS.md` evidence as `policy check`.

The runtime gate is enabled from OpenClaw config, not from `policy.jsonc`, so a
missing policy artifact still fails closed instead of disabling the gate.

The runtime gate:

- blocks tool calls if the enabled policy artifact is missing or does not match
  `expectedHash`;
- blocks governed tool calls whose required metadata is missing or invalid;
- asks for approval for governed tools marked `risk:critical` or
  `IRREVERSIBLE_EXTERNAL`;
- otherwise lets the normal tool call path continue.

This is not a separate plugin loader path for doctor. The extension registers
the trusted tool policy when the policy extension is enabled, and the existing
tool runtime invokes the registered policy before regular `before_tool_call`
hooks.

## Exit Codes

| Command        | `0`                           | `1`                                     | `2`                          |
| -------------- | ----------------------------- | --------------------------------------- | ---------------------------- |
| `policy check` | No findings at the threshold. | One or more findings met the threshold. | Argument or runtime failure. |

## Related

- [Doctor lint mode](/cli/doctor#lint-mode)
- [Policy plugin reference](/plugins/reference/policy)
- [Path CLI](/cli/path)
