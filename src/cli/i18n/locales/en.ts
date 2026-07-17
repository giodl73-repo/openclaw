import type { LocalizationCatalog } from "@openclaw/localization-core";

export const CLI_ENGLISH_CATALOG = {
  "cli.acp.provenance.invalid": 'Invalid --provenance. Use "off", "meta", or "meta+receipt".',
  "cli.acp.bridge.failed": "ACP bridge failed: {error}",
  "cli.capability.unknown": "Unknown capability: {capabilityId}",
  "cli.gatewayStatus.requireRpcNeedsProbe":
    "Gateway status failed: --require-rpc needs probing enabled. Remove --no-probe or drop --require-rpc.",
  "cli.gatewayStatus.failed": "Gateway status failed: {error}",
  "cli.update.timeout.invalid": "--timeout must be a positive integer (seconds)",
  "cli.update.wizard.ttyRequired":
    "Update wizard requires a TTY. Use `openclaw update --channel <stable|extended-stable|beta|dev>` instead.",
  "cli.updateStatus.heading": "OpenClaw update status",
  "cli.updateStatus.header.item": "Item",
  "cli.updateStatus.header.value": "Value",
  "cli.updateStatus.row.install": "Install",
  "cli.updateStatus.row.channel": "Channel",
  "cli.updateStatus.row.git": "Git",
  "cli.updateStatus.row.update": "Update",
  "cli.updateStatus.available": "available",
  "cli.updateStatus.unknown": "unknown",
  "cli.updateStatus.git.detached": "detached",
  "cli.updateStatus.git.tag": "tag {tag}",
  "cli.updateStatus.channel.config": "{channel} (config)",
  "cli.updateStatus.channel.gitTag": "{channel} ({tag})",
  "cli.updateStatus.channel.tag": "{channel} (tag)",
  "cli.updateStatus.channel.gitBranch": "{channel} ({branch})",
  "cli.updateStatus.channel.branch": "{channel} (branch)",
  "cli.updateStatus.channel.installedVersion": "{channel} (installed version)",
  "cli.updateStatus.channel.default": "{channel} (default)",
  "cli.updateStatus.summary.label": "Update",
  "cli.updateStatus.summary.dirty": "dirty",
  "cli.updateStatus.summary.upToDate": "up to date",
  "cli.updateStatus.summary.behind": "behind {count}",
  "cli.updateStatus.summary.ahead": "ahead {count}",
  "cli.updateStatus.summary.diverged": "diverged (ahead {ahead}, behind {behind})",
  "cli.updateStatus.summary.fetchFailed": "fetch failed",
  "cli.updateStatus.summary.taggedRegistryUpdate": "{registryLabel} update {version}",
  "cli.updateStatus.summary.npmUpdate": "npm update {version}",
  "cli.updateStatus.summary.aheadOfExtendedStable": "ahead of extended-stable ({version})",
  "cli.updateStatus.summary.localNewer": "{registryLabel} {version} (local newer)",
  "cli.updateStatus.summary.extendedStableRequiresPackage":
    "extended-stable requires a package install",
  "cli.updateStatus.summary.extendedStableSelectorMissing": "npm extended-stable selector missing",
  "cli.updateStatus.summary.extendedStableQueryFailed": "npm extended-stable query failed",
  "cli.updateStatus.summary.extendedStableVerificationFailed":
    "npm extended-stable exact package verification failed",
  "cli.updateStatus.summary.registryUnknown": "{registryLabel} unknown",
  "cli.updateStatus.summary.depsOk": "deps ok",
  "cli.updateStatus.summary.depsMissing": "deps missing",
  "cli.updateStatus.summary.depsStale": "deps stale",
  "cli.updateStatus.hint.gitBehind": "git behind {count}",
  "cli.updateStatus.hint.available": "Update available ({details}). Run: {command}",
  "cli.validation.timeout.positiveMilliseconds":
    "--timeout must be a positive integer (milliseconds)",
  "cli.tasks.audit.limit.invalid": "--limit must be a positive integer, for example --limit 25.",
  "cli.sessions.compact.parentOptionUnsupported":
    "`sessions compact` does not support the parent `sessions` option {options}; the gateway resolves the target store from <key> and --agent.",
  "cli.sessions.compact.parentOptionsUnsupported":
    "`sessions compact` does not support the parent `sessions` options {options}; the gateway resolves the target store from <key> and --agent.",
  "cli.sessions.compact.maxLines.invalid": "--max-lines must be a positive integer.",
  "cli.sessions.compact.timeout.invalid": "--timeout must be a positive integer (milliseconds).",
  "cli.agent.message.missing": "Missing message. Use {inlineCommand} or {fileCommand}.",
  "cli.agent.messageFile.notFound": "Message file not found: {path}",
  "cli.agent.messageFile.isDirectory": "Message file is a directory: {path}",
  "cli.agent.messageFile.readFailure": "Unable to read message file {path}: {error}",
  "cli.agent.messageFile.invalidUtf8": "Message file must be valid UTF-8: {path}",
  "cli.agent.messageFile.conflict": "Use either --message or --message-file, not both.",
  "cli.agent.messageFile.emptyOption": "--message-file must not be empty.",
  "cli.agent.messageFile.empty": "Message file is empty: {path}",
  "cli.agent.timeout.invalid":
    "Invalid --timeout. Use seconds as a non-negative integer, for example --timeout 600. Use --timeout 0 to disable the timeout.",
  "cli.agent.sessionKey.invalid":
    'Invalid --session-key "{sessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.',
  "cli.agent.sessionKey.agentMismatch":
    'Agent id "{agentId}" does not match session key agent "{sessionAgentId}".',
  "cli.agent.target.missing":
    "No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>. Run {agentsListCommand} to see agents.",
  "cli.agent.agentId.unknown":
    'Unknown agent id "{agentId}". Use "{agentsListCommand}" to see configured agents.',
  "cli.agent.progress.waiting": "Waiting for agent reply…",
  "cli.agent.response.inFlight":
    "Agent run {runId} is already in flight; not starting a duplicate run.",
  "cli.agent.response.inFlightUnknown":
    "Agent run is already in flight; not starting a duplicate run.",
  "cli.agent.response.attachment": "Attachment: {url}",
  "cli.agent.response.noReply": "No reply from agent.",
  "cli.agent.response.retrying":
    "Gateway agent connection closed during handshake; retrying in {retryDelayMs}ms before embedded fallback.",
  "cli.agent.response.retryExhausted": "Gateway agent retry loop exhausted unexpectedly.",
  "cli.agent.fallback.timeout":
    "EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session {sessionId}: {error}",
  "cli.agent.fallback.failed":
    "EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: {error}",
  "cli.agent.compact.unsupported":
    "Slash commands cannot be executed via --message from the CLI. Use: {compactCommand}",
} as const satisfies LocalizationCatalog;

export type CliMessageKey = keyof typeof CLI_ENGLISH_CATALOG;
