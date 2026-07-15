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
