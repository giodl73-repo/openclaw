import type { HealthFinding, HealthFindingSeverity } from "../flows/health-checks.js";
import { getCurrentHostIntegrationBundleStatusSnapshotV1 } from "../hosting/host-integration-bundle.js";
import {
  buildHostIntegrationStatusInventoryV1,
  getCurrentHostIntegrationOwnerEvidenceV1,
  type HostIntegrationBindingStatusEntryV1,
  type HostIntegrationStatusInventoryV1,
} from "../hosting/host-integration-status.js";

export const HOST_INTEGRATION_BINDINGS_CHECK_ID = "core/doctor/host-integration-bindings";

const EXPOSED_REASON_CODES = new Set([
  "BundleDisabled",
  "CarrierStale",
  "CarrierUnavailable",
  "ContributionIncompatible",
  "ContributionMissing",
  "CredentialSlotUnavailable",
  "OwnerEvidenceBundleGenerationMismatch",
  "OwnerEvidenceUnavailable",
  "PolicyConflict",
  "RequiredCriterionUnknown",
]);

function exposedReason(entry: HostIntegrationBindingStatusEntryV1): string {
  if (EXPOSED_REASON_CODES.has(entry.reason)) {
    return entry.reason;
  }
  return `OwnerReported${entry.state[0]?.toUpperCase()}${entry.state.slice(1)}`;
}

function severityForEntry(entry: HostIntegrationBindingStatusEntryV1): HealthFindingSeverity {
  return entry.state === "unavailable" && entry.required ? "error" : "warning";
}

function describeEntry(
  inventory: HostIntegrationStatusInventoryV1,
  entry: HostIntegrationBindingStatusEntryV1,
): string {
  const reason = exposedReason(entry);
  return [
    `Host integration ${entry.id} is ${entry.state}`,
    `for ${entry.owner}/${entry.kind}`,
    `in bundle ${inventory.bundle.generation}`,
    `(${reason}).`,
  ].join(" ");
}

function resolveFixHint(
  inventory: HostIntegrationStatusInventoryV1,
  entry: HostIntegrationBindingStatusEntryV1,
): string {
  const reason = exposedReason(entry);
  if (reason === "ContributionMissing") {
    return `Enable a host package that registers ${entry.id} with contract ${entry.version}, then restart OpenClaw.`;
  }
  if (reason === "ContributionIncompatible") {
    return `Update the registered host package so ${entry.id} provides contract ${entry.version}, then restart OpenClaw.`;
  }
  if (reason === "OwnerEvidenceUnavailable") {
    return `Reload owner ${entry.owner} and verify it publishes status for bundle ${inventory.bundle.generation}.`;
  }
  if (reason === "OwnerEvidenceBundleGenerationMismatch") {
    return `Reload owner ${entry.owner} and its carrier so they publish status for bundle ${inventory.bundle.generation}.`;
  }
  if (entry.reloadDisposition === "restart-required") {
    return `Correct ${entry.config?.path ?? entry.id}, then restart OpenClaw.`;
  }
  if (entry.reloadDisposition === "reload-required") {
    return `Correct ${entry.config?.path ?? entry.id}, then reload owner ${entry.owner}.`;
  }
  return `Inspect ${entry.config?.path ?? entry.id} and owner ${entry.owner}; preserve the configured authority mode while correcting ${reason}.`;
}

export function hostIntegrationStatusToHealthFindings(
  inventory: HostIntegrationStatusInventoryV1,
): HealthFinding[] {
  return inventory.entries.flatMap((entry) => {
    if (entry.state === "ready") {
      return [];
    }
    const reason = exposedReason(entry);
    return [
      {
        checkId: HOST_INTEGRATION_BINDINGS_CHECK_ID,
        severity: severityForEntry(entry),
        message: describeEntry(inventory, entry),
        target: entry.id,
        requirement: reason,
        ...(entry.config?.source ? { source: entry.config.source } : {}),
        ...(entry.config?.path ? { path: entry.config.path } : {}),
        fixHint: resolveFixHint(inventory, entry),
      },
    ];
  });
}

/** Reads only the published bundle and owner snapshots; it never probes or activates bindings. */
export function collectHostIntegrationHealthFindings(): HealthFinding[] {
  const bundle = getCurrentHostIntegrationBundleStatusSnapshotV1();
  if (!bundle) {
    return [];
  }
  return hostIntegrationStatusToHealthFindings(
    buildHostIntegrationStatusInventoryV1({
      bundle,
      ownerEvidence: getCurrentHostIntegrationOwnerEvidenceV1(),
    }),
  );
}
