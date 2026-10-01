import type { ClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/claws.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withResolvedClawHubSource,
  type ClawHubCoordinate,
  type ClawHubSourceTrust,
} from "./clawhub-source.js";
import { buildClawPermissionDisclosure } from "./control-ui-permissions.js";
import { addClawControlUiSafetyBlockers } from "./control-ui-safety.js";
import { buildClawAddScheduledJobs } from "./control-ui-scheduled-jobs.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import type { ClawInventory } from "./inventory-read.kernel.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { preflightClawPackage } from "./packages.js";
import type { ClawAddPlan, ClawReadResult } from "./types.js";

export function projectClawAddPlan(
  plan: ClawAddPlan,
  trust: ClawHubSourceTrust,
  config: OpenClawConfig,
): ClawLifecyclePlanResult {
  const projection = {
    schemaVersion: "openclaw.clawsGatewayPlan.v1" as const,
    operation: "add" as const,
    target: {
      agentId: plan.agent.finalId,
      name: plan.claw.name,
      targetVersion: plan.claw.version,
      ...(trust.publisher ? { publisher: trust.publisher } : {}),
    },
    actions: plan.actions.map(({ kind, id, action, blocked }) => ({
      kind,
      id,
      action,
      blocked,
      ...(blocked ? { reason: "Current OpenClaw state blocks this action." } : {}),
    })),
    capabilities: plan.capabilityChanges.map(({ kind, id, action }) => ({
      kind,
      id,
      action,
      reason: "The Claw requires this capability.",
    })),
    blockers: plan.blockers.map(({ code, path }) => ({
      code,
      path,
      message:
        code === "plugin_consent_unavailable"
          ? "Plugin capability consent is not available through the Claws Control UI."
          : "Resolve this OpenClaw state conflict before continuing.",
    })),
    readiness: {
      ready: plan.readiness.ready,
      requirements: plan.readiness.requirements.map((requirement) => ({
        kind: requirement.kind,
        owner:
          requirement.kind === "plugin-setup"
            ? `${requirement.plugin}/${requirement.provider}`
            : requirement.mcpServer,
      })),
    },
    riskAcknowledgementRequired: trust.riskAcknowledgementRequired,
    scheduledJobs: buildClawAddScheduledJobs(plan),
    effectivePermissions: buildClawPermissionDisclosure({
      config,
      operation: "add",
      agentId: plan.agent.finalId,
      desiredAgent: plan.agent.config,
    }),
    ...(trust.trustWarning ? { trustWarning: trust.trustWarning } : {}),
  };
  return {
    ...projection,
    planIntegrity: digestClawValue({
      canonicalPlanIntegrity: plan.planIntegrity,
      trustIntegrity: trust.integrity,
      projection,
    }),
  };
}

export async function planClawAddFromCatalog(params: {
  source: ClawHubCoordinate;
  agentId?: string;
  getRuntimeConfig: () => OpenClawConfig;
}): Promise<ClawLifecyclePlanResult> {
  const result = await withResolvedClawHubSource({
    coordinate: params.source,
    run: async (loaded, trust) => {
      const inventory = await readClawInventory();
      const config = params.getRuntimeConfig();
      const plan = await buildClawControlUiAddPlan({
        loaded,
        config,
        inventory,
        agentId: params.agentId,
      });
      return projectClawAddPlan(plan, trust, config);
    },
  });
  return result.value;
}

export async function buildClawControlUiAddPlan(params: {
  loaded: Extract<ClawReadResult, { ok: true }>;
  config: OpenClawConfig;
  inventory: ClawInventory;
  agentId?: string;
}): Promise<ClawAddPlan> {
  const { loaded, config, inventory } = params;
  const configuredAgentIds = listAgentIds(config);
  const plan = await buildClawAddPlan({
    manifest: loaded.manifest,
    clawMarkdownBody: loaded.clawMarkdownBody,
    packageBootstrap: loaded.packageBootstrap,
    openClawProfile: loaded.openClawProfile,
    source: loaded.source,
    diagnostics: loaded.diagnostics,
    context: {
      config,
      agentId: params.agentId,
      existingAgentIds: [
        ...configuredAgentIds,
        ...inventory.installs.map((install) => install.agentId),
      ],
      existingWorkspacePaths: [
        ...configuredAgentIds.map((id) => resolveAgentWorkspaceDir(config, id)),
        ...inventory.installs.map((install) => install.workspace),
      ],
      existingMcpServers: normalizeConfiguredMcpServers(config.mcp?.servers),
      packagePreflight: preflightClawPackage,
      // The canonical planner stabilizes only source paths, never arbitrary manifest strings.
      sourceReferenceRoot: "$CLAW_SOURCE",
    },
  });
  return addClawControlUiSafetyBlockers(plan, loaded);
}
