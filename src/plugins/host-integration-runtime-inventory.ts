import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginReadinessResolver,
  type ResolvedPluginReadinessCondition,
} from "../readiness/plugin-readiness.js";
import { listRegisteredHostIntegrationBundles } from "./host-integration-bundle-registry.js";
import type { PluginRegistry } from "./registry-types.js";

export const HOST_INTEGRATION_RUNTIME_INVENTORY_VERSION =
  "host-integration-runtime-inventory/v1" as const;

export type HostIntegrationRuntimeContributionV1 = Readonly<{
  owner: string;
  kind: string;
  id: string;
  contractVersion: string;
  readiness: ResolvedPluginReadinessCondition;
}>;

export type HostIntegrationRuntimeBundleV1 = Readonly<{
  pluginId: string;
  id: string;
  version: string;
  status: "True" | "False" | "Unknown";
  contributions: readonly HostIntegrationRuntimeContributionV1[];
}>;

export type HostIntegrationRuntimeInventoryV1 = Readonly<{
  version: typeof HOST_INTEGRATION_RUNTIME_INVENTORY_VERSION;
  status: "True" | "False" | "Unknown";
  bundles: readonly HostIntegrationRuntimeBundleV1[];
}>;

const defaultReadinessResolver = createPluginReadinessResolver();

function unavailableReadiness(params: {
  type: string;
  reason: string;
  message: string;
}): ResolvedPluginReadinessCondition {
  return Object.freeze({ status: "Unknown", ...params });
}

function aggregateStatus(
  statuses: readonly ("True" | "False" | "Unknown")[],
): "True" | "False" | "Unknown" {
  return statuses.includes("False")
    ? "False"
    : statuses.includes("Unknown") || statuses.length === 0
      ? "Unknown"
      : "True";
}

// This projection is intentionally caller-driven. Status, Doctor, health, and startup gates do not
// consume plugin readiness implicitly; a later host surface may request this advisory snapshot.
/** Joins inert manifest inventory to owner-published readiness without activating or probing it. */
export async function buildHostIntegrationRuntimeInventoryV1(params: {
  registry: Pick<PluginRegistry, "plugins" | "readinessCriteria">;
  config: OpenClawConfig;
  resolveReadiness?: ReturnType<typeof createPluginReadinessResolver>;
}): Promise<HostIntegrationRuntimeInventoryV1> {
  const bundles = listRegisteredHostIntegrationBundles(params.registry);
  const criterionIds = new Set(
    bundles.flatMap((registration) =>
      registration.bundle.contributions.flatMap((contribution) =>
        contribution.readinessCriterion ? [contribution.readinessCriterion] : [],
      ),
    ),
  );
  const conditions = await (params.resolveReadiness ?? defaultReadinessResolver)({
    registry: params.registry,
    config: params.config,
    criterionIds,
  });
  const conditionsById = new Map(conditions.map((condition) => [condition.type, condition]));
  const runtimeBundles = bundles.map((registration): HostIntegrationRuntimeBundleV1 => {
    const contributions = registration.bundle.contributions.map(
      (contribution): HostIntegrationRuntimeContributionV1 => {
        const readiness = contribution.readinessCriterion
          ? (conditionsById.get(contribution.readinessCriterion) ??
            unavailableReadiness({
              type: contribution.readinessCriterion,
              reason: "ReadinessCriterionNotRegistered",
              message:
                "Readiness criterion " + contribution.readinessCriterion + " is not registered.",
            }))
          : unavailableReadiness({
              type: registration.bundle.id + "." + contribution.id,
              reason: "ReadinessCriterionNotDeclared",
              message: "Contribution " + contribution.id + " does not declare readiness.",
            });
        return Object.freeze({
          owner: contribution.owner,
          kind: contribution.kind,
          id: contribution.id,
          contractVersion: contribution.contractVersion,
          readiness,
        });
      },
    );
    return Object.freeze({
      pluginId: registration.pluginId,
      id: registration.bundle.id,
      version: registration.bundle.version,
      status: aggregateStatus(contributions.map((entry) => entry.readiness.status)),
      contributions: Object.freeze(contributions),
    });
  });
  return Object.freeze({
    version: HOST_INTEGRATION_RUNTIME_INVENTORY_VERSION,
    status: aggregateStatus(runtimeBundles.map((bundle) => bundle.status)),
    bundles: Object.freeze(runtimeBundles),
  });
}
