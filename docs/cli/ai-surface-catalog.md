---
summary: "AI-operable OpenClaw surfaces described by the CLI catalog overlay"
title: "AI Surface Catalog"
sidebarTitle: "AI Surface Catalog"
---

# AI Surface Catalog

This page is generated from the CLI catalog overlay registry and existing OpenClaw CLI registries. It describes the command metadata, command-routing metadata, routed operations, and agent tool surfaces that the AI can route toward.

The catalog is metadata only. It does not add a new execution dispatcher, runtime hook, gateway plugin, or policy engine. Each listed surface keeps owning its current validation, permissions, and execution behavior.

## CLI access

Use `openclaw catalog list` to inspect this read-only surface list from the CLI. Pass `--json` for automation or `--markdown` for Markdown output.

```bash
openclaw catalog list
openclaw catalog list --json
openclaw catalog list --markdown
```

## Catalog shape

- CLI descriptors: 56
- Command routes: 93
- Routed operations: 14
- Agent/tool surfaces: 5
- Prompt projection items: 19

The full JSON output is hierarchical. `cli.descriptors` is the command inventory, `cli.commandRoutes` is the startup/routing policy inventory, `cli.routedOperations` is the mechanical fast-path operation inventory, and `agentToolSurfaces` describes non-CLI or tool-backed model surfaces.

## Integration uses

The catalog is designed for more than prompt routing. Use `buildCatalogList()` or `openclaw catalog list --json` when a consumer needs structured command metadata instead of hardcoded command lists or scraped help output.

Good first consumers are:

- Reference docs generated from descriptors, command routes, routed operations, and agent/tool surfaces.
- Audit and policy inventory reports for risk, confirmation, effect mode, and route-policy keys.
- Routed-operation smoke-test matrices and coverage gap reports.
- Operator, diagnostics, admin, and debug views that need to explain mechanical OpenClaw surfaces.
- Future automation adapters that select an existing command or tool from catalog metadata while leaving execution with that surface.

## CLI descriptors

| Name          | Description                                                                                 | Source   | Subcommands | Parent default help |
| ------------- | ------------------------------------------------------------------------------------------- | -------- | ----------- | ------------------- |
| `crestodian`  | Open the interactive setup and repair assistant                                             | `core`   | no          | no                  |
| `setup`       | Initialize local config and an agent workspace                                              | `core`   | no          | no                  |
| `onboard`     | Interactive onboarding for gateway, workspace, and skills                                   | `core`   | no          | no                  |
| `configure`   | Interactive configuration for credentials, channels, gateway, and agent defaults            | `core`   | no          | no                  |
| `config`      | Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup. | `core`   | yes         | no                  |
| `backup`      | Create and verify local backup archives for OpenClaw state                                  | `core`   | yes         | no                  |
| `migrate`     | Import state from another agent system                                                      | `core`   | yes         | no                  |
| `doctor`      | Diagnose and repair config, Gateway, plugin, and channel problems                           | `core`   | no          | no                  |
| `dashboard`   | Open the Control UI with your current token                                                 | `core`   | no          | no                  |
| `reset`       | Reset local config/state (keeps the CLI installed)                                          | `core`   | no          | no                  |
| `uninstall`   | Uninstall the gateway service + local data (CLI remains)                                    | `core`   | no          | no                  |
| `message`     | Send, read, and manage channel messages                                                     | `core`   | yes         | no                  |
| `mcp`         | Manage OpenClaw MCP config and channel bridge                                               | `core`   | yes         | yes                 |
| `transcripts` | Inspect stored transcripts                                                                  | `core`   | yes         | no                  |
| `agent`       | Run one agent turn via the Gateway                                                          | `core`   | no          | no                  |
| `agents`      | Manage isolated agents (workspaces, auth, routing)                                          | `core`   | yes         | no                  |
| `status`      | Show Gateway, channel, model, and recent-session status                                     | `core`   | no          | no                  |
| `health`      | Fetch detailed health from the running Gateway                                              | `core`   | no          | no                  |
| `sessions`    | List stored conversation sessions                                                           | `core`   | yes         | no                  |
| `commitments` | List and manage inferred follow-up commitments                                              | `core`   | yes         | no                  |
| `tasks`       | Inspect durable background tasks and flows                                                  | `core`   | yes         | no                  |
| `acp`         | Run and manage ACP-backed coding agents                                                     | `subcli` | yes         | no                  |
| `gateway`     | Run, inspect, and query the OpenClaw Gateway                                                | `subcli` | yes         | no                  |
| `daemon`      | Manage the Gateway service (legacy alias)                                                   | `subcli` | yes         | no                  |
| `logs`        | Tail Gateway logs locally or via RPC                                                        | `subcli` | no          | no                  |
| `system`      | System events, heartbeat, and presence                                                      | `subcli` | yes         | no                  |
| `models`      | List, scan, and set model providers                                                         | `subcli` | yes         | no                  |
| `catalog`     | List OpenClaw catalog metadata                                                              | `subcli` | yes         | no                  |
| `infer`       | Run provider-backed model, media, search, and embedding commands                            | `subcli` | yes         | no                  |
| `capability`  | Run provider capability commands (fallback alias: infer)                                    | `subcli` | yes         | no                  |
| `approvals`   | Manage exec approvals (gateway or node host)                                                | `subcli` | yes         | yes                 |
| `exec-policy` | Show or synchronize requested exec policy with host approvals                               | `subcli` | yes         | no                  |
| `nodes`       | Pair nodes and run node-host commands through the Gateway                                   | `subcli` | yes         | no                  |
| `devices`     | Device pairing + token management                                                           | `subcli` | yes         | yes                 |
| `node`        | Run and manage the headless node host service                                               | `subcli` | yes         | no                  |
| `sandbox`     | Manage sandbox containers for agent isolation                                               | `subcli` | yes         | no                  |
| `tui`         | Open a terminal UI connected to the Gateway                                                 | `subcli` | no          | no                  |
| `terminal`    | Open a local terminal UI (alias for tui --local)                                            | `subcli` | no          | no                  |
| `chat`        | Open a local terminal UI (alias for tui --local)                                            | `subcli` | no          | no                  |
| `cron`        | Schedule and inspect Gateway background jobs                                                | `subcli` | yes         | yes                 |
| `dns`         | DNS helpers for wide-area discovery (Tailscale + CoreDNS)                                   | `subcli` | yes         | no                  |
| `docs`        | Search the live OpenClaw docs                                                               | `subcli` | no          | no                  |
| `proxy`       | Run the OpenClaw debug proxy and inspect captured traffic                                   | `subcli` | yes         | no                  |
| `hooks`       | Manage internal agent hooks                                                                 | `subcli` | yes         | no                  |
| `webhooks`    | Webhook helpers and integrations                                                            | `subcli` | yes         | no                  |
| `qr`          | Generate mobile pairing QR/setup code                                                       | `subcli` | no          | no                  |
| `clawbot`     | Legacy clawbot command aliases                                                              | `subcli` | yes         | no                  |
| `pairing`     | Secure DM pairing (approve inbound requests)                                                | `subcli` | yes         | no                  |
| `plugins`     | Install, enable, disable, and inspect plugins                                               | `subcli` | yes         | yes                 |
| `channels`    | Add, remove, login, and inspect messaging channels                                          | `subcli` | yes         | yes                 |
| `directory`   | Lookup contact and group IDs (self, peers, groups) for supported chat channels              | `subcli` | yes         | no                  |
| `security`    | Security tools and local config audits                                                      | `subcli` | yes         | no                  |
| `secrets`     | Audit, apply, and reload SecretRef-backed credentials                                       | `subcli` | yes         | no                  |
| `skills`      | List, inspect, and install agent skills                                                     | `subcli` | yes         | no                  |
| `update`      | Update OpenClaw and inspect update channel status                                           | `subcli` | yes         | no                  |
| `completion`  | Generate shell completion script                                                            | `subcli` | no          | no                  |

## Command routes

| Command path          | Exact | Route ID          | Policy keys                                                         |
| --------------------- | ----- | ----------------- | ------------------------------------------------------------------- |
| `crestodian`          | no    | None              | `bypassConfigGuard`, `ensureCliPath`, `loadPlugins`                 |
| `agent`               | no    | None              | `loadPlugins`, `networkProxy`, `pluginRegistry`                     |
| `message`             | no    | None              | `loadPlugins`                                                       |
| `channels`            | no    | None              | `loadPlugins`, `pluginRegistry`                                     |
| `directory`           | no    | None              | `loadPlugins`                                                       |
| `agents`              | no    | None              | `loadPlugins`, `networkProxy`                                       |
| `agents`              | yes   | `agents-list`     | `loadPlugins`, `networkProxy`                                       |
| `agents bind`         | yes   | None              | `loadPlugins`                                                       |
| `agents bindings`     | yes   | None              | `loadPlugins`                                                       |
| `agents unbind`       | yes   | None              | `loadPlugins`                                                       |
| `agents set-identity` | yes   | None              | `loadPlugins`                                                       |
| `agents delete`       | yes   | None              | `loadPlugins`                                                       |
| `configure`           | no    | None              | `bypassConfigGuard`, `loadPlugins`                                  |
| `config`              | yes   | None              | `bypassConfigGuard`, `loadPlugins`, `networkProxy`                  |
| `config models`       | yes   | None              | `bypassConfigGuard`, `loadPlugins`, `networkProxy`                  |
| `migrate`             | no    | None              | `bypassConfigGuard`, `loadPlugins`, `networkProxy`                  |
| `status`              | no    | `status`          | `ensureCliPath`, `loadPlugins`, `networkProxy`, `pluginRegistry`    |
| `health`              | no    | `health`          | `ensureCliPath`, `loadPlugins`, `networkProxy`, `pluginRegistry`    |
| `gateway`             | no    | None              | `networkProxy`                                                      |
| `gateway status`      | yes   | `gateway-status`  | `loadPlugins`, `networkProxy`, `routeConfigGuard`                   |
| `gateway call`        | yes   | None              | `networkProxy`                                                      |
| `gateway diagnostics` | yes   | None              | `networkProxy`                                                      |
| `gateway discover`    | yes   | None              | `networkProxy`                                                      |
| `gateway export`      | yes   | None              | `networkProxy`                                                      |
| `gateway health`      | yes   | None              | `networkProxy`                                                      |
| `gateway install`     | yes   | None              | `networkProxy`                                                      |
| `gateway probe`       | yes   | None              | `networkProxy`                                                      |
| `gateway restart`     | yes   | None              | `networkProxy`                                                      |
| `gateway stability`   | yes   | None              | `networkProxy`                                                      |
| `gateway start`       | yes   | None              | `networkProxy`                                                      |
| `gateway stop`        | yes   | None              | `networkProxy`                                                      |
| `gateway uninstall`   | yes   | None              | `networkProxy`                                                      |
| `gateway usage-cost`  | yes   | None              | `networkProxy`                                                      |
| `sessions`            | yes   | `sessions`        | `ensureCliPath`, `networkProxy`                                     |
| `commitments`         | no    | None              | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `agents list`         | no    | `agents-list`     | `loadPlugins`, `networkProxy`                                       |
| `config get`          | yes   | `config-get`      | `ensureCliPath`, `networkProxy`                                     |
| `config unset`        | yes   | `config-unset`    | `ensureCliPath`, `networkProxy`                                     |
| `models list`         | yes   | `models-list`     | `ensureCliPath`, `networkProxy`, `routeConfigGuard`                 |
| `models status`       | yes   | `models-status`   | `ensureCliPath`, `networkProxy`, `routeConfigGuard`                 |
| `catalog`             | no    | None              | `bypassConfigGuard`, `ensureCliPath`, `loadPlugins`, `networkProxy` |
| `tasks list`          | yes   | `tasks-list`      | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `tasks audit`         | yes   | `tasks-audit`     | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `tasks`               | no    | `tasks-list`      | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `tool`                | no    | None              | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `tools`               | no    | None              | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `acp`                 | no    | None              | `networkProxy`                                                      |
| `approvals`           | no    | None              | `networkProxy`                                                      |
| `backup`              | no    | None              | `bypassConfigGuard`, `networkProxy`                                 |
| `chat`                | no    | None              | `networkProxy`                                                      |
| `config`              | no    | None              | `networkProxy`                                                      |
| `cron`                | no    | None              | `networkProxy`                                                      |
| `dashboard`           | no    | None              | `networkProxy`                                                      |
| `daemon`              | no    | None              | `networkProxy`                                                      |
| `devices`             | no    | None              | `networkProxy`                                                      |
| `doctor`              | no    | None              | `bypassConfigGuard`, `loadPlugins`                                  |
| `exec-policy`         | no    | None              | `networkProxy`                                                      |
| `hooks`               | no    | None              | `networkProxy`                                                      |
| `logs`                | no    | None              | `networkProxy`                                                      |
| `mcp`                 | no    | None              | `networkProxy`                                                      |
| `node`                | no    | None              | `networkProxy`                                                      |
| `node run`            | yes   | None              | `networkProxy`                                                      |
| `nodes`               | no    | None              | `networkProxy`                                                      |
| `pairing`             | no    | None              | `networkProxy`                                                      |
| `proxy`               | no    | None              | `networkProxy`                                                      |
| `qr`                  | no    | None              | `networkProxy`                                                      |
| `reset`               | no    | None              | `networkProxy`                                                      |
| `completion`          | no    | None              | `bypassConfigGuard`, `hideBanner`, `networkProxy`                   |
| `secrets`             | no    | None              | `bypassConfigGuard`, `networkProxy`                                 |
| `security`            | no    | None              | `networkProxy`                                                      |
| `system`              | no    | None              | `networkProxy`                                                      |
| `terminal`            | no    | None              | `networkProxy`                                                      |
| `tui`                 | no    | None              | `networkProxy`                                                      |
| `uninstall`           | no    | None              | `networkProxy`                                                      |
| `update`              | no    | None              | `hideBanner`                                                        |
| `config validate`     | yes   | None              | `bypassConfigGuard`, `networkProxy`                                 |
| `config schema`       | yes   | None              | `bypassConfigGuard`, `networkProxy`                                 |
| `plugins update`      | yes   | None              | `hideBanner`                                                        |
| `plugins list`        | yes   | `plugins-list`    | `ensureCliPath`, `loadPlugins`, `networkProxy`                      |
| `onboard`             | yes   | None              | `loadPlugins`                                                       |
| `channels add`        | yes   | None              | `loadPlugins`, `networkProxy`                                       |
| `channels logs`       | yes   | None              | `loadPlugins`, `networkProxy`                                       |
| `channels remove`     | yes   | None              | `networkProxy`, `pluginRegistry`                                    |
| `channels resolve`    | yes   | None              | `networkProxy`, `pluginRegistry`                                    |
| `channels status`     | yes   | `channels-status` | `loadPlugins`, `networkProxy`                                       |
| `channels list`       | yes   | `channels-list`   | `loadPlugins`, `networkProxy`                                       |
| `skills`              | yes   | None              | `networkProxy`                                                      |
| `skills check`        | yes   | None              | `networkProxy`                                                      |
| `skills info`         | yes   | None              | `networkProxy`                                                      |
| `skills install`      | yes   | None              | None                                                                |
| `skills list`         | yes   | None              | `networkProxy`                                                      |
| `skills search`       | yes   | None              | None                                                                |
| `skills update`       | yes   | None              | None                                                                |

## Routed operations

| Operation         | Command paths           |
| ----------------- | ----------------------- |
| `agents-list`     | `agents`, `agents list` |
| `channels-list`   | `channels list`         |
| `channels-status` | `channels status`       |
| `config-get`      | `config get`            |
| `config-unset`    | `config unset`          |
| `gateway-status`  | `gateway status`        |
| `health`          | `health`                |
| `models-list`     | `models list`           |
| `models-status`   | `models status`         |
| `plugins-list`    | `plugins list`          |
| `sessions`        | `sessions`              |
| `status`          | `status`                |
| `tasks-audit`     | `tasks audit`           |
| `tasks-list`      | `tasks list`, `tasks`   |

## Agent/tool surfaces

### `skill_workshop`: Skill Workshop proposals

Create, revise, apply, reject, or quarantine durable skill proposals.

- Kind: `tool`
- Dispatch mode: `metadata-first`
- Target: `skill_workshop`
- Owner: `agents`
- Status: `stable`
- Risk: `medium`
- Confirmation required: yes
- Effect mode: `mixed`
- Source: existing skill_workshop tool and prompt guidance
- Effects: `proposal.lifecycle`
- Examples: create a reusable skill; reject a pending skill proposal
- Command hints: `skill_workshop action=create|update|revise`, `skill_workshop action=apply|reject|quarantine`

### `session_status`: Session status

Report the current session state and model-use status.

- Kind: `tool`
- Dispatch mode: `direct`
- Target: `session_status`
- Owner: `agents`
- Status: `stable`
- Risk: `low`
- Confirmation required: no
- Effect mode: `read`
- Source: existing session_status command
- Effects: `session.status`
- Examples: what model am I using; show session status
- Command hints: `session_status`

### `sessions_spawn`: Sub-agent spawn

Delegate work to a sub-agent or ACP session when the task is broader than a direct reply.

- Kind: `tool`
- Dispatch mode: `hybrid`
- Target: `sessions_spawn`
- Owner: `agents`
- Status: `stable`
- Risk: `low`
- Confirmation required: no
- Effect mode: `mutating`
- Source: existing sessions_spawn command and delegation guidance
- Effects: `delegation.spawn`
- Examples: delegate file review; spawn a sub-agent for debugging
- Command hints: `sessions_spawn`

### `process`: Process control

Inspect and manage active exec/process work.

- Kind: `command`
- Dispatch mode: `direct`
- Target: `process`
- Owner: `agents`
- Status: `stable`
- Risk: `low`
- Confirmation required: no
- Effect mode: `mixed`
- Source: existing process command surface
- Effects: `process.lifecycle`
- Examples: show process logs; poll a running command
- Command hints: `process list`, `process poll`, `process log`, `process write`

### `gateway`: Gateway control

Inspect, reconfigure, or restart the OpenClaw gateway.

- Kind: `command`
- Dispatch mode: `hybrid`
- Target: `gateway`
- Owner: `runtime`
- Status: `stable`
- Risk: `medium`
- Confirmation required: yes
- Effect mode: `mixed`
- Source: CLI descriptor: gateway
- CLI descriptor: `gateway`
- Effects: `gateway.restart`, `gateway.config`
- Examples: restart the gateway; inspect gateway config
- Command hints: `gateway status`, `gateway restart`, `gateway config.schema.lookup`, `gateway config.apply`
