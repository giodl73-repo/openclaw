// Retrieves a verified backup archive into a new, non-active staging directory.
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import type { BackupContinuityAssessment } from "../continuity/backup-assessment.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
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
  const normalized = path.posix.normalize(rawPath);
  if (
    normalized !== rawPath.replace(/\/+$/u, "") ||
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

  const archiveStat = await fs.lstat(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error(`Backup retrieve archive must be a regular file: ${archivePath}`);
  }
  if (archiveStat.size > maxBytes) {
    throw new Error(`Backup archive exceeds the ${maxBytes}-byte retrieve limit.`);
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
    await fs.copyFile(archivePath, snapshotPath, fsConstants.COPYFILE_EXCL);
    await fs.chmod(snapshotPath, 0o600);
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

    await fsSafeRoot(destination, {
      symlinks: "reject",
      hardlinks: "reject",
      maxBytes,
      nonBlockingRead: true,
    });
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
