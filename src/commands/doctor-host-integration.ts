import type { OpenClawConfig } from "../config/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import type { HostIntegrationRuntimeInventoryV1 } from "../plugins/host-integration-runtime-inventory.js";
import { resolveStatusHostIntegrationSafe } from "./status-runtime-shared.js";

export const HOST_INTEGRATION_BINDINGS_CHECK_ID = "core/doctor/host-integration-bindings" as const;

const DEFAULT_HOST_INTEGRATION_DOCTOR_TIMEOUT_MS = 3_000;
const FRAMEWORK_READINESS_REASONS = new Set([
  "ReadinessCriterionNotDeclared",
  "ReadinessCriterionNotRegistered",
  "CriterionInvalidResult",
  "CriterionTimedOut",
  "CriterionCheckFailed",
]);

type ResolveHostIntegrationInventory = typeof resolveStatusHostIntegrationSafe;

function resolveDoctorReason(params: { status: "False" | "Unknown"; reason: string }): string {
  return FRAMEWORK_READINESS_REASONS.has(params.reason)
    ? params.reason
    : `OwnerReported${params.status}`;
}

function resolveFixHint(params: { reason: string }): string {
  switch (params.reason) {
    case "ReadinessCriterionNotDeclared":
      return "Update the host plugin manifest to declare readiness for this contribution, then restart the Gateway.";
    case "ReadinessCriterionNotRegistered":
      return "Enable or update the owning plugin so it registers the declared readiness criterion, then restart the Gateway.";
    case "CriterionInvalidResult":
    case "CriterionTimedOut":
    case "CriterionCheckFailed":
      return "Inspect the owning plugin readiness check, then restart the Gateway after correcting it.";
    default:
      return "Inspect this contribution with `openclaw status --json` and correct its owning plugin configuration or dependency.";
  }
}

/** Converts the running Gateway inventory into actionable, redacted Doctor findings. */
export function hostIntegrationInventoryToHealthFindings(
  inventory: HostIntegrationRuntimeInventoryV1 | undefined,
): readonly HealthFinding[] {
  if (!inventory) {
    return [];
  }

  return inventory.bundles.flatMap((bundle) =>
    bundle.contributions.flatMap((contribution): HealthFinding[] => {
      if (contribution.readiness.status === "True") {
        return [];
      }
      const status = contribution.readiness.status;
      const reason = resolveDoctorReason({ status, reason: contribution.readiness.reason });
      return [
        {
          checkId: HOST_INTEGRATION_BINDINGS_CHECK_ID,
          severity: status === "False" ? "error" : "warning",
          message: `Host integration contribution "${contribution.id}" in bundle "${bundle.id}@${bundle.version}" reports ${status} (${reason}).`,
          target: `${bundle.id}/${contribution.id}`,
          requirement: reason,
          fixHint: resolveFixHint({ reason }),
        },
      ];
    }),
  );
}

/** Reads the advisory inventory from the running Gateway without local plugin activation. */
export async function collectHostIntegrationHealthFindings(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  resolveInventory?: ResolveHostIntegrationInventory;
}): Promise<readonly HealthFinding[]> {
  const inventory = await (params.resolveInventory ?? resolveStatusHostIntegrationSafe)({
    config: params.config,
    gatewayReachable: true,
    timeoutMs: params.timeoutMs ?? DEFAULT_HOST_INTEGRATION_DOCTOR_TIMEOUT_MS,
  });
  return hostIntegrationInventoryToHealthFindings(inventory);
}
