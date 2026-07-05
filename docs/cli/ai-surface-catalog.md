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

`crestodian`, `setup`, `onboard`, `configure`, `config`, `backup`, `migrate`, `doctor`, `dashboard`, `reset`, `uninstall`, `message`, `mcp`, `transcripts`, `agent`, `agents`, `status`, `health`, `sessions`, `commitments`, `tasks`, `acp`, `gateway`, `daemon`, `logs`, `system`, `models`, `catalog`, `infer`, `capability`, `approvals`, `exec-policy`, `nodes`, `devices`, `node`, `sandbox`, `tui`, `terminal`, `chat`, `cron`, `dns`, `docs`, `proxy`, `hooks`, `webhooks`, `qr`, `clawbot`, `pairing`, `plugins`, `channels`, `directory`, `security`, `secrets`, `skills`, `update`, `completion`

## Routed operations

`agents-list`, `channels-list`, `channels-status`, `config-get`, `config-unset`, `gateway-status`, `health`, `models-list`, `models-status`, `plugins-list`, `sessions`, `status`, `tasks-audit`, `tasks-list`

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
