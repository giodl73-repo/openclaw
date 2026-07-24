import {
  getCurrentHostIntegrationBundleStatusSnapshotV1,
  MAX_HOST_INTEGRATION_READINESS_CRITERIA,
  type HostIntegrationBundleSnapshotV1,
} from "../hosting/host-integration-bundle.js";
import {
  buildHostIntegrationStatusInventoryV1,
  getCurrentHostIntegrationOwnerEvidenceV1,
  type HostIntegrationOwnerEvidenceV1,
} from "../hosting/host-integration-status.js";
import type { ReadinessCondition } from "./conditions.js";
import { boundedCoreReadinessMessage } from "./sanitize.js";

export const HOST_BINDINGS_READY_CRITERION_ID = "openclaw.host-bindings-ready";
const MAX_BINDING_ENTRIES = 256;
const MAX_OWNER_EVIDENCE_ENTRIES = 512;

export function buildHostBindingsReadinessCondition(params?: {
  bundle?: HostIntegrationBundleSnapshotV1 | null;
  ownerEvidence?: readonly HostIntegrationOwnerEvidenceV1[];
  availableCriteria?: ReadonlySet<string>;
  criterionConditions?: ReadonlyMap<string, ReadinessCondition>;
}): ReadinessCondition {
  const bundle =
    params && "bundle" in params
      ? (params.bundle ?? undefined)
      : getCurrentHostIntegrationBundleStatusSnapshotV1();
  if (!bundle) {
    return {
      type: "HostBindingsReady",
      status: "Unknown",
      requirement: "advisory",
      reason: "HostIntegrationBundleUnavailable",
      message: "No host integration bundle has published binding status.",
    };
  }

  const ownerEvidence = params?.ownerEvidence ?? getCurrentHostIntegrationOwnerEvidenceV1();
  const criteria = new Set<string>();
  for (const entry of bundle.inventory) {
    for (const criterion of entry.readinessCriteria) {
      criteria.add(criterion);
      if (criteria.size > MAX_HOST_INTEGRATION_READINESS_CRITERIA) {
        break;
      }
    }
    if (criteria.size > MAX_HOST_INTEGRATION_READINESS_CRITERIA) {
      break;
    }
  }
  if (
    bundle.inventory.length > MAX_BINDING_ENTRIES ||
    ownerEvidence.length > MAX_OWNER_EVIDENCE_ENTRIES ||
    criteria.size > MAX_HOST_INTEGRATION_READINESS_CRITERIA
  ) {
    return {
      type: "HostBindingsReady",
      status: "False",
      requirement: "advisory",
      reason: "HostBindingsInventoryTooLarge",
      message: "Host integration binding status exceeds the readiness evaluation limit.",
    };
  }

  const inventory = buildHostIntegrationStatusInventoryV1({
    bundle,
    ownerEvidence,
    availableCriteria: params?.availableCriteria,
  });
  const requiredEntries = inventory.entries.filter((entry) => entry.required);
  const blockers = requiredEntries.filter((entry) => entry.state !== "ready");
  if (blockers.length > 0) {
    const summary = blockers.map((entry) => `${entry.id} (${entry.state})`).join(", ");
    return {
      type: "HostBindingsReady",
      status: "False",
      requirement: "advisory",
      reason: "HostBindingsNotReady",
      message: boundedCoreReadinessMessage(`Required host bindings are not ready: ${summary}.`),
    };
  }

  if (params?.criterionConditions) {
    const unavailableCriteria = Array.from(
      new Set(
        requiredEntries
          .flatMap((entry) => entry.readinessCriteria)
          .filter((criterion) => params.criterionConditions?.get(criterion)?.status !== "True"),
      ),
    );
    if (unavailableCriteria.length > 0) {
      return {
        type: "HostBindingsReady",
        status: "False",
        requirement: "advisory",
        reason: "HostBindingCriteriaNotReady",
        message: boundedCoreReadinessMessage(
          `Required host binding criteria are not ready: ${unavailableCriteria.join(", ")}.`,
        ),
      };
    }
  }

  return {
    type: "HostBindingsReady",
    status: "True",
    requirement: "advisory",
    reason: "HostBindingsReady",
    message: `All ${requiredEntries.length} required host integration bindings are ready.`,
  };
}
