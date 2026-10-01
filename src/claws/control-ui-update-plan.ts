import type {
  ClawLifecyclePlanResult,
  ClawPermissionDisclosure,
  ClawScheduledJobDisclosure,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ClawHubSourceError,
  readClawHubClawDetail,
  withResolvedClawHubSource,
  type ClawHubCoordinate,
  type ClawHubSourceTrust,
  type ResolvedClawHubSource,
} from "./clawhub-source.js";
import { buildClawPermissionDisclosure } from "./control-ui-permissions.js";
import { addClawControlUiSafetyBlockers } from "./control-ui-safety.js";
import { buildClawUpdateScheduledJobs } from "./control-ui-scheduled-jobs.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import { preflightClawPackage } from "./packages.js";
import { buildClawUpdatePlanWithTarget, type ClawUpdatePlan } from "./update-plan.js";

export function projectClawUpdatePlan(
  plan: ClawUpdatePlan,
  trust: ClawHubSourceTrust,
  disclosure?: ClawPermissionDisclosure,
  scheduledJobs?: ClawScheduledJobDisclosure,
): ClawLifecyclePlanResult {
  const projection = {
    schemaVersion: "openclaw.clawsGatewayPlan.v1" as const,
    operation: "update" as const,
    target: {
      agentId: plan.agentId,
      ...(plan.currentClaw ? { currentVersion: plan.currentClaw.version } : {}),
      ...(plan.targetClaw
        ? { name: plan.targetClaw.name, targetVersion: plan.targetClaw.version }
        : plan.currentClaw
          ? { name: plan.currentClaw.name }
          : {}),
      ...(trust.publisher ? { publisher: trust.publisher } : {}),
    },
    actions: plan.actions.map(({ kind, id, action, blocked }) => ({
      kind,
      id,
      action,
      blocked,
      ...(blocked ? { reason: "Current OpenClaw state blocks this action." } : {}),
    })),
    capabilities: plan.capabilityChanges.map(({ kind, id, action, classification }) => ({
      kind,
      id,
      action,
      reason:
        classification === "escalation"
          ? "This update expands the agent's capabilities."
          : classification === "reduction"
            ? "This update reduces the agent's capabilities."
            : "This update changes a required capability.",
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
    ...(disclosure ? { effectivePermissions: disclosure } : {}),
    ...(scheduledJobs ? { scheduledJobs } : {}),
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

export async function planClawUpdateFromCatalog(params: {
  target: string;
  source?: ClawHubCoordinate;
  getRuntimeConfig: () => OpenClawConfig;
}): Promise<ClawLifecyclePlanResult> {
  return await withClawControlUiUpdatePlan(params, async ({ preview }) => preview);
}

export async function withClawControlUiUpdatePlan<T>(
  params: {
    target: string;
    source?: ClawHubCoordinate;
    getRuntimeConfig: () => OpenClawConfig | Promise<OpenClawConfig>;
    beforePersistentApply?: () => void;
  },
  run: (prepared: {
    plan: ClawUpdatePlan;
    preview: ClawLifecyclePlanResult;
    loaded: ResolvedClawHubSource;
    persistSource: () => Promise<ResolvedClawHubSource>;
    config: OpenClawConfig;
  }) => Promise<T>,
): Promise<T> {
  const initialInventory = await readClawInventory();
  const matches = initialInventory.installs.filter(
    (install) => install.agentId === params.target || install.claw.name === params.target,
  );
  if (matches.length !== 1) {
    throw new ClawHubSourceError(
      matches.length ? "claw_ambiguous" : "claw_not_found",
      "Select one installed Claw agent before reviewing an update.",
    );
  }
  const install = matches[0]!;
  if (install.claw.kind !== "package") {
    throw new ClawHubSourceError(
      "claw_source_unsupported",
      "Only installed ClawHub packages can be updated through the Control UI.",
    );
  }
  if (params.source && params.source.packageName !== install.claw.name) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "The update must use the installed Claw package identity.",
    );
  }
  const source = params.source ?? (await readClawHubClawDetail({ packageName: install.claw.name }));
  const result = await withResolvedClawHubSource({
    coordinate: { packageName: source.packageName, version: source.version },
    beforePersistentApply: params.beforePersistentApply,
    run: async (loaded, trust, persistSource) => {
      const inventory = await readClawInventory();
      const config = await params.getRuntimeConfig();
      const { plan, targetAgent } = await buildClawUpdatePlanWithTarget({
        agentId: install.agentId,
        targetManifest: loaded.manifest,
        targetClawMarkdownBody: loaded.clawMarkdownBody,
        targetOpenClawProfile: loaded.openClawProfile,
        targetSource: loaded.source,
        diagnostics: loaded.diagnostics,
        config,
        sourceMcpServers: normalizeConfiguredMcpServers(config.mcp?.servers),
        inventory,
        packagePreflight: preflightClawPackage,
      });
      const disclosure = buildClawPermissionDisclosure({
        config,
        operation: "update",
        agentId: plan.agentId,
        desiredAgent: targetAgent,
      });
      const scheduledJobs = buildClawUpdateScheduledJobs({
        plan,
        proposed: loaded.manifest.cronJobs,
        recorded: inventory.cronJobs,
      });
      const preview = projectClawUpdatePlan(
        addClawControlUiSafetyBlockers(plan, loaded),
        trust,
        disclosure,
        scheduledJobs,
      );
      return await run({ plan, preview, loaded, persistSource, config });
    },
  });
  return result.value;
}
