import { notifyHostIntegrationAuthorityChanged } from "./host-integration-authority-events.js";
import type {
  HostIntegrationBundleInventoryEntryV1,
  HostIntegrationBundleSnapshotV1,
  HostIntegrationContributionTypeV1,
} from "./host-integration-bundle.js";

export const HOST_INTEGRATION_STATUS_VERSION = "host-integration-status/v1" as const;

export type HostIntegrationBindingStateV1 =
  | "ready"
  | "degraded"
  | "unavailable"
  | "stale"
  | "unresolved";

export type HostIntegrationReloadDispositionV1 = "none" | "reload-required" | "restart-required";

export type HostIntegrationAuthorityModeV1 = "openclaw" | "host" | "shared";

export type HostIntegrationOwnerEvidenceV1 = HostIntegrationContributionTypeV1 & {
  id: string;
  bundleGeneration: string;
  state: Exclude<HostIntegrationBindingStateV1, "unresolved">;
  reason: string;
  message: string;
  config?: {
    source: string;
    path?: string;
  };
  ownerGeneration?: string;
  carrierGeneration?: string;
  carrierIncarnation?: string;
  reloadDisposition?: HostIntegrationReloadDispositionV1;
  authorityMode?: HostIntegrationAuthorityModeV1;
};

export type HostIntegrationBindingStatusEntryV1 = HostIntegrationBundleInventoryEntryV1 & {
  state: HostIntegrationBindingStateV1;
  reason: string;
  message: string;
  config?: HostIntegrationOwnerEvidenceV1["config"];
  generations: {
    bundle: string;
    owner?: string;
    carrier?: string;
    carrierIncarnation?: string;
  };
  reloadDisposition?: HostIntegrationReloadDispositionV1;
  authorityMode?: HostIntegrationAuthorityModeV1;
};

export type HostIntegrationStatusInventoryV1 = {
  version: typeof HOST_INTEGRATION_STATUS_VERSION;
  bundle: {
    id: string;
    version: string;
    generation: string;
  };
  state: HostIntegrationBindingStateV1;
  entries: readonly HostIntegrationBindingStatusEntryV1[];
};

const EMPTY_OWNER_EVIDENCE: readonly HostIntegrationOwnerEvidenceV1[] = Object.freeze([]);
let currentOwnerEvidence: readonly HostIntegrationOwnerEvidenceV1[] = EMPTY_OWNER_EVIDENCE;

const STATE_PRIORITY: Record<HostIntegrationBindingStateV1, number> = {
  ready: 0,
  unresolved: 1,
  stale: 2,
  degraded: 3,
  unavailable: 4,
};

function contributionKey(value: HostIntegrationContributionTypeV1 & { id: string }): string {
  return `${value.owner}\u0000${value.kind}\u0000${value.id}`;
}

/** Atomically publishes owner-reported status data for read-only status consumers. */
export function publishHostIntegrationOwnerEvidenceV1(
  evidence: readonly HostIntegrationOwnerEvidenceV1[],
): readonly HostIntegrationOwnerEvidenceV1[] {
  const keys = new Set<string>();
  const snapshot = evidence.map((entry) => {
    const key = contributionKey(entry);
    if (keys.has(key)) {
      throw new Error(`Duplicate host integration owner evidence: ${entry.id}`);
    }
    keys.add(key);
    return Object.freeze({
      ...entry,
      ...(entry.config ? { config: Object.freeze({ ...entry.config }) } : {}),
    });
  });
  currentOwnerEvidence = Object.freeze(snapshot);
  notifyHostIntegrationAuthorityChanged();
  return currentOwnerEvidence;
}

export function getCurrentHostIntegrationOwnerEvidenceV1(): readonly HostIntegrationOwnerEvidenceV1[] {
  return currentOwnerEvidence;
}

export function clearCurrentHostIntegrationOwnerEvidenceV1(): void {
  currentOwnerEvidence = EMPTY_OWNER_EVIDENCE;
  notifyHostIntegrationAuthorityChanged();
}

function resolveBundleState(entry: HostIntegrationBundleInventoryEntryV1): {
  state: HostIntegrationBindingStateV1;
  reason: string;
  message: string;
} | null {
  if (entry.status === "resolved") {
    return null;
  }
  const required = entry.required ? "required" : "optional";
  if (entry.status === "missing") {
    return {
      state: entry.required ? "unavailable" : "degraded",
      reason: "ContributionMissing",
      message: `${required} contribution ${entry.id} is not available.`,
    };
  }
  return {
    state: entry.required ? "unavailable" : "degraded",
    reason: "ContributionIncompatible",
    message: `${required} contribution ${entry.id} has no compatible version.`,
  };
}

/** Projects registered bundle state and owner-reported evidence without probing or activation. */
export function buildHostIntegrationStatusInventoryV1(params: {
  bundle: HostIntegrationBundleSnapshotV1;
  ownerEvidence?: readonly HostIntegrationOwnerEvidenceV1[];
}): HostIntegrationStatusInventoryV1 {
  const bundleGeneration = params.bundle.generation;
  const evidenceByContribution = new Map(
    (params.ownerEvidence ?? []).map((evidence) => [contributionKey(evidence), evidence]),
  );
  const entries = params.bundle.inventory.map((entry): HostIntegrationBindingStatusEntryV1 => {
    const bundleState = resolveBundleState(entry);
    const evidence = evidenceByContribution.get(contributionKey(entry));
    if (bundleState) {
      return {
        ...entry,
        ...bundleState,
        generations: { bundle: bundleGeneration },
      };
    }
    if (!evidence) {
      return {
        ...entry,
        state: "unresolved",
        reason: "OwnerEvidenceUnavailable",
        message: `Owner ${entry.owner} has not reported binding status for ${entry.id}.`,
        generations: { bundle: bundleGeneration },
      };
    }
    if (evidence.bundleGeneration !== bundleGeneration) {
      return {
        ...entry,
        state: "stale",
        reason: "OwnerEvidenceBundleGenerationMismatch",
        message: `Owner ${entry.owner} reported ${entry.id} for bundle generation ${evidence.bundleGeneration}.`,
        config: evidence.config,
        generations: {
          bundle: bundleGeneration,
          owner: evidence.ownerGeneration,
          carrier: evidence.carrierGeneration,
          carrierIncarnation: evidence.carrierIncarnation,
        },
        reloadDisposition: evidence.reloadDisposition,
        authorityMode: evidence.authorityMode,
      };
    }
    return {
      ...entry,
      state: evidence.state,
      reason: evidence.reason,
      message: evidence.message,
      config: evidence.config,
      generations: {
        bundle: bundleGeneration,
        owner: evidence.ownerGeneration,
        carrier: evidence.carrierGeneration,
        carrierIncarnation: evidence.carrierIncarnation,
      },
      reloadDisposition: evidence.reloadDisposition,
      authorityMode: evidence.authorityMode,
    };
  });
  const state = entries.reduce<HostIntegrationBindingStateV1>(
    (current, entry) =>
      STATE_PRIORITY[entry.state] > STATE_PRIORITY[current] ? entry.state : current,
    "ready",
  );
  return Object.freeze({
    version: HOST_INTEGRATION_STATUS_VERSION,
    bundle: Object.freeze({
      id: params.bundle.id,
      version: params.bundle.bundleVersion,
      generation: bundleGeneration,
    }),
    state,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}
