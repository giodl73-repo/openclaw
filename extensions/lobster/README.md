# Lobster (plugin)

Adds the `lobster` agent tool as an **optional** plugin tool.

## Install

```bash
openclaw plugins install @openclaw/lobster
```

Restart the Gateway after installing or updating the plugin.

## What this is

- Lobster is a standalone workflow shell (typed JSON-first pipelines + approvals/resume).
- This plugin integrates Lobster with OpenClaw _without core changes_.

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "lobster" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    ]
  }
}
```

## Using `openclaw.invoke` (Lobster → OpenClaw tools)

Some Lobster pipelines may include a `openclaw.invoke` step to call back into OpenClaw tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).

In the embedded plugin, `openclaw.invoke` uses OpenClaw's context-bound plugin runtime and automatically inherits the active session and caller policy context. No Gateway URL or bearer token is required. The runtime reuses OpenClaw's canonical tool invocation engine, so the target remains filtered by the active agent, channel, sender, subagent, and Gateway tool policies.

Embedded workflows cannot override the active session. With `--each`, a supplied or TaskFlow-derived idempotency key is suffixed with the stable input index so each mapped side effect remains distinct.

Use `--step-id` to derive a stable TaskFlow-scoped idempotency key for a side-effecting step:

```lobster
openclaw.invoke --tool billing --action pay --step-id pay-invoice --args-json '{"invoice":"INV-1042"}'
```

Standalone Lobster still uses the HTTP bridge. For that mode, the OpenClaw Gateway must expose the tool endpoint and the target tool must be allowed by policy:

- OpenClaw provides an HTTP endpoint: `POST /tools/invoke`.
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, OpenClaw returns `404 Tool not available`.

### Allowlisting recommended

To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `openclaw.invoke`.

Example (allow only a small set of tools):

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["lobster", "web_fetch", "web_search", "gog", "gh"],
          "deny": ["gateway"],
        },
      },
    ],
  },
}
```

Notes:

- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.
- Tool names depend on which plugins you have installed/enabled.

## Sequencing managed skills

Lobster can provide the deterministic steps while OpenClaw keeps ownership of
skill discovery, policy, sessions, receipts, regarding context, lineage, and
token accounting. A root skill can declare the skills its workflow may call:

```markdown
---
name: support-case
description: Verify a customer and resolve their support case.
metadata: '{"outcomes":"case.resolved","uses-skills":"verify-customer resolve-case"}'
---

Run `examples/support-case.lobster` through the Lobster tool for the current
case. Use managed TaskFlow mode so each workflow step receives a stable flow
identity, and allow at least 125 seconds for the two managed steps.
```

Start `support-case` as a managed skill with the token budget for the whole
operation. Its Lobster workflow then sequences two ordinary managed child
skills:

```yaml
steps:
  - id: verify_customer
    pipeline: >
      openclaw.skill --skill verify-customer
      --task "Verify the customer for case ${case_id}"
      --step-id verify-customer --wait-timeout-ms 60000

  - id: resolve_case
    pipeline: >
      openclaw.skill --skill resolve-case
      --task "Resolve case ${case_id} after customer verification"
      --step-id resolve-case --wait-timeout-ms 60000
```

The child calls do not set their own token budgets. Because they run inside the
managed `support-case` skill, OpenClaw validates them against `uses-skills` and
inherits the root budget owner, parent lineage, and current session's
`regarding` identity. Lobster contributes ordering and stable step ids; it does
not start the next step until OpenClaw reports that the prior managed run
completed successfully. A failed or timed-out child stops the workflow. Lobster
does not create a second receipt, CRM, or budgeting system.

The full runnable example is
[`examples/support-case.lobster`](./examples/support-case.lobster). Branching,
retry policy, and approvals can be layered onto the same workflow later using
Lobster's existing primitives.

## Security

- Runs Lobster in process via the published `@clawdbot/lobster/core` runtime.
- Does not manage OAuth/tokens.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.

## Docs

- https://docs.openclaw.ai/tools/lobster

## Package

- Plugin id: `lobster`
- Tool: `lobster`
- Package: `@openclaw/lobster`
- Minimum OpenClaw host: `2026.4.25`
