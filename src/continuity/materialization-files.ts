import fs from "node:fs/promises";
import path from "node:path";
import type { BackupManifest, BackupManifestAsset } from "../commands/backup-verify.js";
import { isRecord } from "../utils.js";

export type OwnedContinuityAsset = BackupManifestAsset & {
  component: NonNullable<BackupManifestAsset["component"]>;
};

export type MaterializedContinuityFile = {
  archivePath: string;
  sha256: string;
  size: number;
  executable: boolean;
};

export type ContinuityMaterializationContentInventory = {
  version: 1;
  files: MaterializedContinuityFile[];
};

export type ContinuityMaterializationReceipt = {
  schemaVersion: 1;
  artifactType: "continuity";
  archiveRoot: string;
  archiveSha256: string;
  manifestSha256: string;
  activated: false;
  activationReady: false;
  effectiveArchived: false;
  contentInventory?: ContinuityMaterializationContentInventory;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function hasComponent(asset: BackupManifestAsset): asset is OwnedContinuityAsset {
  return asset.component !== undefined;
}

function receiptString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Continuity materialization receipt ${key} is invalid.`);
  }
  return value;
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function parseContentInventory(
  value: unknown,
  archiveRoot: string,
): ContinuityMaterializationContentInventory | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
    throw new Error("Continuity materialization content inventory is invalid.");
  }
  const payloadRoot = path.posix.join(archiveRoot, "payload");
  const files = value.files.map((entry, index): MaterializedContinuityFile => {
    if (!isRecord(entry)) {
      throw new Error(`Continuity materialization file entry ${index} is invalid.`);
    }
    const archivePath = entry.archivePath;
    const sha256 = entry.sha256;
    const size = entry.size;
    const executable = entry.executable;
    if (
      typeof archivePath !== "string" ||
      path.posix.normalize(archivePath) !== archivePath ||
      !isArchivePathWithin(archivePath, payloadRoot) ||
      archivePath === payloadRoot ||
      typeof sha256 !== "string" ||
      !SHA256_PATTERN.test(sha256) ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      typeof executable !== "boolean"
    ) {
      throw new Error(`Continuity materialization file entry ${index} is invalid.`);
    }
    return { archivePath, sha256, size: size as number, executable };
  });
  const archivePaths = files.map((file) => file.archivePath);
  if (
    new Set(archivePaths).size !== archivePaths.length ||
    archivePaths.some((archivePath, index) => index > 0 && archivePaths[index - 1]! >= archivePath)
  ) {
    throw new Error("Continuity materialization file inventory must be unique and ordered.");
  }
  return { version: 1, files };
}

export function parseContinuityMaterializationReceipt(
  raw: string,
  expected: {
    archiveRoot: string;
    archiveSha256: string;
    manifestSha256: string;
  },
): ContinuityMaterializationReceipt {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Continuity materialization receipt must be an object.");
  }
  const archiveRoot = receiptString(parsed, "archiveRoot");
  const archiveSha256 = receiptString(parsed, "archiveSha256");
  const manifestSha256 = receiptString(parsed, "manifestSha256");
  if (
    parsed.schemaVersion !== 1 ||
    parsed.artifactType !== "continuity" ||
    parsed.activated !== false ||
    parsed.activationReady !== false ||
    parsed.effectiveArchived !== false ||
    archiveRoot !== expected.archiveRoot ||
    archiveSha256 !== expected.archiveSha256 ||
    manifestSha256 !== expected.manifestSha256
  ) {
    throw new Error("Continuity materialization receipt does not match the verified archive.");
  }
  return {
    schemaVersion: 1,
    artifactType: "continuity",
    archiveRoot,
    archiveSha256,
    manifestSha256,
    activated: false,
    activationReady: false,
    effectiveArchived: false,
    ...(parsed.contentInventory === undefined
      ? {}
      : { contentInventory: parseContentInventory(parsed.contentInventory, archiveRoot) }),
  };
}

export function resolveOwnedContinuityAssets(
  manifest: BackupManifest,
  options: { requireCapture?: boolean } = {},
): OwnedContinuityAsset[] {
  if (
    manifest.artifactType !== "continuity" ||
    (options.requireCapture !== false && !manifest.continuityCapture)
  ) {
    throw new Error("Only verified continuity artifacts can be materialized.");
  }
  if (!manifest.assets.every(hasComponent)) {
    throw new Error("Continuity materialization requires a complete component graph.");
  }
  return manifest.assets
    .filter(hasComponent)
    .toSorted((left, right) => left.component.restoreOrder - right.component.restoreOrder);
}

export function assignContinuityPayloadFiles(params: {
  manifest: BackupManifest;
  assets: OwnedContinuityAsset[];
  payloadFiles: string[];
}): Map<string, string[]> {
  const stateAsset = params.assets.find((asset) => asset.kind === "state");
  if (!stateAsset) {
    throw new Error("Continuity materialization requires one state component.");
  }
  const stateFilePaths = new Set(params.manifest.stateFilePaths ?? []);
  const configAssets = params.assets.filter(
    (asset) => asset.kind === "config" || asset.kind === "config-include",
  );
  const workspaceAssets = params.assets.filter((asset) => asset.kind === "workspace");
  const filesByComponent = new Map(
    params.assets.map((asset) => [asset.component.id, [] as string[]]),
  );

  for (const archivePath of params.payloadFiles) {
    let owner: OwnedContinuityAsset;
    if (stateFilePaths.has(archivePath)) {
      owner = stateAsset;
    } else {
      const configOwners = configAssets.filter((asset) => asset.archivePath === archivePath);
      if (configOwners.length > 1) {
        throw new Error(`Continuity payload has ambiguous config ownership: ${archivePath}`);
      }
      if (configOwners[0]) {
        owner = configOwners[0];
      } else {
        const workspaceOwners = workspaceAssets.filter((asset) =>
          isArchivePathWithin(archivePath, asset.archivePath),
        );
        if (workspaceOwners.length !== 1) {
          throw new Error(`Continuity payload has invalid workspace ownership: ${archivePath}`);
        }
        owner = workspaceOwners[0]!;
      }
    }
    filesByComponent.get(owner.component.id)!.push(archivePath);
  }
  return filesByComponent;
}

export async function listContinuityRegularFiles(
  directory: string,
  relative = "",
): Promise<string[]> {
  const files: string[] = [];
  const currentDirectory = path.join(directory, ...relative.split("/").filter(Boolean));
  for (const entry of await fs.readdir(currentDirectory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relative, entry.name);
    const entryPath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listContinuityRegularFiles(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Continuity filesystem tree contains an unsupported entry: ${entryPath}`);
    }
  }
  return files.toSorted();
}
