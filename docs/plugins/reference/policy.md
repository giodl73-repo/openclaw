---
summary: "Policy-backed doctor checks for workspace conformance."
read_when:
  - You are installing, configuring, or auditing the policy plugin
title: "Policy plugin"
---

# Policy plugin

Policy-backed doctor checks for workspace conformance. Policy is an enterprise
conformance feature: `policy.jsonc` records authored requirements, existing
OpenClaw surfaces are observed as evidence, and policy checks produce findings
plus attestation hashes that can be recorded for audit.

## Distribution

- Package: `@openclaw/policy`
- Install route: included in OpenClaw

## Surface

plugin; CLI command: [`openclaw policy`](/cli/policy)

## Behavior

The policy plugin contributes doctor health checks for policy-managed OpenClaw
settings and governed workspace declarations. Policy currently manages channel
conformance, model-provider conformance, and tool metadata conformance:

- `policy.jsonc` stores operator-owned channel, model-provider, and tool
  requirements.
- `openclaw policy check` runs only the policy health checks and emits
  observed channel/model/tool evidence plus policy/evidence/findings/
  attestation hashes.
- `openclaw doctor --lint` reports the same policy findings alongside other
  structured health checks.
- `openclaw doctor --fix` can disable denied enabled channels when
  `workspaceRepairs` is explicitly enabled.
- When `runtimeToolPolicy` is enabled, the bundled policy extension registers a
  trusted tool policy that blocks unverifiable governed tool calls and requests
  approval for critical or irreversible governed tools.

Policy is not a duplicate governance stack. It records expected conformance in
`policy.jsonc`, observes existing OpenClaw settings and `TOOLS.md` declarations
as evidence, reports non-conformance through doctor, and repairs existing
OpenClaw config through the same config repair model. The final conformance
signal remains a clean `doctor --lint` run; policy adds domain-specific
findings to that shared health surface.

Policy findings identify both sides of the decision when available: `target`
points to the observed workspace thing, and `requirement` points to the
authored policy rule. The current addresses are `oc://` paths, but the fields
are named for their policy roles rather than the address format.

Use policy when operators need to prove that a workspace still conforms to an
approved requirement, such as a denied channel provider or required tool
metadata. Use ordinary OpenClaw config and workspace docs when the workspace
only needs local behavior and does not need policy findings or attestation
output.

When policy is enabled, the extension registers its health checks with the
shared health registry. Doctor then runs registered checks; doctor does not
load plugins itself. Runtime tool policy uses OpenClaw's existing trusted tool
policy hook, not a separate gateway or supervisor path.

## Config

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

`workspaceRepairs` defaults to off. With the default posture, policy checks can
report denied channels, but `doctor --fix` will not edit workspace settings for
policy unless the operator explicitly enables repairs. `expectedHash` can pin
the policy file to an approved hash.

`runtimeToolPolicy` also defaults to off. It is enabled from OpenClaw config,
not from `policy.jsonc`, so a missing policy artifact still fails closed
instead of disabling the runtime gate. When enabled, the runtime trusted tool
policy reads the same policy artifact and `TOOLS.md` evidence used by
`policy check`. It blocks calls when required metadata is missing or the policy
hash does not match, and requests approval for governed tools marked
`risk:critical` or `IRREVERSIBLE_EXTERNAL`.

## Checks

The plugin registers these doctor health checks:

| Check id                                 | Purpose                                        |
| ---------------------------------------- | ---------------------------------------------- |
| `policy/policy-jsonc-missing`            | Report missing policy artifact when enabled.   |
| `policy/policy-hash-mismatch`            | Reject policy files that do not match hash.    |
| `policy/channels-denied-provider`        | Reject enabled channels matching deny rules.   |
| `policy/models-denied-provider`          | Reject denied model providers and refs.        |
| `policy/models-unapproved-provider`      | Reject model providers outside the allowlist.  |
| `policy/tools-missing-risk-level`        | Require governed tools to declare risk.        |
| `policy/tools-missing-sensitivity-token` | Require governed tools to declare sensitivity. |
| `policy/tools-unknown-sensitivity-token` | Reject unknown governed tool sensitivity.      |

Run them through either surface:

```bash
openclaw policy check --json
openclaw doctor --lint --only policy/channels-denied-provider --json
```

## Related docs

- [Policy CLI](/cli/policy)
- [Doctor lint mode](/cli/doctor#lint-mode)
