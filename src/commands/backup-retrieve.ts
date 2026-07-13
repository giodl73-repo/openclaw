// Retrieves a verified backup archive into a new, non-active staging directory.
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import type { BackupContinuityAssessment } from "../continuity/backup-assessment.js";
import { root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { backupVerifyCommand, type BackupVerifyResult } from "./backup-verify.js";

export const DEFAULT_BACKUP_RETRIEVE_MAX_BYTES = 16 * 1024 ** 3;
export const DEFAULT_BACKUP_RETRIEVE_MAX_ENTRIES = 1_000_000;

export type BackupRetrieveOptions = {
  archive: string;
  destination: string;
  json?: boolean;
  maxBytes?: number;
  maxEntries?: number;
};

export type BackupRetrieveResult = {
  ok: true;
  archivePath: string;
  destination: string;
  archiveRoot: string;
  archiveSha256: string;
  manifestSha256: string;
  assetCount: number;
  componentCount: number;
  entryCount: number;
  restoredBytes: number;
  continuityAssessment?: BackupContinuityAssessment;
};

function restoreEntryKind(entry: tar.ReadEntry | Stats): "file" | "directory" | "other" {
  if ("isFile" in entry) {
    return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
  }
  return entry.type === "File" ? "file" : entry.type === "Directory" ? "directory" : "other";
}

function isAllowedRetrievePath(rawPath: string, archiveRoot: string): boolean {
  if (rawPath.includes("\\")) {
    return false;
  }
  const withoutTrailingSlashes = rawPath.replace(/\/+$/u, "");
  const normalized = path.posix.normalize(withoutTrailingSlashes);
  if (
    normalized !== withoutTrailingSlashes ||
    normalized.startsWith("/") ||
    normalized.startsWith("../")
  ) {
    return false;
  }
  return (
    normalized === archiveRoot ||
    normalized === `${archiveRoot}/manifest.json` ||
    normalized === `${archiveRoot}/payload` ||
    normalized.startsWith(`${archiveRoot}/payload/`)
  );
}

async function assertDestinationDoesNotExist(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Backup retrieve destination already exists: ${destination}`);
}

async function copyArchiveSnapshot(params: {
  archivePath: string;
  snapshotPath: string;
  maxBytes: number;
}): Promise<void> {
  const sourceStat = await fs.lstat(params.archivePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Backup retrieve archive must be a regular file: ${params.archivePath}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const sourceHandle = await fs.open(params.archivePath, fsConstants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const openedStat = await sourceHandle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino
    ) {
      throw new Error(`Backup retrieve archive changed before snapshot: ${params.archivePath}`);
    }
    if (openedStat.size > params.maxBytes) {
      throw new Error(`Backup archive exceeds the ${params.maxBytes}-byte retrieve limit.`);
    }
    destinationHandle = await fs.open(
      params.snapshotPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copiedBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      copiedBytes += bytesRead;
      if (copiedBytes > params.maxBytes) {
        throw new Error(`Backup archive exceeds the ${params.maxBytes}-byte retrieve limit.`);
      }
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          offset,
          bytesRead - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error(`Backup retrieve archive snapshot write stalled.`);
        }
        offset += bytesWritten;
      }
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(0o600);
  } catch (error) {
    await fs.rm(params.snapshotPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

async function assertSafeTreeFiles(params: {
  root: Root;
  relativeDirectory: string;
  maxBytes: number;
  excludedBytePaths: ReadonlySet<string>;
  totalBytes: { value: number };
}): Promise<void> {
  const entries = await params.root.list(params.relativeDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(params.relativeDirectory, entry.name);
    if (entry.isSymbolicLink) {
      throw new Error(`Backup retrieved tree contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory) {
      await assertSafeTreeFiles({ ...params, relativeDirectory: relativePath });
      continue;
    }
    if (!entry.isFile || entry.nlink !== 1) {
      throw new Error(`Backup retrieved tree contains an unsafe entry: ${relativePath}`);
    }
    const opened = await params.root.open(relativePath);
    try {
      if (
        !opened.stat.isFile() ||
        opened.stat.dev !== entry.dev ||
        opened.stat.ino !== entry.ino ||
        opened.stat.nlink !== 1
      ) {
        throw new Error(`Backup retrieved tree changed during validation: ${relativePath}`);
      }
      if (!params.excludedBytePaths.has(relativePath)) {
        params.totalBytes.value += opened.stat.size;
        if (params.totalBytes.value > params.maxBytes) {
          throw new Error(`Backup retrieved tree exceeds the ${params.maxBytes}-byte limit.`);
        }
      }
    } finally {
      await opened.handle.close();
    }
  }
}

export async function assertSafeRetrievedTree(
  rootDirectory: string,
  maxBytes: number,
  excludedBytePaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const safeRoot = await fsSafeRoot(rootDirectory, {
    symlinks: "reject",
    hardlinks: "reject",
    maxBytes,
    nonBlockingRead: true,
  });
  await assertSafeTreeFiles({
    root: safeRoot,
    relativeDirectory: "",
    maxBytes,
    excludedBytePaths,
    totalBytes: { value: 0 },
  });
}

function formatResult(result: BackupRetrieveResult): string {
  return [
    `Backup retrieved: ${result.destination}`,
    `Archive: ${result.archivePath}`,
    `Archive SHA-256: ${result.archiveSha256}`,
    `Manifest SHA-256: ${result.manifestSha256}`,
    `Assets: ${result.assetCount}`,
    `Components: ${result.componentCount}`,
    `Restored bytes: ${result.restoredBytes}`,
    "The destination is a verified staging bundle; it has not been activated as live state.",
  ].join("\n");
}

async function retrieveBackupArchive(opts: BackupRetrieveOptions): Promise<BackupRetrieveResult> {
  const archivePath = resolveUserPath(opts.archive);
  const destination = resolveUserPath(opts.destination);
  const maxBytes = opts.maxBytes ?? DEFAULT_BACKUP_RETRIEVE_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_BACKUP_RETRIEVE_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Backup retrieve maxBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Backup retrieve maxEntries must be a positive safe integer.");
  }

  await assertDestinationDoesNotExist(destination);

  const parentDir = path.dirname(destination);
  await fs.mkdir(parentDir, { recursive: true });
  const tempDir = await fs.mkdtemp(
    path.join(parentDir, `.${path.basename(destination)}-retrieve-`),
  );
  await fs.chmod(tempDir, 0o700);
  const snapshotPath = path.join(tempDir, "archive.tar.gz");
  let destinationCreated = false;
  let operationFailed = false;
  let operationFailure: unknown;
  let result: BackupRetrieveResult | undefined;
  try {
    await copyArchiveSnapshot({ archivePath, snapshotPath, maxBytes });
    const verification: BackupVerifyResult = await backupVerifyCommand(
      { log: () => {}, error: () => {}, exit: () => {} },
      { archive: snapshotPath, maxEntries, maxContentBytes: maxBytes },
    );
    if (verification.entryCount > maxEntries) {
      throw new Error(`Backup payload exceeds the ${maxEntries}-entry retrieve limit.`);
    }

    await fs.mkdir(destination, { mode: 0o700 });
    destinationCreated = true;
    const incompleteMarker = path.join(destination, ".openclaw-retrieve-incomplete");
    await fs.writeFile(incompleteMarker, `${verification.archiveSha256}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    let invalidArchive = false;
    let exceededBytes = false;
    let exceededEntries = false;
    let restoredBytes = 0;
    let countedEntries = 0;
    await tar.x({
      file: snapshotPath,
      cwd: destination,
      gzip: true,
      strip: 1,
      preservePaths: false,
      preserveOwner: false,
      strict: true,
      onwarn: () => {
        invalidArchive = true;
      },
      filter: (entryPath, entry) => {
        if (invalidArchive || exceededBytes || exceededEntries) {
          return false;
        }
        // Include path segments because tar may create intermediate directories
        // that do not have their own archive entries.
        countedEntries += entryPath.split("/").filter(Boolean).length;
        if (countedEntries > maxEntries) {
          exceededEntries = true;
          return false;
        }
        const kind = restoreEntryKind(entry);
        if (kind === "other" || !isAllowedRetrievePath(entryPath, verification.archiveRoot)) {
          invalidArchive = true;
          return false;
        }
        if (kind === "file") {
          restoredBytes += entry.size;
          if (restoredBytes > maxBytes) {
            exceededBytes = true;
            return false;
          }
        }
        return true;
      },
    });
    if (exceededBytes) {
      throw new Error(`Backup payload exceeds the ${maxBytes}-byte retrieve limit.`);
    }
    if (exceededEntries) {
      throw new Error(`Backup payload exceeds the ${maxEntries}-entry retrieve limit.`);
    }
    if (invalidArchive) {
      throw new Error("Backup contains an unsupported or unsafe retrieve entry.");
    }

    await assertSafeRetrievedTree(destination, maxBytes);
    await fs.rm(incompleteMarker);

    result = {
      ok: true,
      archivePath,
      destination,
      archiveRoot: verification.archiveRoot,
      archiveSha256: verification.archiveSha256,
      manifestSha256: verification.manifestSha256,
      assetCount: verification.assetCount,
      componentCount: verification.componentCount,
      entryCount: verification.entryCount,
      ...(verification.continuityAssessment
        ? { continuityAssessment: verification.continuityAssessment }
        : {}),
      restoredBytes,
    };
  } catch (error) {
    operationFailed = true;
    let reportedError = error;
    if (destinationCreated) {
      try {
        await fs.rm(destination, { recursive: true, force: true });
      } catch (cleanupError) {
        reportedError = new AggregateError(
          [error, cleanupError],
          `Backup retrieve failed and the incomplete destination could not be removed: ${destination}`,
        );
      }
    }
    operationFailure = reportedError;
  }

  let tempCleanupFailure: unknown;
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    tempCleanupFailure = error;
  }

  if (operationFailed) {
    if (tempCleanupFailure !== undefined) {
      throw new AggregateError(
        [operationFailure, tempCleanupFailure],
        `Backup retrieve failed and its temporary archive could not be removed: ${tempDir}`,
        { cause: operationFailure },
      );
    }
    throw operationFailure;
  }
  if (tempCleanupFailure !== undefined) {
    throw new Error(
      `Backup was retrieved but its temporary archive could not be removed: ${tempDir}`,
      { cause: tempCleanupFailure },
    );
  }
  if (!result) {
    throw new Error("Backup retrieve completed without producing a result.");
  }
  return result;
}

/** Retrieve a verified backup into a new staging directory without activating it. */
export async function backupRetrieveCommand(
  runtime: RuntimeEnv,
  opts: BackupRetrieveOptions,
): Promise<BackupRetrieveResult> {
  const result = await retrieveBackupArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
