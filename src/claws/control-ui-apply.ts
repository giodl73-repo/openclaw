import path from "node:path";
import type {
  ClawLifecyclePlanResult,
  ClawLifecycleApplyResult,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { applyClawAddPlan } from "./add.js";
import { withResolvedClawHubSource } from "./clawhub-source.js";
import { createClawControlUiCronGateway } from "./control-ui-cron-gateway.js";
import { buildClawControlUiAddPlan, projectClawAddPlan } from "./control-ui-plan.js";
import { withClawControlUiUpdatePlan } from "./control-ui-update-plan.js";
import type {
  ClawControlUiCommand,
  ClawControlUiHost,
  ClawControlUiWorkerResult,
} from "./control-ui-worker-contract.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "./lifecycle-state.js";
import {
  clawMonitorCleanupBindingSchema,
  clawMonitorInventorySchema,
  type ClawMonitorCleanupGateway,
} from "./monitor-cleanup-contract.js";
import { clawPackageRemovalResultSchema } from "./package-remove-contract.js";
import { preflightClawPackage } from "./packages.js";
import type { ClawAddPlan } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";

function addPlanSemantics(plan: ClawAddPlan, physical = false): string {
  const { planIntegrity: _integrity, ...rest } = plan;
  const sourcePath = (value: string) =>
    physical
      ? ["$CLAW_SOURCE", ...path.relative(plan.claw.packageRoot, value).split(path.sep)].join("/")
      : value;
  return digestClawValue({
    ...rest,
    claw: {
      ...plan.claw,
      packageRoot: "$CLAW_SOURCE",
      manifestPath: sourcePath(plan.claw.manifestPath),
    },
    actions: plan.actions.map((action) => ({
      ...action,
      ...(action.source ? { source: sourcePath(action.source) } : {}),
    })),
  });
}

function requireReviewedPlan(
  plan: ClawLifecyclePlanResult,
  integrity: string,
  acknowledgeRisk = false,
) {
  if (plan.blockers.length || plan.actions.some((action) => action.blocked)) {
    throw new Error("The Claw plan contains blockers; review it again.");
  }
  if (plan.planIntegrity !== integrity) {
    throw new Error("The Claw plan changed; review it again before applying.");
  }
  if (plan.riskAcknowledgementRequired && !acknowledgeRisk) {
    throw new Error("Review and acknowledge the ClawHub warning before applying.");
  }
}

export function projectClawRemovePlan(plan: ClawRemovePlan): ClawLifecyclePlanResult {
  const projection = {
    schemaVersion: "openclaw.clawsGatewayPlan.v1" as const,
    operation: "remove" as const,
    target: { ...(plan.agentId ? { agentId: plan.agentId } : {}) },
    actions: plan.actions.map(({ kind, id, action, blocked }, index) => ({
      kind,
      id: kind === "scheduledJob" ? `scheduled-work-${index + 1}` : id,
      action,
      blocked,
    })),
    capabilities: [],
    blockers: plan.blockers.map(({ code }) => ({
      code,
      path: "$.target",
      message: "Resolve this Claw state conflict before uninstalling.",
    })),
    riskAcknowledgementRequired: false,
  };
  return {
    ...projection,
    planIntegrity: digestClawValue({ canonicalPlanIntegrity: plan.planIntegrity, projection }),
  };
}

function completion(
  operation: "add" | "update" | "remove",
  agentId: string,
  status: "complete" | "partial",
): ClawLifecycleApplyResult {
  return {
    schemaVersion: "openclaw.clawsGatewayApply.v1",
    operation,
    agentId,
    status,
    message:
      status === "complete"
        ? operation === "remove"
          ? "Claw uninstalled. Retained resources follow the reviewed plan."
          : "Claw changes applied."
        : "Claw changes are incomplete. Review inventory and diagnostics before continuing.",
  };
}

/** Runs only in an owned worker; canonical lifecycle functions remain the state writers. */
export async function executeClawControlUiOperation(
  command: ClawControlUiCommand,
  host: ClawControlUiHost,
  beforePersistentApply: () => void,
): Promise<ClawControlUiWorkerResult> {
  const request = (method: string, params: Record<string, unknown> = {}) =>
    host({ method, params });
  const getRuntimeConfig = async () => (await request("config")) as OpenClawConfig;
  const readyCompletion = async (
    operation: "add" | "update",
    agentId: string,
    status: "complete" | "partial",
  ) => {
    if (status === "complete") {
      try {
        await request("agent.ready", { agentId });
      } catch {
        return completion(operation, agentId, "partial");
      }
    }
    return completion(operation, agentId, status);
  };
  const cronGateway = createClawControlUiCronGateway(host);
  if (command.operation === "add") {
    const params = command.params;
    const result = await withResolvedClawHubSource({
      coordinate: params.source,
      beforePersistentApply,
      run: async (loaded, trust, persistSource) => {
        let config = await getRuntimeConfig();
        let inventory = await readClawInventory();
        const prepare = () =>
          buildClawControlUiAddPlan({ loaded, config, inventory, agentId: params.agentId });
        requireReviewedPlan(
          projectClawAddPlan(await prepare(), trust, config),
          params.planIntegrity,
          params.acknowledgeClawHubRisk,
        );
        loaded = await persistSource();
        config = await getRuntimeConfig();
        inventory = await readClawInventory();
        const reviewed = await prepare();
        requireReviewedPlan(
          projectClawAddPlan(reviewed, trust, config),
          params.planIntegrity,
          params.acknowledgeClawHubRisk,
        );
        const plan = await buildClawControlUiAddPlan({
          loaded,
          config,
          inventory,
          agentId: params.agentId,
          physicalSource: true,
        });
        if (addPlanSemantics(reviewed) !== addPlanSemantics(plan, true)) {
          throw new Error("The Claw plan changed before installation; review it again.");
        }
        beforePersistentApply();
        const applied = await applyClawAddPlan(plan, {
          consentPlanIntegrity: plan.planIntegrity,
          beforePersistentApply,
          cronGateway,
        });
        return await readyCompletion("add", applied.agent.finalId, applied.status);
      },
    });
    return result.value;
  }
  if (command.operation === "update") {
    const params = command.params;
    return await withClawControlUiUpdatePlan(
      { ...params, getRuntimeConfig, beforePersistentApply },
      async ({ plan, preview, persistSource, config }) => {
        requireReviewedPlan(preview, params.planIntegrity, params.acknowledgeClawHubRisk);
        const loaded = await persistSource();
        if (digestClawValue(config) !== digestClawValue(await getRuntimeConfig())) {
          throw new Error("Runtime configuration changed; review the Claw update again.");
        }
        beforePersistentApply();
        const applied = await applyClawUpdatePlan(
          plan,
          {
            targetManifest: loaded.manifest,
            targetClawMarkdownBody: loaded.clawMarkdownBody,
            targetOpenClawProfile: loaded.openClawProfile,
            targetSource: loaded.source,
          },
          {
            config,
            sourceMcpServers: normalizeConfiguredMcpServers(config.mcp?.servers),
            consentPlanIntegrity: plan.planIntegrity,
            packagePreflight: preflightClawPackage,
            beforePersistentApply,
            cronGateway,
          },
        );
        return await readyCompletion("update", applied.agentId, applied.status);
      },
    );
  }
  const binding = clawMonitorCleanupBindingSchema.parse(await request("monitor.binding"));
  const monitorGateway: ClawMonitorCleanupGateway = {
    inspect: async (agentId) =>
      clawMonitorInventorySchema.parse(
        await request("claws.monitors", { phase: "inspect", agentId, binding }),
      ).monitors,
    quiesce: async (agentId, operationId, monitors) => {
      await request("claws.monitors", {
        phase: "quiesce",
        agentId,
        operationId,
        monitors,
        binding,
      });
    },
    drain: async (agentId, operationId) => {
      await request("claws.monitors", { phase: "drain", agentId, operationId, binding });
    },
  };
  const options = {
    config: await getRuntimeConfig(),
    monitorGateway,
    referencedCleanup: {
      mode: command.params.removeUnused ? ("remove-if-unused" as const) : ("retain" as const),
    },
  };
  const plan = await withArtifactPreservingStateReads(async () =>
    buildClawRemovePlan(command.params.target, {
      ...options,
      readOnly: true,
      inventory: await readClawInventory(),
    }),
  );
  const preview = projectClawRemovePlan(plan);
  if (command.operation === "remove.plan") {
    return preview;
  }
  requireReviewedPlan(preview, command.params.planIntegrity);
  beforePersistentApply();
  const applied = await applyClawRemovePlan(plan, {
    ...options,
    beforePersistentApply,
    consentPlanIntegrity: plan.planIntegrity,
    cronGateway,
    packageGateway: async (params) =>
      clawPackageRemovalResultSchema.parse(
        await request("claws.packages.remove", { ...params, binding }),
      ),
  });
  return completion("remove", applied.agentId, applied.status);
}
