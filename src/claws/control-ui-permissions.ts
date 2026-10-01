import type {
  ClawConfiguredPermissions,
  ClawPermissionDisclosure,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { resolveMemorySearchIndexConfig } from "../agents/memory-search.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import {
  resolveSubagentAllowedTargetIds,
  resolveSubagentTargetPolicy,
} from "../agents/subagents/spawn/subagent-target-policy.js";
import { resolveConfiguredToolAccess } from "../agents/tool-access-diagnostics.js";
import { listCoreToolSections } from "../agents/tool-catalog.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { isClawToolPolicyConsentResolutionError } from "./tool-policy-runtime.js";

function configuredMemorySearch(
  config: OpenClawConfig,
  agentId: string,
): ClawConfiguredPermissions["memorySearch"] {
  try {
    const memory = resolveMemorySearchIndexConfig(config, agentId);
    if (!memory) {
      return { state: "disabled" };
    }
    return {
      state: "configured",
      rememberAcrossConversations: memory.rememberAcrossConversations,
      sessionMemory: memory.experimental.sessionMemory,
      indexedSources: memory.sources.toSorted(),
      searchSources: memory.searchSources.toSorted(),
      extraPathCount: memory.extraPaths.length,
    };
  } catch (error) {
    if (
      !isTrustedSecretSurfaceUnavailableError(error) ||
      error.ownerKind !== "capability" ||
      error.ownerId !== runtimeMemorySecretOwnerId(agentId)
    ) {
      throw error;
    }
    return { state: "unresolved" };
  }
}

function configuredSubagentTargets(
  config: OpenClawConfig,
  agentId: string,
): ClawConfiguredPermissions["subagentTargets"] {
  const subagents = resolveAgentConfig(config, agentId)?.subagents;
  const defaults = config.agents?.defaults?.subagents;
  const requireAgentId = subagents?.requireAgentId ?? defaults?.requireAgentId ?? false;
  const policy = {
    requesterAgentId: agentId,
    allowAgents: subagents?.allowAgents ?? defaults?.allowAgents,
    configuredAgentIds: listAgentIds(config),
  };
  const targets = resolveSubagentAllowedTargetIds(policy);
  return {
    explicitAgentIds: targets.allowedIds,
    allowAnyConfiguredAgent: targets.allowAny,
    // Spawn admission checks requireAgentId before applying the implicit-self exception.
    implicitSelfAllowed:
      !requireAgentId && resolveSubagentTargetPolicy({ ...policy, targetAgentId: agentId }).ok,
    requireAgentId,
  };
}

function configuredPermissions(config: OpenClawConfig, agentId: string): ClawConfiguredPermissions {
  const access = resolveConfiguredToolAccess({
    config,
    agentId,
    toolNames: listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id)),
  });
  const sandbox = resolveSandboxConfigForAgent(config, agentId);
  const heartbeat = resolveHeartbeatSummaryForAgent(config, agentId);
  // Never serialize resolver objects: they can contain paths, prompts, and credentials.
  return {
    tools: {
      allowed: access.tools
        .filter((tool) => tool.status === "allowed")
        .map((tool) => tool.id)
        .sort(),
      excluded: access.tools
        .filter((tool) => tool.status === "excluded")
        .map((tool) => tool.id)
        .sort(),
    },
    sandbox: {
      mode: sandbox.mode,
      scope: sandbox.scope,
      workspaceAccess: sandbox.workspaceAccess,
      backend:
        sandbox.backend === "docker" || sandbox.backend === "ssh" ? sandbox.backend : "other",
    },
    filesystem: { workspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }) },
    heartbeat: { enabled: heartbeat.enabled, intervalMs: heartbeat.everyMs },
    memorySearch: configuredMemorySearch(config, agentId),
    subagentTargets: configuredSubagentTargets(config, agentId),
  };
}

/** Configuration facts are not a live-session permission grant or complete consent. */
export function buildClawPermissionDisclosure(params: {
  config: OpenClawConfig;
  operation: "add" | "update";
  agentId: string;
  desiredAgent?: AgentConfig;
}): ClawPermissionDisclosure {
  const { config, operation, agentId, desiredAgent } = params;
  const configuredAgents = listAgentEntries(config);
  // Match the add executor's preserved implicit owner, including collisions with main.
  const agents: AgentConfig[] =
    operation === "add" && configuredAgents.length === 0
      ? [{ id: DEFAULT_AGENT_ID, default: true }]
      : configuredAgents;
  const currentIndex = agents.findIndex((agent) => normalizeAgentId(agent.id) === agentId);
  const disclosure: ClawPermissionDisclosure = {
    coverage: "configuration-only",
    unresolved: ["runtime-tools", "sandbox-runtime", "memory", "delegation", "scheduled-jobs"],
  };
  const snapshot = (
    snapshotConfig: OpenClawConfig,
    unresolved: "current-agent" | "target-agent",
  ) => {
    try {
      return configuredPermissions(snapshotConfig, agentId);
    } catch (error) {
      if (!isClawToolPolicyConsentResolutionError(error)) {
        throw error;
      }
      // Repair previews must survive rejected consent without inventing replacement permissions.
      disclosure.unresolved.push(unresolved);
      return undefined;
    }
  };
  if (operation === "update" && currentIndex !== -1) {
    const current = snapshot(config, "current-agent");
    if (current) {
      disclosure.current = current;
    }
  }
  if (!desiredAgent || (operation === "add" && currentIndex !== -1)) {
    disclosure.unresolved.push("target-agent");
    return disclosure;
  }
  const desiredAgents: AgentConfig[] =
    currentIndex === -1
      ? [...agents, desiredAgent]
      : agents.map((agent, index) => (index === currentIndex ? desiredAgent : agent));
  const desiredConfig: OpenClawConfig = {
    ...config,
    agents: { ...config.agents, entries: toAgentEntriesRecord(desiredAgents) },
  };
  const desired = snapshot(desiredConfig, "target-agent");
  if (desired) {
    disclosure.desired = desired;
  }
  return disclosure;
}
