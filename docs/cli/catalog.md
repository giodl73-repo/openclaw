---
summary: "Generated CLI catalog reference for command metadata, lenses, and machine-readable contracts"
read_when:
  - Inspecting the `openclaw catalog` metadata surfaces
  - Reviewing prompt, audit, test, or operator catalog lenses
title: "CLI catalog reference"
---

# CLI catalog reference

This page is generated from the CLI catalog APIs. Regenerate it with:

```bash
node --import tsx scripts/generate-cli-catalog-doc.ts --write
```

Use `--check` in validation to verify the checked-in page is current.

## Commands

| Command                        | Purpose                                                                                                                                                                         | Machine output |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `openclaw catalog list`        | List command descriptors, command routes, routed operations, runtime commands, plugin descriptor commands, node/operator commands, catalog surfaces, and prompt projection IDs. | `--json`       |
| `openclaw catalog audit`       | Group catalog surfaces and command routes for audit and policy review.                                                                                                          | `--json`       |
| `openclaw catalog test-matrix` | List routed-operation smoke-test candidates and explicit coverage gaps.                                                                                                         | `--json`       |
| `openclaw catalog summary`     | Summarize catalog inventory for operator and admin handoffs.                                                                                                                    | `--json`       |

## Lens counts

| Lens              | Generated from                         | Key counts                                                                                                                                                               |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List              | `cli-catalog-overlay`                  | descriptors 61; routes 97; routed operations 14; catalog surfaces 5; runtime commands dynamic; plugin commands opt-in; node/operator commands supplied by runtime owners |
| Audit             | `cli-catalog-overlay-audit`            | confirmation-required surfaces 2; route policy keys 8                                                                                                                    |
| Test matrix       | `cli-catalog-overlay-test-matrix`      | smoke candidates 14; coverage gaps 14                                                                                                                                    |
| Summary           | `cli-catalog-overlay-operator-summary` | coverage gaps 14; policy keys 8                                                                                                                                          |
| Prompt projection | `cli-catalog-overlay-prompt`           | prompt surfaces 19                                                                                                                                                       |

## JSON contracts

| Output                       | Schema version | Stable fields                                                                                     |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `catalog list --json`        | 1              | `agentToolSurfaces`, `cli`, `counts`, `generatedFrom`, `promptProjection`, `schemaVersion`        |
| `catalog audit --json`       | 1              | `commandRoutes`, `counts`, `generatedFrom`, `nodeCommands`, `schemaVersion`, `surfaces`           |
| `catalog test-matrix --json` | 1              | `candidates`, `counts`, `coverageGaps`, `generatedFrom`, `nodeCommandCandidates`, `schemaVersion` |
| `catalog summary --json`     | 1              | `attention`, `counts`, `generatedFrom`, `nextChecks`, `schemaVersion`                             |

Checked schema fixtures live under `test/fixtures/cli-catalog-overlay/` and intentionally treat inventory counts as reviewable snapshots, not eternal compatibility promises.

## Dynamic command inventory

The generated reference intentionally snapshots static descriptors, command routes, routed operations, catalog surfaces, and prompt projection metadata. `openclaw catalog list` also fills `cli.runtimeCommands` from the current Commander tree at command execution time, `cli.pluginCommands` when `--plugin-descriptors` is requested, and `cli.nodeCommands` when node/gateway owners supply approved command metadata. Inspect those dynamic arrays with `openclaw catalog list --json` instead of treating this generated page as a complete runtime/plugin/node inventory dump.

| Field                 | Scope                                                                    | How to inspect                                      |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `cli.runtimeCommands` | Current invocation Commander tree                                        | `openclaw catalog list --json`                      |
| `cli.pluginCommands`  | Metadata-only plugin descriptor entries requested on demand              | `openclaw catalog list --json --plugin-descriptors` |
| `cli.nodeCommands`    | Node/operator commands supplied by pairing, gateway, or node-host owners | `openclaw catalog list --json`                      |

## CLI descriptors

| Descriptor       | Description                                                                                                         | Source   | Discovery           | Subcommands |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | ----------- |
| `crestodian`     | Open the ring-zero setup and repair helper                                                                          | `core`   | `static-descriptor` | no          |
| `setup`          | Alias for openclaw onboard                                                                                          | `core`   | `static-descriptor` | no          |
| `onboard`        | Guided setup for auth, models, Gateway, workspace, channels, and skills                                             | `core`   | `static-descriptor` | no          |
| `configure`      | Interactive configuration for credentials, channels, gateway, and agent defaults                                    | `core`   | `static-descriptor` | no          |
| `config`         | Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup. | `core`   | `static-descriptor` | yes         |
| `backup`         | Create and verify local backup archives for OpenClaw state                                                          | `core`   | `static-descriptor` | yes         |
| `migrate`        | Import state from another agent system                                                                              | `core`   | `static-descriptor` | yes         |
| `doctor`         | Health checks + quick fixes for the gateway and channels                                                            | `core`   | `static-descriptor` | no          |
| `dashboard`      | Open the Control UI with your current token                                                                         | `core`   | `static-descriptor` | no          |
| `reset`          | Reset local config/state (keeps the CLI installed)                                                                  | `core`   | `static-descriptor` | no          |
| `uninstall`      | Uninstall the gateway service + local data (CLI remains)                                                            | `core`   | `static-descriptor` | no          |
| `message`        | Send, read, and manage messages and channel actions                                                                 | `core`   | `static-descriptor` | yes         |
| `mcp`            | Manage OpenClaw mcp.servers config and channel bridge                                                               | `core`   | `static-descriptor` | yes         |
| `transcripts`    | Inspect stored transcripts                                                                                          | `core`   | `static-descriptor` | yes         |
| `agent`          | Run an agent turn via the Gateway (use --local for embedded)                                                        | `core`   | `static-descriptor` | no          |
| `agents`         | Manage isolated agents (workspaces + auth + routing)                                                                | `core`   | `static-descriptor` | yes         |
| `status`         | Show channel health and recent session recipients                                                                   | `core`   | `static-descriptor` | no          |
| `health`         | Fetch health from the running gateway                                                                               | `core`   | `static-descriptor` | no          |
| `audit`          | Inspect metadata-only agent run and tool action records                                                             | `core`   | `static-descriptor` | no          |
| `sessions`       | List stored conversation sessions                                                                                   | `core`   | `static-descriptor` | yes         |
| `commitments`    | List and manage inferred follow-up commitments                                                                      | `core`   | `static-descriptor` | yes         |
| `tasks`          | Inspect durable background tasks and TaskFlow state                                                                 | `core`   | `static-descriptor` | yes         |
| `acp`            | Run an ACP bridge backed by the Gateway                                                                             | `subcli` | `static-descriptor` | yes         |
| `gateway`        | Run, inspect, and query the WebSocket Gateway                                                                       | `subcli` | `static-descriptor` | yes         |
| `daemon`         | Manage the Gateway service (launchd/systemd/schtasks)                                                               | `subcli` | `static-descriptor` | yes         |
| `logs`           | Tail gateway file logs via RPC                                                                                      | `subcli` | `static-descriptor` | no          |
| `system`         | System tools (events, heartbeat, presence)                                                                          | `subcli` | `static-descriptor` | yes         |
| `models`         | Model discovery, scanning, and configuration                                                                        | `subcli` | `static-descriptor` | yes         |
| `promos`         | Discover and claim promotional model offers from ClawHub                                                            | `subcli` | `static-descriptor` | yes         |
| `catalog`        | List OpenClaw catalog metadata                                                                                      | `subcli` | `static-descriptor` | yes         |
| `infer`          | Run provider-backed inference commands through a stable CLI surface                                                 | `subcli` | `static-descriptor` | yes         |
| `capability`     | Run provider capability commands (fallback alias: infer)                                                            | `subcli` | `static-descriptor` | yes         |
| `approvals`      | Manage exec approvals (gateway or node host)                                                                        | `subcli` | `static-descriptor` | yes         |
| `exec-approvals` | Manage exec approvals (alias for approvals)                                                                         | `subcli` | `static-descriptor` | yes         |
| `exec-policy`    | Show or synchronize requested exec policy with host approvals                                                       | `subcli` | `static-descriptor` | yes         |
| `nodes`          | Manage gateway-owned nodes (pairing, status, invoke, and media)                                                     | `subcli` | `static-descriptor` | yes         |
| `devices`        | Device pairing and auth tokens                                                                                      | `subcli` | `static-descriptor` | yes         |
| `node`           | Run and manage the headless node host service                                                                       | `subcli` | `static-descriptor` | yes         |
| `sandbox`        | Manage sandbox containers (Docker-based agent isolation)                                                            | `subcli` | `static-descriptor` | yes         |
| `worktrees`      | Create, inspect, restore, and clean up managed worktrees                                                            | `subcli` | `static-descriptor` | yes         |
| `attach`         | Attach Claude Code to a gateway session with scoped MCP tools                                                       | `subcli` | `static-descriptor` | no          |
| `tui`            | Open a terminal UI connected to the Gateway                                                                         | `subcli` | `static-descriptor` | no          |
| `terminal`       | Open a local terminal UI (alias for tui --local)                                                                    | `subcli` | `static-descriptor` | no          |
| `chat`           | Open a local terminal UI (alias for tui --local)                                                                    | `subcli` | `static-descriptor` | no          |
| `cron`           | Manage cron jobs (via Gateway)                                                                                      | `subcli` | `static-descriptor` | yes         |
| `dns`            | DNS helpers for wide-area discovery (Tailscale + CoreDNS)                                                           | `subcli` | `static-descriptor` | yes         |
| `docs`           | Search the live OpenClaw docs                                                                                       | `subcli` | `static-descriptor` | no          |
| `proxy`          | Run the OpenClaw debug proxy and inspect captured traffic                                                           | `subcli` | `static-descriptor` | yes         |
| `hooks`          | Manage internal agent hooks                                                                                         | `subcli` | `static-descriptor` | yes         |
| `webhooks`       | Webhook helpers and integrations                                                                                    | `subcli` | `static-descriptor` | yes         |
| `qr`             | Generate a mobile pairing QR code and setup code                                                                    | `subcli` | `static-descriptor` | no          |
| `clawbot`        | Legacy clawbot command aliases                                                                                      | `subcli` | `static-descriptor` | yes         |
| `pairing`        | Secure DM pairing (approve inbound requests)                                                                        | `subcli` | `static-descriptor` | yes         |
| `plugins`        | Manage OpenClaw plugins and extensions                                                                              | `subcli` | `static-descriptor` | yes         |
| `channels`       | Manage connected chat channels and accounts                                                                         | `subcli` | `static-descriptor` | yes         |
| `directory`      | Lookup contact and group IDs (self, peers, groups) for supported chat channels                                      | `subcli` | `static-descriptor` | yes         |
| `security`       | Audit local config and state for common security foot-guns                                                          | `subcli` | `static-descriptor` | yes         |
| `secrets`        | Secrets runtime controls                                                                                            | `subcli` | `static-descriptor` | yes         |
| `skills`         | List and inspect available skills                                                                                   | `subcli` | `static-descriptor` | yes         |
| `update`         | Update OpenClaw and inspect update channel status                                                                   | `subcli` | `static-descriptor` | yes         |
| `completion`     | Generate shell completion script                                                                                    | `subcli` | `static-descriptor` | no          |

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

## Agent and tool surfaces

| Surface          | Owner     | Risk     | Effect mode | Confirmation | Target           | Discovery           |
| ---------------- | --------- | -------- | ----------- | ------------ | ---------------- | ------------------- |
| `skill_workshop` | `agents`  | `medium` | `mixed`     | yes          | `skill_workshop` | `explicit-overlay`  |
| `session_status` | `agents`  | `low`    | `read`      | no           | `session_status` | `explicit-overlay`  |
| `sessions_spawn` | `agents`  | `low`    | `mutating`  | no           | `sessions_spawn` | `explicit-overlay`  |
| `process`        | `agents`  | `low`    | `mixed`     | no           | `process`        | `explicit-overlay`  |
| `gateway`        | `runtime` | `medium` | `mixed`     | yes          | `gateway`        | `static-descriptor` |

## Prompt projection

| Surface           | Kind               | Target            | Risk     | Command hints                                                                                     |
| ----------------- | ------------------ | ----------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `agents-list`     | `routed-operation` | `agents`          | `low`    | `agents`, `agents list`                                                                           |
| `channels-list`   | `routed-operation` | `channels list`   | `low`    | `channels list`                                                                                   |
| `channels-status` | `routed-operation` | `channels status` | `low`    | `channels status`                                                                                 |
| `config-get`      | `routed-operation` | `config get`      | `low`    | `config get`                                                                                      |
| `config-unset`    | `routed-operation` | `config unset`    | `medium` | `config unset`                                                                                    |
| `gateway-status`  | `routed-operation` | `gateway status`  | `low`    | `gateway status`                                                                                  |
| `health`          | `routed-operation` | `health`          | `low`    | `health`                                                                                          |
| `models-list`     | `routed-operation` | `models list`     | `low`    | `models list`                                                                                     |
| `models-status`   | `routed-operation` | `models status`   | `low`    | `models status`                                                                                   |
| `plugins-list`    | `routed-operation` | `plugins list`    | `low`    | `plugins list`                                                                                    |
| `sessions`        | `routed-operation` | `sessions`        | `low`    | `sessions`                                                                                        |
| `status`          | `routed-operation` | `status`          | `low`    | `status`                                                                                          |
| `tasks-audit`     | `routed-operation` | `tasks audit`     | `low`    | `tasks audit`                                                                                     |
| `tasks-list`      | `routed-operation` | `tasks list`      | `low`    | `tasks list`, `tasks`                                                                             |
| `skill_workshop`  | `tool`             | `skill_workshop`  | `medium` | `skill_workshop action=create\|update\|revise`, `skill_workshop action=apply\|reject\|quarantine` |
| `session_status`  | `tool`             | `session_status`  | `low`    | `session_status`                                                                                  |
| `sessions_spawn`  | `tool`             | `sessions_spawn`  | `low`    | `sessions_spawn`                                                                                  |
| `process`         | `command`          | `process`         | `low`    | `process list`, `process poll`, `process log`, `process write`                                    |
| `gateway`         | `command`          | `gateway`         | `medium` | `gateway status`, `gateway restart`, `gateway config.schema.lookup`, `gateway config.apply`       |

## Consumer contract

The catalog contract is read-only. External consumers should use the JSON commands instead of scraping help text. Builder modules remain repo-internal until package exports are added deliberately.

| Area                      | Values                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumers                 | `policy`, `admin`, `diagnostics`, `prompt`, `ci-report`                                                                                                                                                                                                        |
| Stable external commands  | `openclaw catalog list --json`, `openclaw catalog audit --json`, `openclaw catalog test-matrix --json`, `openclaw catalog summary --json`                                                                                                                      |
| Advisory report artifacts | `catalog-audit.json`, `catalog-summary.json`, `catalog-test-matrix.json`, `catalog-report.md`                                                                                                                                                                  |
| Repo-internal builders    | `src/cli-catalog-overlay/list.js`, `src/cli-catalog-overlay/audit.js`, `src/cli-catalog-overlay/test-matrix.js`, `src/cli-catalog-overlay/operator-summary.js`, `src/cli-catalog-overlay/prompt-projection.js`, `src/cli-catalog-overlay/consumer-contract.js` |
| Contract notes            | Use the catalog JSON commands as the stable external read path.; Treat advisory report artifacts as review outputs, not as the durable public API.; Add package exports deliberately before importing catalog builders outside the repo.                       |
| Non-goals                 | The catalog does not execute commands.; The catalog does not enforce policy decisions.; The catalog does not make inventory counts permanent compatibility promises.                                                                                           |

| JSON output                           | Stable fields                                                                                     | Snapshot fields                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `openclaw catalog list --json`        | `schemaVersion`, `generatedFrom`, `counts`, `cli`, `agentToolSurfaces`, `promptProjection`        | `counts.*`, `cli.descriptors`, `cli.commandRoutes`, `cli.runtimeCommands`, `cli.pluginCommands`, `cli.nodeCommands` |
| `openclaw catalog audit --json`       | `schemaVersion`, `generatedFrom`, `counts`, `surfaces`, `commandRoutes`, `nodeCommands`           | `counts.*`, `surfaces.*`, `commandRoutes.byPolicyKey`, `commandRoutes.routesWithoutPolicyKeys`, `nodeCommands.*`    |
| `openclaw catalog test-matrix --json` | `schemaVersion`, `generatedFrom`, `counts`, `candidates`, `nodeCommandCandidates`, `coverageGaps` | `counts.*`, `candidates`, `nodeCommandCandidates`, `coverageGaps`                                                   |
| `openclaw catalog summary --json`     | `schemaVersion`, `generatedFrom`, `counts`, `attention`, `nextChecks`                             | `counts.*`, `attention.*`, `nextChecks`                                                                             |

## Audit and operator attention

| Area                  | Values                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmation required | `gateway`, `skill_workshop`                                                                                                                   |
| Medium risk           | `gateway`, `skill_workshop`                                                                                                                   |
| Mixed effect mode     | `gateway`, `process`, `skill_workshop`                                                                                                        |
| Route policy keys     | `bypassConfigGuard`, `ensureCliPath`, `hideBanner`, `loadPlugins`, `networkProxy`, `ownsProtocolStdout`, `pluginRegistry`, `routeConfigGuard` |
