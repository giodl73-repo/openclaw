export const HOST_INTEGRATION_BUNDLE_VERSION = "host-integration-bundle/v1" as const;

export type HostIntegrationContributionTypeV1 =
  | {
      owner: "model-provider";
      kind: "model-provider-adapter";
    }
  | {
      owner: "provider-request";
      kind: "credential-slot-resolver";
    };

export type HostIntegrationBundleContributionV1 = HostIntegrationContributionTypeV1 & {
  id: string;
  version: string;
  required: boolean;
  readinessCriteria: readonly string[];
};

export type HostIntegrationBundleManifestV1 = {
  version: typeof HOST_INTEGRATION_BUNDLE_VERSION;
  id: string;
  bundleVersion: string;
  contributions: HostIntegrationBundleContributionV1[];
};

export type HostIntegrationContributionProvenanceV1 = {
  pluginId: string;
  source: string;
  origin: "bundled" | "config" | "global" | "workspace";
};

export type AvailableHostIntegrationContributionV1 = HostIntegrationContributionTypeV1 & {
  id: string;
  version: string;
  provenance: HostIntegrationContributionProvenanceV1;
};

export type HostIntegrationBundleInventoryEntryV1 = HostIntegrationBundleContributionV1 & {
  status: "incompatible" | "missing" | "resolved";
  resolvedVersion?: string;
  provenance?: HostIntegrationContributionProvenanceV1;
};

export type HostIntegrationBundleSnapshotV1 = {
  version: typeof HOST_INTEGRATION_BUNDLE_VERSION;
  id: string;
  bundleVersion: string;
  generation: string;
  inventory: readonly HostIntegrationBundleInventoryEntryV1[];
};

export type HostIntegrationContributionReferenceV1 = HostIntegrationContributionTypeV1 & {
  id: string;
  version: string;
};

export type HostIntegrationBundleFailureCode =
  | "invalid-manifest"
  | "duplicate-contribution"
  | "duplicate-available-contribution"
  | "missing-required-contribution"
  | "incompatible-required-contribution"
  | "bundle-not-registered"
  | "unknown-contribution"
  | "incompatible-contribution";

export class HostIntegrationBundleError extends Error {
  readonly code: HostIntegrationBundleFailureCode;
  readonly contributionId?: string;

  constructor(code: HostIntegrationBundleFailureCode, message: string, contributionId?: string) {
    super(message);
    this.name = "HostIntegrationBundleError";
    this.code = code;
    this.contributionId = contributionId;
  }
}

const NAMESPACED_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/;
const CONTRACT_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const READINESS_CRITERION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXACT_SEMVER_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function normalizeNamespacedId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!NAMESPACED_ID_RE.test(normalized)) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      `${label} must be a namespaced identifier`,
    );
  }
  return normalized;
}

function normalizeContractVersion(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!CONTRACT_VERSION_RE.test(normalized)) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration contribution version is invalid",
    );
  }
  return normalized;
}

function normalizeBundleVersion(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!EXACT_SEMVER_RE.test(normalized)) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration bundle version must be an exact semantic version",
    );
  }
  return normalized;
}

function assertContributionType(value: unknown): HostIntegrationContributionTypeV1 {
  if (!value || typeof value !== "object") {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration contribution is invalid",
    );
  }
  const contribution = value as Record<string, unknown>;
  if (contribution.owner === "model-provider" && contribution.kind === "model-provider-adapter") {
    return {
      owner: "model-provider",
      kind: "model-provider-adapter",
    };
  }
  if (
    contribution.owner === "provider-request" &&
    contribution.kind === "credential-slot-resolver"
  ) {
    return {
      owner: "provider-request",
      kind: "credential-slot-resolver",
    };
  }
  throw new HostIntegrationBundleError(
    "invalid-manifest",
    "Host integration contribution owner and kind are unsupported",
  );
}

function normalizeReadinessCriteria(values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration readiness criteria are invalid",
    );
  }
  const criteria = values.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (criteria.some((value) => !READINESS_CRITERION_RE.test(value))) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration readiness criterion is invalid",
    );
  }
  if (new Set(criteria).size !== criteria.length) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration readiness criteria must be unique",
    );
  }
  return criteria.toSorted();
}

function contributionKey(value: HostIntegrationContributionTypeV1 & { id: string }): string {
  return `${value.owner}\u0000${value.kind}\u0000${value.id}`;
}

function normalizeManifest(manifest: unknown): HostIntegrationBundleManifestV1 {
  if (!manifest || typeof manifest !== "object") {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration bundle manifest is invalid",
    );
  }
  const record = manifest as Record<string, unknown>;
  if (record.version !== HOST_INTEGRATION_BUNDLE_VERSION) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      `Unsupported host integration bundle version: ${String(record.version)}`,
    );
  }
  if (!Array.isArray(record.contributions) || record.contributions.length === 0) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration bundle must declare at least one contribution",
    );
  }

  const contributions = record.contributions.map((value) => {
    const type = assertContributionType(value);
    const contribution = value as Record<string, unknown>;
    if (typeof contribution.required !== "boolean") {
      throw new HostIntegrationBundleError(
        "invalid-manifest",
        "Host integration contribution required posture is invalid",
        typeof contribution.id === "string" ? contribution.id : undefined,
      );
    }
    return {
      ...type,
      id: normalizeNamespacedId(contribution.id, "Host integration contribution id"),
      version: normalizeContractVersion(contribution.version),
      required: contribution.required,
      readinessCriteria: normalizeReadinessCriteria(contribution.readinessCriteria),
    };
  });
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  for (const contribution of contributions) {
    const key = contributionKey(contribution);
    if (seen.has(key) || seenIds.has(contribution.id)) {
      throw new HostIntegrationBundleError(
        "duplicate-contribution",
        `Host integration bundle contribution "${contribution.id}" is duplicated`,
        contribution.id,
      );
    }
    seen.add(key);
    seenIds.add(contribution.id);
  }

  return {
    version: HOST_INTEGRATION_BUNDLE_VERSION,
    id: normalizeNamespacedId(record.id, "Host integration bundle id"),
    bundleVersion: normalizeBundleVersion(record.bundleVersion),
    contributions,
  };
}

function normalizeProvenance(provenance: unknown): HostIntegrationContributionProvenanceV1 {
  if (!provenance || typeof provenance !== "object") {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration contribution provenance is invalid",
    );
  }
  const record = provenance as Record<string, unknown>;
  const pluginId = typeof record.pluginId === "string" ? record.pluginId.trim() : "";
  const source = typeof record.source === "string" ? record.source.trim() : "";
  const origin = record.origin;
  if (
    !pluginId ||
    !source ||
    (origin !== "bundled" && origin !== "config" && origin !== "global" && origin !== "workspace")
  ) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Host integration contribution provenance is invalid",
    );
  }
  return { pluginId, source, origin };
}

function normalizeAvailableContributions(
  contributions: readonly AvailableHostIntegrationContributionV1[],
): Map<string, AvailableHostIntegrationContributionV1> {
  if (!Array.isArray(contributions)) {
    throw new HostIntegrationBundleError(
      "invalid-manifest",
      "Available host integration contributions are invalid",
    );
  }
  const available = new Map<string, AvailableHostIntegrationContributionV1>();
  const seenIds = new Set<string>();
  for (const contribution of contributions) {
    const type = assertContributionType(contribution);
    const normalized = {
      ...type,
      id: normalizeNamespacedId(contribution.id, "Available host integration contribution id"),
      version: normalizeContractVersion(contribution.version),
      provenance: normalizeProvenance(contribution.provenance),
    };
    const key = contributionKey(normalized);
    if (available.has(key) || seenIds.has(normalized.id)) {
      throw new HostIntegrationBundleError(
        "duplicate-available-contribution",
        `Available host integration contribution "${normalized.id}" is ambiguous`,
        normalized.id,
      );
    }
    available.set(key, normalized);
    seenIds.add(normalized.id);
  }
  return available;
}

function freezeInventoryEntry(
  entry: HostIntegrationBundleInventoryEntryV1,
): HostIntegrationBundleInventoryEntryV1 {
  return Object.freeze({
    ...entry,
    readinessCriteria: Object.freeze([...entry.readinessCriteria]),
    ...(entry.provenance ? { provenance: Object.freeze({ ...entry.provenance }) } : {}),
  });
}

function buildHostIntegrationBundleSnapshotV1(
  params: {
    manifest: HostIntegrationBundleManifestV1;
    availableContributions: readonly AvailableHostIntegrationContributionV1[];
  },
  options: {
    allowRequiredFailures: boolean;
    registrationIncarnation?: number;
  },
): HostIntegrationBundleSnapshotV1 {
  const manifest = normalizeManifest(params.manifest);
  const available = normalizeAvailableContributions(params.availableContributions);
  const inventory = manifest.contributions
    .map((contribution): HostIntegrationBundleInventoryEntryV1 => {
      const resolved = available.get(contributionKey(contribution));
      if (!resolved) {
        if (contribution.required && !options.allowRequiredFailures) {
          throw new HostIntegrationBundleError(
            "missing-required-contribution",
            `Required host integration contribution "${contribution.id}" is unavailable`,
            contribution.id,
          );
        }
        return freezeInventoryEntry({ ...contribution, status: "missing" });
      }
      if (resolved.version !== contribution.version) {
        if (contribution.required && !options.allowRequiredFailures) {
          throw new HostIntegrationBundleError(
            "incompatible-required-contribution",
            `Required host integration contribution "${contribution.id}" expected ${contribution.version} but resolved ${resolved.version}`,
            contribution.id,
          );
        }
        return freezeInventoryEntry({
          ...contribution,
          status: "incompatible",
          resolvedVersion: resolved.version,
          provenance: resolved.provenance,
        });
      }
      return freezeInventoryEntry({
        ...contribution,
        status: "resolved",
        resolvedVersion: resolved.version,
        provenance: resolved.provenance,
      });
    })
    .toSorted((left, right) => contributionKey(left).localeCompare(contributionKey(right)));

  return Object.freeze({
    version: HOST_INTEGRATION_BUNDLE_VERSION,
    id: manifest.id,
    bundleVersion: manifest.bundleVersion,
    generation: `${manifest.id}@${manifest.bundleVersion}#${
      options.registrationIncarnation ?? "prepared"
    }`,
    inventory: Object.freeze(inventory),
  });
}

export function prepareHostIntegrationBundleSnapshotV1(params: {
  manifest: HostIntegrationBundleManifestV1;
  availableContributions: readonly AvailableHostIntegrationContributionV1[];
}): HostIntegrationBundleSnapshotV1 {
  return buildHostIntegrationBundleSnapshotV1(params, { allowRequiredFailures: false });
}

let currentSnapshot: HostIntegrationBundleSnapshotV1 | undefined;
let currentStatusSnapshot: HostIntegrationBundleSnapshotV1 | undefined;
let registrationIncarnation = 0;

function requiredRegistrationError(
  snapshot: HostIntegrationBundleSnapshotV1,
): HostIntegrationBundleError | undefined {
  const failure = snapshot.inventory.find((entry) => entry.required && entry.status !== "resolved");
  if (!failure) {
    return undefined;
  }
  if (failure.status === "missing") {
    return new HostIntegrationBundleError(
      "missing-required-contribution",
      `Required host integration contribution "${failure.id}" is unavailable`,
      failure.id,
    );
  }
  return new HostIntegrationBundleError(
    "incompatible-required-contribution",
    `Required host integration contribution "${failure.id}" expected ${failure.version} but resolved ${failure.resolvedVersion}`,
    failure.id,
  );
}

// Host packages register explicitly after discovery; an empty slot fails closed instead of
// inventing a partial startup bundle or activating owner implementations.
export function registerHostIntegrationBundleV1(params: {
  manifest: HostIntegrationBundleManifestV1;
  availableContributions: readonly AvailableHostIntegrationContributionV1[];
}): HostIntegrationBundleSnapshotV1 {
  registrationIncarnation += 1;
  const nextSnapshot = buildHostIntegrationBundleSnapshotV1(params, {
    allowRequiredFailures: true,
    registrationIncarnation,
  });
  currentStatusSnapshot = nextSnapshot;
  const registrationError = requiredRegistrationError(nextSnapshot);
  if (registrationError) {
    throw registrationError;
  }
  currentSnapshot = nextSnapshot;
  return nextSnapshot;
}

export function getCurrentHostIntegrationBundleSnapshotV1():
  | HostIntegrationBundleSnapshotV1
  | undefined {
  return currentSnapshot;
}

export function getCurrentHostIntegrationBundleStatusSnapshotV1():
  | HostIntegrationBundleSnapshotV1
  | undefined {
  return currentStatusSnapshot;
}

export function clearCurrentHostIntegrationBundleSnapshotV1(): void {
  currentSnapshot = undefined;
  currentStatusSnapshot = undefined;
}

export function resolveHostIntegrationContributionV1(
  reference: HostIntegrationContributionReferenceV1,
): HostIntegrationBundleInventoryEntryV1 {
  if (!currentSnapshot) {
    throw new HostIntegrationBundleError(
      "bundle-not-registered",
      "No host integration bundle is registered",
    );
  }
  const type = assertContributionType(reference);
  const id = normalizeNamespacedId(reference.id, "Host integration contribution reference");
  const version = normalizeContractVersion(reference.version);
  const entry = currentSnapshot.inventory.find(
    (candidate) => contributionKey(candidate) === contributionKey({ ...type, id }),
  );
  if (!entry || entry.status === "missing") {
    throw new HostIntegrationBundleError(
      "unknown-contribution",
      `Host integration contribution "${id}" is not resolved`,
      id,
    );
  }
  if (
    entry.status === "incompatible" ||
    entry.version !== version ||
    entry.resolvedVersion !== version
  ) {
    throw new HostIntegrationBundleError(
      "incompatible-contribution",
      `Host integration contribution "${id}" is incompatible with ${version}`,
      id,
    );
  }
  return entry;
}
