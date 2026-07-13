// Materializes verified continuity components into a new offline filesystem root.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContinuityArchiveObligations } from "../continuity/archive-obligations.js";
import {
  assignContinuityPayloadFiles,
  type ContinuityMaterializationContentInventory,
  listContinuityRegularFiles,
  type MaterializedContinuityFile,
  resolveOwnedContinuityAssets,
  type OwnedContinuityAsset,
} from "../continuity/materialization-files.js";
import { verifyContinuitySqliteSnapshot } from "../continuity/sqlite-sanitize.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { compareComparableSemver, parseComparableSemver } from "../infra/semver-compare.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  assertSafeRetrievedTree,
  backupRetrieveCommand,
  DEFAULT_BACKUP_RETRIEVE_MAX_BYTES,
} from "./backup-retrieve.js";
import { parseBackupManifest, type BackupManifest, verifyBackupArchive } from "./backup-verify.js";
import { isPathWithin } from "./cleanup-utils.js";

export type BackupMaterializeOptions = {
  archive: string;
  destination: string;
  json?: boolean;
  maxBytes?: number;
  maxEntries?: number;
};

export type MaterializedContinuityComponent = {
  id: string;
  kind: string;
  restoreOrder: number;
  dependsOn: string[];
  fileCount: number;
};

export type MaterializedSqliteSchemaEvidence = {
  archivePath: string;
  kind: "shared-state" | "agent-state" | "other";
  schemaVersion: number;
  supportedVersion: number | null;
};

export type ContinuityCompatibilityEvidence = {
  artifactRuntimeVersion: string;
  currentRuntimeVersion: string;
  runtimeDecision: "same-or-older";
  artifactPlatform: string;
  currentPlatform: NodeJS.Platform;
  platformDecision: "same-platform";
  sqliteSchemas: MaterializedSqliteSchemaEvidence[];
};

export type ContinuitySurfaceEvidence = {
  obligations: ContinuityArchiveObligations;
  reconstructionPerformed: false;
  externalDependenciesResolved: false;
  transientsCreated: false;
};

export type BackupMaterializeResult = {
  ok: true;
  archivePath: string;
  destination: string;
  receiptPath: string;
  archiveRoot: string;
  archiveSha256: string;
  manifestSha256: string;
  materializedFileCount: number;
  contentInventory: ContinuityMaterializationContentInventory;
  components: MaterializedContinuityComponent[];
  compatibility: ContinuityCompatibilityEvidence;
  surfaces: ContinuitySurfaceEvidence;
  activated: false;
  activationReady: false;
  effectiveArchived: false;
};

async function assertDestinationDoesNotExist(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Backup materialize destination already exists: ${destination}`);
}

async function canonicalizeProspectivePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;
  while (true) {
    try {
      const canonicalProbe = await fs.realpath(probe);
      return suffix.length === 0
        ? canonicalProbe
        : path.join(canonicalProbe, ...suffix.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function assertDestinationOutsideSources(
  destination: string,
  assets: readonly OwnedContinuityAsset[],
): Promise<void> {
  const canonicalDestination = await canonicalizeProspectivePath(destination);
  const canonicalSources = await Promise.all(
    assets.map(async (asset) => ({
      asset,
      sourcePath: await canonicalizeProspectivePath(asset.sourcePath),
    })),
  );
  const overlap = canonicalSources.find(
    (source) =>
      canonicalDestination === source.sourcePath ||
      isPathWithin(canonicalDestination, source.sourcePath),
  );
  if (overlap) {
    throw new Error(
      `Continuity materialize destination must be outside every captured source: ${overlap.asset.sourcePath}`,
    );
  }
}

function resolveRetrievedPath(
  retrievedDirectory: string,
  manifest: BackupManifest,
  archivePath: string,
): string {
  const relativePath = path.posix.relative(manifest.archiveRoot, archivePath);
  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    throw new Error(`Continuity component path escaped the archive root: ${archivePath}`);
  }
  return path.join(retrievedDirectory, ...relativePath.split("/"));
}

function resolveMaterializedPath(
  destination: string,
  payloadRoot: string,
  archivePath: string,
): string {
  const relativePath = path.posix.relative(payloadRoot, archivePath);
  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    throw new Error(`Continuity component path escaped the payload root: ${archivePath}`);
  }
  return path.join(destination, ...relativePath.split("/"));
}

async function copyOwnedFile(params: {
  archivePath: string;
  sourcePath: string;
  destinationPath: string;
}): Promise<MaterializedContinuityFile> {
  const sourceStat = await fs.lstat(params.sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error(`Continuity materialization source must be a private regular file.`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const sourceHandle = await fs.open(params.sourcePath, fsConstants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const openedStat = await sourceHandle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino ||
      openedStat.nlink !== 1
    ) {
      throw new Error(`Continuity materialization source changed before copy.`);
    }
    const destinationMode = openedStat.mode & 0o100 ? 0o700 : 0o600;
    await fs.mkdir(path.dirname(params.destinationPath), { recursive: true, mode: 0o700 });
    destinationHandle = await fs.open(
      params.destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      destinationMode,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const digest = createHash("sha256");
    let copiedBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
      copiedBytes += bytesRead;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          offset,
          bytesRead - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error(`Continuity materialization write stalled.`);
        }
        offset += bytesWritten;
      }
    }
    await destinationHandle.chmod(destinationMode);
    await destinationHandle.sync();
    return {
      archivePath: params.archivePath,
      sha256: digest.digest("hex"),
      size: copiedBytes,
      executable: destinationMode === 0o700,
    };
  } catch (error) {
    await fs.rm(params.destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

function validateRuntimeCompatibility(
  manifest: BackupManifest,
): Pick<
  ContinuityCompatibilityEvidence,
  | "artifactRuntimeVersion"
  | "currentRuntimeVersion"
  | "runtimeDecision"
  | "artifactPlatform"
  | "currentPlatform"
  | "platformDecision"
> {
  const currentRuntimeVersion = resolveRuntimeServiceVersion();
  const artifactVersion = parseComparableSemver(manifest.runtimeVersion, {
    normalizeLegacyDotBeta: true,
  });
  const currentVersion = parseComparableSemver(currentRuntimeVersion, {
    normalizeLegacyDotBeta: true,
  });
  const runtimeComparison = compareComparableSemver(artifactVersion, currentVersion);
  if (runtimeComparison === null) {
    throw new Error(
      `Continuity runtime compatibility requires exact semantic versions; artifact=${JSON.stringify(manifest.runtimeVersion)}, current=${JSON.stringify(currentRuntimeVersion)}.`,
    );
  }
  if (runtimeComparison > 0) {
    throw new Error(
      `Continuity artifact runtime ${manifest.runtimeVersion} is newer than this OpenClaw runtime ${currentRuntimeVersion}. Upgrade OpenClaw before materializing it.`,
    );
  }
  if (manifest.platform !== process.platform) {
    throw new Error(
      `Continuity artifact platform ${JSON.stringify(manifest.platform)} does not match this local runtime platform ${JSON.stringify(process.platform)}.`,
    );
  }
  return {
    artifactRuntimeVersion: manifest.runtimeVersion,
    currentRuntimeVersion,
    runtimeDecision: "same-or-older",
    artifactPlatform: manifest.platform,
    currentPlatform: process.platform,
    platformDecision: "same-platform",
  };
}

function classifySqliteSchema(
  archivePath: string,
  stateArchivePath: string,
): {
  kind: MaterializedSqliteSchemaEvidence["kind"];
  supportedVersion: number | null;
  label: string;
} {
  const stateRelativePath = path.posix.relative(stateArchivePath, archivePath);
  if (stateRelativePath === "state/openclaw.sqlite") {
    return {
      kind: "shared-state",
      supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      label: "OpenClaw shared state database",
    };
  }
  if (/^agents\/[^/]+\/agent\/openclaw-agent\.sqlite$/i.test(stateRelativePath)) {
    return {
      kind: "agent-state",
      supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      label: "OpenClaw agent state database",
    };
  }
  return { kind: "other", supportedVersion: null, label: "Continuity SQLite database" };
}

function validateSqliteSchemas(
  retrievedDirectory: string,
  manifest: BackupManifest,
): MaterializedSqliteSchemaEvidence[] {
  const stateArchivePath = manifest.assets.find((asset) => asset.kind === "state")?.archivePath;
  if (!stateArchivePath) {
    throw new Error("Continuity SQLite compatibility requires one state component.");
  }
  const sqlite = requireNodeSqlite();
  return (manifest.sanitizedSqlitePaths ?? []).map((archivePath) => {
    const databasePath = resolveRetrievedPath(retrievedDirectory, manifest, archivePath);
    verifyContinuitySqliteSnapshot(databasePath);
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check?: unknown;
      }>;
      if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
        throw new Error(`Continuity SQLite integrity validation failed: ${archivePath}`);
      }
      const schemaVersion = readSqliteUserVersion(database);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        throw new Error(`Continuity SQLite has an invalid schema version: ${archivePath}`);
      }
      const classification = classifySqliteSchema(archivePath, stateArchivePath);
      if (
        classification.supportedVersion !== null &&
        schemaVersion > classification.supportedVersion
      ) {
        throw createNewerSqliteSchemaVersionError(
          classification.label,
          archivePath,
          schemaVersion,
          classification.supportedVersion,
        );
      }
      return {
        archivePath,
        kind: classification.kind,
        schemaVersion,
        supportedVersion: classification.supportedVersion,
      };
    } finally {
      database.close();
    }
  });
}

function resolveSurfaceEvidence(manifest: BackupManifest): ContinuitySurfaceEvidence {
  if (!manifest.continuityObligations) {
    throw new Error("Continuity materialization requires artifact-specific obligations.");
  }
  return {
    obligations: manifest.continuityObligations,
    reconstructionPerformed: false,
    externalDependenciesResolved: false,
    transientsCreated: false,
  };
}

function formatResult(result: BackupMaterializeResult): string {
  return [
    `Continuity materialized: ${result.destination}`,
    `Archive: ${result.archivePath}`,
    `Archive SHA-256: ${result.archiveSha256}`,
    `Manifest SHA-256: ${result.manifestSha256}`,
    `Components materialized: ${result.components.length}`,
    `Files materialized: ${result.materializedFileCount}`,
    `Compatibility validated: ${result.compatibility.runtimeDecision}, ${result.compatibility.platformDecision}, ${result.compatibility.sqliteSchemas.length} SQLite database(s)`,
    "Activation obligations remaining: 5",
    "This is an offline filesystem root; it has not been activated and does not establish effective Archived.",
  ].join("\n");
}

async function materializeContinuityArchive(
  opts: BackupMaterializeOptions,
): Promise<BackupMaterializeResult> {
  const archivePath = resolveUserPath(opts.archive);
  const destination = resolveUserPath(opts.destination);
  const maxBytes = opts.maxBytes ?? DEFAULT_BACKUP_RETRIEVE_MAX_BYTES;
  await assertDestinationDoesNotExist(destination);
  const preflight = await verifyBackupArchive({
    archive: archivePath,
    maxArchiveBytes: maxBytes,
    ...(opts.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }),
    maxContentBytes: maxBytes,
  });
  const assets = resolveOwnedContinuityAssets(preflight.manifest);
  await assertDestinationOutsideSources(destination, assets);
  const parentDirectory = path.dirname(destination);
  await fs.mkdir(parentDirectory, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(
    path.join(parentDirectory, `.${path.basename(destination)}-materialize-`),
  );
  await fs.chmod(temporaryDirectory, 0o700);
  const retrievedDirectory = path.join(temporaryDirectory, "retrieved");
  let destinationCreated = false;
  let result: BackupMaterializeResult | undefined;
  let operationError: unknown;

  try {
    const retrieval = await backupRetrieveCommand(
      { log: () => {}, error: () => {}, exit: () => {} },
      {
        archive: archivePath,
        destination: retrievedDirectory,
        ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
        ...(opts.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }),
      },
    );
    const manifestBytes = await fs.readFile(path.join(retrievedDirectory, "manifest.json"));
    if (
      retrieval.archiveSha256 !== preflight.result.archiveSha256 ||
      retrieval.manifestSha256 !== preflight.result.manifestSha256 ||
      sha256Hex(manifestBytes) !== retrieval.manifestSha256
    ) {
      throw new Error("Retrieved continuity manifest identity changed before materialization.");
    }
    const manifest = parseBackupManifest(manifestBytes.toString("utf8"));
    if (manifest.archiveRoot !== retrieval.archiveRoot) {
      throw new Error("Retrieved continuity archive root changed before materialization.");
    }
    const payloadRoot = path.posix.join(manifest.archiveRoot, "payload");
    const retrievedPayloadDirectory = path.join(retrievedDirectory, "payload");
    const payloadFiles = (await listContinuityRegularFiles(retrievedPayloadDirectory)).map(
      (relativePath) => path.posix.join(payloadRoot, relativePath),
    );
    const filesByComponent = assignContinuityPayloadFiles({ manifest, assets, payloadFiles });
    const compatibility: ContinuityCompatibilityEvidence = {
      ...validateRuntimeCompatibility(manifest),
      sqliteSchemas: validateSqliteSchemas(retrievedDirectory, manifest),
    };
    const surfaces = resolveSurfaceEvidence(manifest);

    await fs.mkdir(destination, { mode: 0o700 });
    destinationCreated = true;
    const incompleteMarker = path.join(destination, ".openclaw-materialize-incomplete");
    await fs.writeFile(incompleteMarker, `${retrieval.archiveSha256}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const components: MaterializedContinuityComponent[] = [];
    const materializedFiles: MaterializedContinuityFile[] = [];
    for (const asset of assets) {
      const componentFiles = filesByComponent.get(asset.component.id) ?? [];
      if (asset.kind === "state" || asset.kind === "workspace") {
        await fs.mkdir(resolveMaterializedPath(destination, payloadRoot, asset.archivePath), {
          recursive: true,
          mode: 0o700,
        });
      }
      for (const componentFile of componentFiles) {
        materializedFiles.push(
          await copyOwnedFile({
            archivePath: componentFile,
            sourcePath: resolveRetrievedPath(retrievedDirectory, manifest, componentFile),
            destinationPath: resolveMaterializedPath(destination, payloadRoot, componentFile),
          }),
        );
      }
      components.push({
        id: asset.component.id,
        kind: asset.kind,
        restoreOrder: asset.component.restoreOrder,
        dependsOn: asset.component.dependsOn,
        fileCount: componentFiles.length,
      });
    }

    const materializedFileCount = components.reduce(
      (total, component) => total + component.fileCount,
      0,
    );
    if (materializedFileCount !== payloadFiles.length) {
      throw new Error("Continuity materialization did not consume every payload file.");
    }
    const contentInventory: ContinuityMaterializationContentInventory = {
      version: 1,
      files: materializedFiles.toSorted((left, right) =>
        left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0,
      ),
    };
    const receiptPath = path.join(destination, ".openclaw-continuity-materialization.json");
    const receipt = {
      schemaVersion: 1,
      artifactType: "continuity",
      archiveRoot: manifest.archiveRoot,
      archiveSha256: retrieval.archiveSha256,
      manifestSha256: retrieval.manifestSha256,
      components,
      materializedFileCount,
      contentInventory,
      compatibility,
      surfaces,
      activated: false,
      activationReady: false,
      effectiveArchived: false,
    } as const;
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rm(incompleteMarker);
    await assertSafeRetrievedTree(
      destination,
      maxBytes,
      new Set([".openclaw-continuity-materialization.json"]),
    );
    result = {
      ok: true,
      archivePath,
      destination,
      receiptPath,
      archiveRoot: manifest.archiveRoot,
      archiveSha256: retrieval.archiveSha256,
      manifestSha256: retrieval.manifestSha256,
      materializedFileCount,
      contentInventory,
      components,
      compatibility,
      surfaces,
      activated: false,
      activationReady: false,
      effectiveArchived: false,
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (operationError !== undefined && destinationCreated) {
    try {
      await fs.rm(destination, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Continuity materialization failed and cleanup was incomplete.",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Continuity materialization completed but temporary cleanup failed: ${destination}`,
    );
  }
  if (!result) {
    throw new Error("Continuity materialization completed without producing a result.");
  }
  return result;
}

/** Materialize one verified continuity archive into a new non-active filesystem root. */
export async function backupMaterializeCommand(
  runtime: RuntimeEnv,
  opts: BackupMaterializeOptions,
): Promise<BackupMaterializeResult> {
  const result = await materializeContinuityArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
