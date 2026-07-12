import path from "node:path";
import { sha256Hex } from "../infra/crypto-digest.js";
import { isRecord } from "../utils.js";

export type ContinuityRestorePlanFailureCode =
  | "continuity.restore.materialization_escape"
  | "continuity.restore.target_unauthorized"
  | "continuity.restore.target_present"
  | "continuity.restore.target_alias"
  | "continuity.restore.target_overlap"
  | "continuity.restore.plan_conflict";

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
    { code: "continuity.restore.launcher_lease_required" },
    { code: "continuity.restore.publication_capability_missing" },
  ];
  executionEligible: false;
};

export type ContinuityRestorePlanProjection = {
  schemaVersion: 1;
  planId: string;
  artifact: {
    archiveSha256: string;
    manifestSha256: string;
  };
  publicationGroupCount: number;
  assetCount: number;
  blockers: ContinuityRestorePlanReceipt["blockers"];
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
      { code: "continuity.restore.launcher_lease_required" },
      { code: "continuity.restore.publication_capability_missing" },
    ],
    executionEligible: false,
  };
}

export function resolveContinuityRestorePlanReplay(params: {
  planned: ContinuityRestorePlanReceipt;
  existing?: unknown;
}): ContinuityRestorePlanReceipt {
  if (params.existing === undefined) {
    return params.planned;
  }
  const existing = parseContinuityRestorePlanReceipt(params.existing);
  if (
    existing.planId !== params.planned.planId ||
    JSON.stringify(existing) !== JSON.stringify(params.planned)
  ) {
    throw new ContinuityRestorePlanError(
      "continuity.restore.plan_conflict",
      "Continuity restore plan receipt belongs to a different plan.",
    );
  }
  return existing;
}

export function projectContinuityRestorePlan(
  receipt: ContinuityRestorePlanReceipt,
): ContinuityRestorePlanProjection {
  return {
    schemaVersion: 1,
    planId: receipt.planId,
    artifact: {
      archiveSha256: receipt.artifact.archiveSha256,
      manifestSha256: receipt.artifact.manifestSha256,
    },
    publicationGroupCount: receipt.groups.length,
    assetCount: receipt.groups.reduce((total, group) => total + group.members.length, 0),
    blockers: receipt.blockers,
    executionEligible: false,
  };
}

function expectExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const unexpected = Object.keys(record).find((key) => !expected.includes(key));
  if (unexpected || Object.keys(record).length !== expected.length) {
    throw new Error(
      `Continuity restore plan contains an unknown or missing field: ${unexpected ?? "unknown"}.`,
    );
  }
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Continuity restore plan ${key} must be an object.`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Continuity restore plan ${key} must be a non-empty string.`);
  }
  return value;
}

function expectLiteral(
  record: Record<string, unknown>,
  key: string,
  expected: string | number | boolean,
): void {
  if (record[key] !== expected) {
    throw new Error(`Continuity restore plan ${key} must be ${JSON.stringify(expected)}.`);
  }
}

function parseMember(value: unknown): ContinuityRestorePlanMember {
  if (!isRecord(value)) {
    throw new Error("Continuity restore plan member must be an object.");
  }
  expectExactKeys(value, [
    "componentId",
    "kind",
    "restoreOrder",
    "canonicalTargetPath",
    "canonicalTargetAnchor",
    "materializedSourcePath",
    "targetKind",
    "targetRelativePath",
  ]);
  const kind = readString(value, "kind");
  if (!["state", "config", "config-include", "workspace"].includes(kind)) {
    throw new Error("Continuity restore plan member kind is invalid.");
  }
  const targetKind = readString(value, "targetKind");
  if (targetKind !== "file" && targetKind !== "directory") {
    throw new Error("Continuity restore plan member targetKind is invalid.");
  }
  const restoreOrder = value.restoreOrder;
  if (typeof restoreOrder !== "number" || !Number.isSafeInteger(restoreOrder) || restoreOrder < 0) {
    throw new Error("Continuity restore plan member restoreOrder is invalid.");
  }
  return {
    componentId: readString(value, "componentId"),
    kind: kind as CanonicalRestorePlanAsset["kind"],
    restoreOrder,
    canonicalTargetPath: readString(value, "canonicalTargetPath"),
    canonicalTargetAnchor: readString(value, "canonicalTargetAnchor"),
    materializedSourcePath: readString(value, "materializedSourcePath"),
    targetKind,
    targetRelativePath: readString(value, "targetRelativePath"),
  };
}

function parseGroup(value: unknown): ContinuityRestorePlanGroup {
  if (!isRecord(value)) {
    throw new Error("Continuity restore plan group must be an object.");
  }
  expectExactKeys(value, [
    "rootComponentId",
    "canonicalTargetPath",
    "targetKind",
    "canonicalTargetAnchor",
    "members",
  ]);
  const targetKind = readString(value, "targetKind");
  if (targetKind !== "file" && targetKind !== "directory") {
    throw new Error("Continuity restore plan group targetKind is invalid.");
  }
  if (!Array.isArray(value.members) || value.members.length === 0) {
    throw new Error("Continuity restore plan group members must be a non-empty array.");
  }
  return {
    rootComponentId: readString(value, "rootComponentId"),
    canonicalTargetPath: readString(value, "canonicalTargetPath"),
    targetKind,
    canonicalTargetAnchor: readString(value, "canonicalTargetAnchor"),
    members: value.members.map(parseMember),
  };
}

export function parseContinuityRestorePlanReceipt(value: unknown): ContinuityRestorePlanReceipt {
  if (!isRecord(value)) {
    throw new Error("Continuity restore plan receipt must be an object.");
  }
  expectExactKeys(value, [
    "schemaVersion",
    "contract",
    "planId",
    "artifact",
    "materialization",
    "authorization",
    "groups",
    "blockers",
    "executionEligible",
  ]);
  expectLiteral(value, "schemaVersion", 1);
  expectLiteral(value, "executionEligible", false);

  const contract = readRecord(value, "contract");
  expectExactKeys(contract, ["planner", "plannerSchemaVersion", "runtimeVersion"]);
  expectLiteral(contract, "planner", "openclaw-core");
  expectLiteral(contract, "plannerSchemaVersion", 1);

  const artifact = readRecord(value, "artifact");
  expectExactKeys(artifact, ["archiveSha256", "manifestSha256", "archiveRoot"]);
  const materialization = readRecord(value, "materialization");
  expectExactKeys(materialization, ["receiptSha256", "root"]);
  const authorization = readRecord(value, "authorization");
  expectExactKeys(authorization, ["kind", "authorizationDigest"]);
  expectLiteral(authorization, "kind", "explicit-publication-roots");

  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    throw new Error("Continuity restore plan groups must be a non-empty array.");
  }
  if (!Array.isArray(value.blockers) || value.blockers.length !== 2) {
    throw new Error("Continuity restore plan blockers are invalid.");
  }
  const blockers = value.blockers.map((blocker) => {
    if (!isRecord(blocker)) {
      throw new Error("Continuity restore plan blocker must be an object.");
    }
    expectExactKeys(blocker, ["code"]);
    return readString(blocker, "code");
  });
  if (
    blockers[0] !== "continuity.restore.launcher_lease_required" ||
    blockers[1] !== "continuity.restore.publication_capability_missing"
  ) {
    throw new Error("Continuity restore plan blockers are success-shaped or unknown.");
  }

  const parsed: ContinuityRestorePlanReceipt = {
    schemaVersion: 1,
    contract: {
      planner: "openclaw-core",
      plannerSchemaVersion: 1,
      runtimeVersion: readString(contract, "runtimeVersion"),
    },
    planId: readString(value, "planId"),
    artifact: {
      archiveSha256: readString(artifact, "archiveSha256"),
      manifestSha256: readString(artifact, "manifestSha256"),
      archiveRoot: readString(artifact, "archiveRoot"),
    },
    materialization: {
      receiptSha256: readString(materialization, "receiptSha256"),
      root: readString(materialization, "root"),
    },
    authorization: {
      kind: "explicit-publication-roots",
      authorizationDigest: readString(authorization, "authorizationDigest"),
    },
    groups: value.groups.map(parseGroup),
    blockers: [
      { code: "continuity.restore.launcher_lease_required" },
      { code: "continuity.restore.publication_capability_missing" },
    ],
    executionEligible: false,
  };
  assertIdentity(parsed.planId, "Continuity restore plan");
  assertIdentity(parsed.artifact.archiveSha256, "Continuity archive");
  assertIdentity(parsed.artifact.manifestSha256, "Continuity manifest");
  assertIdentity(parsed.materialization.receiptSha256, "Continuity materialization receipt");
  assertIdentity(parsed.authorization.authorizationDigest, "Continuity authorization");
  assertAbsolutePath(parsed.materialization.root, "Continuity materialized root");
  assertUniqueAssetIdentities(parsed.groups.flatMap((group) => group.members));
  const rebuiltGroups = buildGroups(parsed.groups.flatMap((group) => group.members));
  if (JSON.stringify(rebuiltGroups) !== JSON.stringify(parsed.groups)) {
    throw new Error("Continuity restore plan groups are not canonical.");
  }
  const rebuilt = buildContinuityRestorePlanReceipt({
    runtimeVersion: parsed.contract.runtimeVersion,
    artifact: parsed.artifact,
    materialization: parsed.materialization,
    assets: parsed.groups.flatMap((group) => group.members),
    authorizedPublicationRoots: parsed.groups.map((group) => group.canonicalTargetPath),
  });
  if (
    rebuilt.planId !== parsed.planId ||
    rebuilt.authorization.authorizationDigest !== parsed.authorization.authorizationDigest
  ) {
    throw new Error("Continuity restore plan identity does not match its contents.");
  }
  return parsed;
}
