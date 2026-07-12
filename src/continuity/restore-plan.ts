import path from "node:path";
import { sha256Hex } from "../infra/crypto-digest.js";

export type ContinuityRestorePlanFailureCode =
  | "continuity.restore.materialization_escape"
  | "continuity.restore.target_unauthorized"
  | "continuity.restore.target_present"
  | "continuity.restore.target_alias"
  | "continuity.restore.target_overlap";

export class ContinuityRestorePlanError extends Error {
  constructor(
    public readonly code: ContinuityRestorePlanFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ContinuityRestorePlanError";
  }
}

export type CanonicalRestorePlanAsset = {
  componentId: string;
  kind: "state" | "config" | "config-include" | "workspace";
  restoreOrder: number;
  canonicalTargetPath: string;
  canonicalTargetAnchor: string;
  materializedSourcePath: string;
  targetKind: "file" | "directory";
};

export type ContinuityRestorePlanMember = CanonicalRestorePlanAsset & {
  targetRelativePath: string;
};

export type ContinuityRestorePlanGroup = {
  rootComponentId: string;
  canonicalTargetPath: string;
  targetKind: "file" | "directory";
  canonicalTargetAnchor: string;
  members: ContinuityRestorePlanMember[];
};

export type ContinuityRestorePlanReceipt = {
  schemaVersion: 1;
  contract: {
    planner: "openclaw-core";
    plannerSchemaVersion: 1;
    runtimeVersion: string;
  };
  planId: string;
  artifact: {
    archiveSha256: string;
    manifestSha256: string;
    archiveRoot: string;
  };
  materialization: {
    receiptSha256: string;
    root: string;
  };
  authorization: {
    kind: "explicit-publication-roots";
    authorizationDigest: string;
  };
  groups: ContinuityRestorePlanGroup[];
  blockers: [
    { code: "continuity.restore.materialization_content_identity_required" },
    { code: "continuity.restore.launcher_lease_required" },
    { code: "continuity.restore.publication_capability_missing" },
  ];
  executionEligible: false;
};

type BuildContinuityRestorePlanParams = {
  runtimeVersion: string;
  artifact: ContinuityRestorePlanReceipt["artifact"];
  materialization: ContinuityRestorePlanReceipt["materialization"];
  assets: readonly CanonicalRestorePlanAsset[];
  authorizedPublicationRoots: readonly string[];
  existingTargetPaths?: ReadonlySet<string>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.target_alias",
      `${label} must be an absolute normalized canonical path.`,
    );
  }
}

function assertUniqueAssetIdentities(assets: readonly CanonicalRestorePlanAsset[]): void {
  const componentIds = new Set<string>();
  const targetPaths = new Set<string>();
  const materializedPaths = new Set<string>();
  const restoreOrders = new Set<number>();
  for (const asset of assets) {
    assertAbsolutePath(asset.canonicalTargetPath, "Continuity restore target");
    assertAbsolutePath(asset.canonicalTargetAnchor, "Continuity restore target anchor");
    assertAbsolutePath(asset.materializedSourcePath, "Continuity materialized source");
    if (
      !asset.componentId ||
      !Number.isSafeInteger(asset.restoreOrder) ||
      asset.restoreOrder < 0 ||
      restoreOrders.has(asset.restoreOrder) ||
      !isPathWithin(asset.canonicalTargetPath, asset.canonicalTargetAnchor) ||
      asset.canonicalTargetPath === asset.canonicalTargetAnchor
    ) {
      throw new ContinuityRestorePlanError(
        "continuity.restore.target_alias",
        "Continuity restore assets contain invalid canonical identities.",
      );
    }
    if (
      componentIds.has(asset.componentId) ||
      targetPaths.has(asset.canonicalTargetPath) ||
      materializedPaths.has(asset.materializedSourcePath)
    ) {
      throw new ContinuityRestorePlanError(
        "continuity.restore.target_alias",
        "Continuity restore assets contain duplicate canonical identities.",
      );
    }
    componentIds.add(asset.componentId);
    targetPaths.add(asset.canonicalTargetPath);
    materializedPaths.add(asset.materializedSourcePath);
    restoreOrders.add(asset.restoreOrder);
  }
  if (
    assets
      .map((asset) => asset.restoreOrder)
      .toSorted((left, right) => left - right)
      .some((restoreOrder, index) => restoreOrder !== index)
  ) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.target_alias",
      "Continuity restore order must be contiguous from zero.",
    );
  }
}

function normalizeAssets(
  assets: readonly CanonicalRestorePlanAsset[],
): CanonicalRestorePlanAsset[] {
  const normalized = assets.map((asset) => ({
    componentId: asset.componentId,
    kind: asset.kind,
    restoreOrder: asset.restoreOrder,
    canonicalTargetPath: asset.canonicalTargetPath,
    canonicalTargetAnchor: asset.canonicalTargetAnchor,
    materializedSourcePath: asset.materializedSourcePath,
    targetKind: asset.targetKind,
  }));
  assertUniqueAssetIdentities(normalized);
  return normalized;
}

function findGroupRoot(
  asset: CanonicalRestorePlanAsset,
  assets: readonly CanonicalRestorePlanAsset[],
): CanonicalRestorePlanAsset {
  return assets
    .filter((candidate) => isPathWithin(asset.canonicalTargetPath, candidate.canonicalTargetPath))
    .toSorted(
      (left, right) =>
        left.canonicalTargetPath.length - right.canonicalTargetPath.length ||
        compareCanonicalStrings(left.canonicalTargetPath, right.canonicalTargetPath),
    )[0]!;
}

function assertFileAssetsHaveNoDescendants(assets: readonly CanonicalRestorePlanAsset[]): void {
  const invalidFile = assets.find(
    (asset) =>
      asset.targetKind === "file" &&
      assets.some(
        (candidate) =>
          candidate !== asset &&
          isPathWithin(candidate.canonicalTargetPath, asset.canonicalTargetPath),
      ),
  );
  if (invalidFile) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.target_overlap",
      "A file restore target cannot contain descendant restore assets.",
    );
  }
}

function buildGroups(assets: readonly CanonicalRestorePlanAsset[]): ContinuityRestorePlanGroup[] {
  assertFileAssetsHaveNoDescendants(assets);
  const membersByRoot = new Map<CanonicalRestorePlanAsset, CanonicalRestorePlanAsset[]>();
  for (const asset of assets) {
    const root = findGroupRoot(asset, assets);
    const members = membersByRoot.get(root) ?? [];
    members.push(asset);
    membersByRoot.set(root, members);
  }
  return [...membersByRoot.entries()]
    .map(([root, members]) => {
      if (root.targetKind === "file" && members.length > 1) {
        throw new ContinuityRestorePlanError(
          "continuity.restore.target_overlap",
          "A file publication root cannot contain descendant restore assets.",
        );
      }
      return {
        rootComponentId: root.componentId,
        canonicalTargetPath: root.canonicalTargetPath,
        targetKind: root.targetKind,
        canonicalTargetAnchor: root.canonicalTargetAnchor,
        members: members
          .toSorted((left, right) => left.restoreOrder - right.restoreOrder)
          .map((member) => ({
            componentId: member.componentId,
            kind: member.kind,
            restoreOrder: member.restoreOrder,
            canonicalTargetPath: member.canonicalTargetPath,
            canonicalTargetAnchor: member.canonicalTargetAnchor,
            materializedSourcePath: member.materializedSourcePath,
            targetKind: member.targetKind,
            targetRelativePath:
              member === root
                ? "."
                : path.relative(root.canonicalTargetPath, member.canonicalTargetPath),
          })),
      };
    })
    .toSorted((left, right) =>
      compareCanonicalStrings(left.canonicalTargetPath, right.canonicalTargetPath),
    );
}

function assertAuthorization(
  groups: readonly ContinuityRestorePlanGroup[],
  authorizedRoots: readonly string[],
): string[] {
  const normalizedRoots = authorizedRoots.toSorted(compareCanonicalStrings);
  for (const root of normalizedRoots) {
    assertAbsolutePath(root, "Continuity authorized publication root");
  }
  if (new Set(normalizedRoots).size !== normalizedRoots.length) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.target_alias",
      "Continuity authorized publication roots contain duplicates.",
    );
  }
  const groupRoots = groups
    .map((group) => group.canonicalTargetPath)
    .toSorted(compareCanonicalStrings);
  if (
    normalizedRoots.length !== groupRoots.length ||
    normalizedRoots.some((root, index) => root !== groupRoots[index])
  ) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.target_unauthorized",
      "Every continuity publication group requires exact independent authorization.",
    );
  }
  return normalizedRoots;
}

function assertTargetsAbsent(
  assets: readonly CanonicalRestorePlanAsset[],
  existingTargetPaths: ReadonlySet<string>,
): void {
  const existingPaths = [...existingTargetPaths];
  if (
    assets.some((asset) =>
      existingPaths.some(
        (existingPath) =>
          existingPath === asset.canonicalTargetPath ||
          (asset.targetKind === "directory" &&
            isPathWithin(existingPath, asset.canonicalTargetPath)),
      ),
    )
  ) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.target_present",
      "Continuity restore targets must be absent when planned.",
    );
  }
}

function assertMaterializedSourcesContained(
  assets: readonly CanonicalRestorePlanAsset[],
  materializationRoot: string,
): void {
  if (
    assets.some(
      (asset) =>
        asset.materializedSourcePath === materializationRoot ||
        !isPathWithin(asset.materializedSourcePath, materializationRoot),
    )
  ) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.materialization_escape",
      "Continuity restore asset escaped the verified materialization root.",
    );
  }
}

function assertIdentity(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 identity.`);
  }
}

export function buildContinuityRestorePlanReceipt(
  params: BuildContinuityRestorePlanParams,
): ContinuityRestorePlanReceipt {
  if (params.assets.length === 0) {
    throw new Error("Continuity restore plan requires at least one asset.");
  }
  if (!params.runtimeVersion || !params.artifact.archiveRoot) {
    throw new Error("Continuity restore plan identities must be non-empty.");
  }
  const artifact = {
    archiveSha256: params.artifact.archiveSha256,
    manifestSha256: params.artifact.manifestSha256,
    archiveRoot: params.artifact.archiveRoot,
  };
  const materialization = {
    receiptSha256: params.materialization.receiptSha256,
    root: params.materialization.root,
  };
  assertIdentity(artifact.archiveSha256, "Continuity archive");
  assertIdentity(artifact.manifestSha256, "Continuity manifest");
  assertIdentity(materialization.receiptSha256, "Continuity materialization receipt");
  assertAbsolutePath(materialization.root, "Continuity materialized root");
  const assets = normalizeAssets(params.assets);
  assertMaterializedSourcesContained(assets, materialization.root);
  assertTargetsAbsent(assets, params.existingTargetPaths ?? new Set());
  const groups = buildGroups(assets);
  const authorizedRoots = assertAuthorization(groups, params.authorizedPublicationRoots);
  const authorizationDigest = sha256Hex(JSON.stringify(authorizedRoots));
  const identity = {
    contract: {
      planner: "openclaw-core" as const,
      plannerSchemaVersion: 1 as const,
      runtimeVersion: params.runtimeVersion,
    },
    artifact,
    materialization,
    authorizationDigest,
    groups,
  };
  return {
    schemaVersion: 1,
    contract: identity.contract,
    planId: sha256Hex(JSON.stringify(identity)),
    artifact,
    materialization,
    authorization: {
      kind: "explicit-publication-roots",
      authorizationDigest,
    },
    groups,
    blockers: [
      { code: "continuity.restore.materialization_content_identity_required" },
      { code: "continuity.restore.launcher_lease_required" },
      { code: "continuity.restore.publication_capability_missing" },
    ],
    executionEligible: false,
  };
}
