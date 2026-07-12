// Verifies backup archives by validating their manifest, payload entries, and hardlink targets.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import {
  parseContinuityArchiveCapture,
  type ContinuityArchiveCapture,
} from "../continuity/archive-manifest.js";
import {
  BACKUP_CONTINUITY_BLOCKER_CODES,
  BACKUP_CONTINUITY_TARGET_LEVEL,
  type BackupContinuityAssessment,
  type BackupContinuityBlockerCode,
} from "../continuity/backup-assessment.js";
import { verifyContinuitySqliteSnapshot } from "../continuity/sqlite-sanitize.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";
import {
  type BackupManifestComponent,
  validateBackupManifestComponents,
} from "./backup-manifest-components.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
export const DEFAULT_BACKUP_VERIFY_MAX_ENTRIES = 1_000_000;
export const DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES = 16 * 1024 ** 3;

export type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
  component?: BackupManifestComponent;
  contentSha256?: string;
};

export type BackupManifest = {
  schemaVersion: number;
  artifactType: "backup" | "continuity";
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
  };
  assets: BackupManifestAsset[];
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
  continuityAssessment?: BackupContinuityAssessment;
  continuityCapture?: ContinuityArchiveCapture;
  stateFilePaths?: string[];
  sanitizedSqlitePaths?: string[];
};

export type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxContentBytes?: number;
};

export type BackupVerifyResult = {
  ok: true;
  artifactType: "backup" | "continuity";
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  componentCount: number;
  entryCount: number;
  archiveSha256: string;
  manifestSha256: string;
  continuityAssessment?: BackupContinuityAssessment;
  continuityCapture?: ContinuityArchiveCapture;
};

export type VerifiedBackupArchive = {
  manifest: BackupManifest;
  result: BackupVerifyResult;
};

type ArchiveEntry = {
  path: string;
  linkpath?: string;
  type?: string;
  size?: number;
};

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {
    throw new Error(`${label} must be relative: ${entryPath}`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${entryPath}`);
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

function readStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

const BACKUP_CONTINUITY_BLOCKER_CODE_SET = new Set<string>(BACKUP_CONTINUITY_BLOCKER_CODES);

function isBackupContinuityBlockerCode(value: unknown): value is BackupContinuityBlockerCode {
  return typeof value === "string" && BACKUP_CONTINUITY_BLOCKER_CODE_SET.has(value);
}

function parseContinuityAssessment(value: unknown): BackupContinuityAssessment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Backup manifest continuityAssessment must be an object.");
  }
  if (value.targetLevel !== BACKUP_CONTINUITY_TARGET_LEVEL || value.eligible !== false) {
    throw new Error("Backup manifest continuityAssessment has unsupported eligibility metadata.");
  }
  if (!Array.isArray(value.blockers) || value.blockers.length === 0) {
    throw new Error("Backup manifest continuityAssessment must contain blockers.");
  }
  const blockers = value.blockers.map((blocker) => {
    if (!isRecord(blocker)) {
      throw new Error("Backup manifest continuityAssessment contains a non-object blocker.");
    }
    if (!isBackupContinuityBlockerCode(blocker.code)) {
      throw new Error(
        `Backup manifest continuityAssessment blocker code is invalid: ${String(blocker.code)}`,
      );
    }
    if (
      typeof blocker.count !== "number" ||
      !Number.isSafeInteger(blocker.count) ||
      blocker.count <= 0
    ) {
      throw new Error(
        `Backup manifest continuityAssessment blocker count is invalid: ${blocker.code}`,
      );
    }
    return {
      code: blocker.code,
      count: blocker.count,
    };
  });
  if (new Set(blockers.map((blocker) => blocker.code)).size !== blockers.length) {
    throw new Error("Backup manifest continuityAssessment contains duplicate blocker codes.");
  }
  if (
    !blockers.some(
      (blocker) =>
        blocker.code === "continuity.config.secret_classification_unproven" && blocker.count === 1,
    )
  ) {
    throw new Error("Backup manifest continuityAssessment is missing its fail-closed blocker.");
  }
  return {
    targetLevel: BACKUP_CONTINUITY_TARGET_LEVEL,
    eligible: false,
    blockers,
  };
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

export function parseBackupManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Backup manifest is not valid JSON.", { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }
  const artifactType =
    parsed.artifactType === undefined
      ? "backup"
      : parsed.artifactType === "backup" || parsed.artifactType === "continuity"
        ? parsed.artifactType
        : undefined;
  if (!artifactType) {
    throw new Error(`Unsupported backup artifactType: ${String(parsed.artifactType)}`);
  }
  const continuityAssessment = parseContinuityAssessment(parsed.continuityAssessment);
  const continuityCapture =
    parsed.continuityCapture === undefined
      ? undefined
      : parseContinuityArchiveCapture(parsed.continuityCapture);
  const sanitizedSqlitePaths =
    parsed.sanitizedSqlitePaths === undefined
      ? undefined
      : readStringArray(parsed.sanitizedSqlitePaths, "Continuity manifest sanitizedSqlitePaths");
  const stateFilePaths =
    parsed.stateFilePaths === undefined
      ? undefined
      : readStringArray(parsed.stateFilePaths, "Continuity manifest stateFilePaths");
  if (artifactType === "continuity") {
    if (!continuityCapture || !stateFilePaths || !sanitizedSqlitePaths || continuityAssessment) {
      throw new Error(
        "Continuity artifacts require successful capture metadata, state and SQLite inventories, and no backup assessment.",
      );
    }
  } else if (continuityCapture || stateFilePaths || sanitizedSqlitePaths) {
    throw new Error("Ordinary backup artifacts cannot claim continuity capture metadata.");
  }

  const assets: BackupManifestAsset[] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    let component: BackupManifestComponent | undefined;
    if (asset.component !== undefined) {
      if (!isRecord(asset.component)) {
        throw new Error("Backup manifest asset component must be an object.");
      }
      component = {
        id: readStringValue(asset.component.id) ?? "",
        restoreOrder:
          typeof asset.component.restoreOrder === "number"
            ? asset.component.restoreOrder
            : Number.NaN,
        dependsOn: readStringArray(
          asset.component.dependsOn,
          "Backup manifest component dependsOn",
        ),
      };
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
      ...(component ? { component } : {}),
      ...(typeof asset.contentSha256 === "string" ? { contentSha256: asset.contentSha256 } : {}),
    });
  }
  validateBackupManifestComponents(assets);

  return {
    schemaVersion: 1,
    artifactType,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    options: isRecord(parsed.options)
      ? { includeWorkspace: parsed.options.includeWorkspace as boolean | undefined }
      : undefined,
    paths: isRecord(parsed.paths)
      ? {
          stateDir: readStringValue(parsed.paths.stateDir),
          configPath: readStringValue(parsed.paths.configPath),
          oauthDir: readStringValue(parsed.paths.oauthDir),
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined,
    assets,
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : undefined,
    continuityAssessment,
    continuityCapture,
    stateFilePaths,
    sanitizedSqlitePaths,
  };
}

async function readManifestEntry(
  entry: tar.ReadEntry,
): Promise<{ content?: Buffer; error?: Error }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let exceededLimit = false;
  for await (const chunk of entry) {
    if (exceededLimit) {
      continue;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_MANIFEST_BYTES) {
      exceededLimit = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceededLimit) {
    return { error: new Error(`Backup manifest exceeds ${MAX_MANIFEST_BYTES} byte limit.`) };
  }
  return { content: Buffer.concat(chunks, totalBytes) };
}

async function inspectArchive(
  archivePath: string,
  maxEntries: number,
  maxArchiveBytes?: number,
): Promise<{
  entries: ArchiveEntry[];
  manifestContents: Buffer[];
  archiveSha256: string;
}> {
  const entries: ArchiveEntry[] = [];
  let archiveBytes = 0;
  const manifestPromises: Array<ReturnType<typeof readManifestEntry>> = [];
  const digest = createHash("sha256");
  const parser: tar.Parser = tar.t({
    gzip: true,
    onentry: (entry) => {
      if (entries.length >= maxEntries) {
        entry.resume();
        parser.abort(new Error(`Backup archive exceeds the ${maxEntries}-entry limit.`));
        return;
      }
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(entry.type ? { type: entry.type } : {}),
        ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
      });
      if (!isRootManifestEntry(entry.path)) {
        entry.resume();
        return;
      }
      manifestPromises.push(readManifestEntry(entry));
    },
  });
  await pipeline(
    createReadStream(archivePath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveBytes += chunk.length;
        if (maxArchiveBytes !== undefined && archiveBytes > maxArchiveBytes) {
          callback(new Error(`Backup archive exceeds the ${maxArchiveBytes}-byte verify limit.`));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    }),
    parser,
  );
  const manifestResults = await Promise.all(manifestPromises);
  const manifestError = manifestResults.find((result) => result.error)?.error;
  if (manifestError) {
    throw manifestError;
  }
  return {
    entries,
    manifestContents: manifestResults.flatMap((result) => (result.content ? [result.content] : [])),
    archiveSha256: digest.digest("hex"),
  };
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function verifyManifestAgainstEntries(
  manifest: BackupManifest,
  entries: Set<string>,
  typedEntries: Array<{ normalized: string; type?: string }>,
): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];
  const normalizedEntrySet = new Set(normalizedEntries);

  if (!normalizedEntrySet.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  function verifyContinuityManifestAgainstEntries(
    continuityManifest: BackupManifest,
    continuityEntries: Array<{ normalized: string; type?: string }>,
  ): void {
    const capture = continuityManifest.continuityCapture;
    if (!capture) {
      return;
    }
    const unsupportedEntry = continuityEntries.find(
      (entry) => entry.type !== "File" && entry.type !== "Directory",
    );
    if (unsupportedEntry) {
      throw new Error(
        `Continuity archive contains unsupported entry type: ${unsupportedEntry.normalized}`,
      );
    }
    const stateAssets = continuityManifest.assets.filter((asset) => asset.kind === "state");
    const rootConfigAssets = continuityManifest.assets.filter((asset) => asset.kind === "config");
    const configAssets = continuityManifest.assets.filter(
      (asset) => asset.kind === "config" || asset.kind === "config-include",
    );
    const workspaceAssets = continuityManifest.assets.filter((asset) => asset.kind === "workspace");
    const unsupportedAsset = continuityManifest.assets.find(
      (asset) =>
        asset.kind !== "state" &&
        asset.kind !== "config" &&
        asset.kind !== "config-include" &&
        asset.kind !== "workspace",
    );
    if (
      unsupportedAsset ||
      stateAssets.length !== 1 ||
      rootConfigAssets.length !== 1 ||
      configAssets.length !== capture.evidence.configFileCount ||
      workspaceAssets.length !== capture.evidence.workspaceCount ||
      continuityManifest.assets.some((asset) => asset.component === undefined)
    ) {
      throw new Error("Continuity manifest assets are inconsistent with capture evidence.");
    }
    if (
      configAssets.some(
        (asset) => !asset.contentSha256 || !/^[a-f0-9]{64}$/u.test(asset.contentSha256),
      )
    ) {
      throw new Error("Continuity config assets require SHA-256 content identities.");
    }

    const continuityRoot = normalizeArchiveRoot(continuityManifest.archiveRoot);
    const continuityManifestEntryPath = path.posix.join(continuityRoot, "manifest.json");
    const fileEntries = continuityEntries.filter((entry) => entry.type === "File");
    const directoryEntrySet = new Set(
      continuityEntries
        .filter((entry) => entry.type === "Directory")
        .map((entry) => entry.normalized),
    );
    const payloadFiles = fileEntries.filter(
      (entry) => entry.normalized !== continuityManifestEntryPath,
    );
    const payloadFileSet = new Set(payloadFiles.map((entry) => entry.normalized));
    const configAssetPaths = configAssets.map((asset) =>
      normalizeArchivePath(asset.archivePath, "Continuity config asset path"),
    );
    const workspaceAssetPaths = workspaceAssets.map((asset) =>
      normalizeArchivePath(asset.archivePath, "Continuity workspace asset path"),
    );
    if (
      configAssetPaths.some((assetPath) => !payloadFileSet.has(assetPath)) ||
      workspaceAssetPaths.some((assetPath) => !directoryEntrySet.has(assetPath))
    ) {
      throw new Error("Continuity config and workspace assets have invalid archive entry types.");
    }
    const uncoveredFile = payloadFiles.find(
      (entry) =>
        !continuityManifest.assets.some((asset) =>
          isArchivePathWithin(
            entry.normalized,
            normalizeArchivePath(asset.archivePath, "Continuity manifest asset path"),
          ),
        ),
    );
    if (uncoveredFile) {
      throw new Error(
        `Continuity archive file is not covered by an asset: ${uncoveredFile.normalized}`,
      );
    }
    if (payloadFiles.length !== capture.evidence.copiedFileCount) {
      throw new Error("Continuity archive file count does not match capture evidence.");
    }

    const stateAssetPath = normalizeArchivePath(
      stateAssets[0]!.archivePath,
      "Continuity state asset path",
    );
    const separatelyCapturedPaths = [...configAssetPaths, ...workspaceAssetPaths];
    const stateFilePaths = (continuityManifest.stateFilePaths ?? []).map((entryPath) =>
      normalizeArchivePath(entryPath, "Continuity state file path"),
    );
    const sanitizedSqlitePaths = (continuityManifest.sanitizedSqlitePaths ?? []).map((entryPath) =>
      normalizeArchivePath(entryPath, "Continuity sanitized SQLite path"),
    );
    const expectedSanitizedSqlitePaths = stateFilePaths.filter((entryPath) =>
      entryPath.toLowerCase().endsWith(".sqlite"),
    );
    const sqliteSidecarPath = stateFilePaths.find((entryPath) =>
      /\.sqlite-(?:wal|shm|journal)$/iu.test(entryPath),
    );
    const unownedFile = payloadFiles.find(
      (entry) =>
        !stateFilePaths.includes(entry.normalized) &&
        !configAssetPaths.includes(entry.normalized) &&
        !workspaceAssetPaths.some((assetPath) => isArchivePathWithin(entry.normalized, assetPath)),
    );
    if (
      new Set(stateFilePaths).size !== stateFilePaths.length ||
      stateFilePaths.some(
        (entryPath) =>
          !isArchivePathWithin(entryPath, stateAssetPath) ||
          !payloadFileSet.has(entryPath) ||
          separatelyCapturedPaths.some((assetPath) => isArchivePathWithin(entryPath, assetPath)),
      ) ||
      sqliteSidecarPath ||
      unownedFile ||
      new Set(sanitizedSqlitePaths).size !== sanitizedSqlitePaths.length ||
      sanitizedSqlitePaths.length !== capture.evidence.sqliteSnapshotCount ||
      sanitizedSqlitePaths.length !== expectedSanitizedSqlitePaths.length ||
      sanitizedSqlitePaths.some((entryPath) => !expectedSanitizedSqlitePaths.includes(entryPath)) ||
      sanitizedSqlitePaths.some(
        (entryPath) =>
          !entryPath.toLowerCase().endsWith(".sqlite") ||
          !isArchivePathWithin(entryPath, stateAssetPath) ||
          !payloadFileSet.has(entryPath),
      )
    ) {
      throw new Error("Continuity state and SQLite inventories do not match archive contents.");
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = normalizedEntries.some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
  verifyContinuityManifestAgainstEntries(manifest, typedEntries);
}

async function verifyContinuityManifestContents(params: {
  archivePath: string;
  manifest: BackupManifest;
  entries: Array<{ normalized: string; type?: string; size?: number }>;
  maxContentBytes: number;
}): Promise<void> {
  if (!params.manifest.continuityCapture) {
    return;
  }
  const configAssets = params.manifest.assets.filter(
    (asset) => asset.kind === "config" || asset.kind === "config-include",
  );
  const sqlitePaths = (params.manifest.sanitizedSqlitePaths ?? []).map((entryPath) =>
    normalizeArchivePath(entryPath, "Continuity sanitized SQLite path"),
  );
  const configPaths = configAssets.map((asset) =>
    normalizeArchivePath(asset.archivePath, "Continuity config asset path"),
  );
  const selectedPaths = new Set([...sqlitePaths, ...configPaths]);
  const selectedContentBytes = params.entries
    .filter((entry) => entry.type === "File" && selectedPaths.has(entry.normalized))
    .reduce((total, entry) => {
      if (entry.size === undefined) {
        throw new Error(`Continuity archive entry is missing its size: ${entry.normalized}`);
      }
      return total + entry.size;
    }, 0);
  if (
    !Number.isSafeInteger(selectedContentBytes) ||
    selectedContentBytes > params.maxContentBytes
  ) {
    throw new Error(
      `Continuity verification content exceeds the ${params.maxContentBytes}-byte limit.`,
    );
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-verify-"));
  await fs.chmod(tempDir, 0o700);
  let operationError: unknown;
  try {
    await tar.x({
      file: params.archivePath,
      cwd: tempDir,
      gzip: true,
      preserveOwner: false,
      preservePaths: false,
      strict: true,
      filter: (entryPath) => selectedPaths.has(stripTrailingSlashes(entryPath)),
    });
    for (const asset of configAssets) {
      const archivePath = normalizeArchivePath(asset.archivePath, "Continuity config asset path");
      const extractedPath = path.join(tempDir, ...archivePath.split("/"));
      if ((await sha256File(extractedPath)) !== asset.contentSha256) {
        throw new Error(`Continuity config content identity mismatch: ${archivePath}`);
      }
    }
    for (const archivePath of sqlitePaths) {
      verifyContinuitySqliteSnapshot(path.join(tempDir, ...archivePath.split("/")));
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Continuity content verification failed and temporary cleanup was incomplete.",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw new Error("Continuity content verification cleanup failed.", {
      cause: cleanupError,
    });
  }
}

function verifyHardlinkTargetsAgainstArchiveRoot(
  hardlinkTargets: Array<{ entryPath: string; normalized: string }>,
  archiveRoot: string,
  entries: Set<string>,
): void {
  const normalizedRoot = normalizeArchiveRoot(archiveRoot);
  for (const target of hardlinkTargets) {
    // Older backup archives may store hardlink linkpath values relative to the
    // archive root instead of including the root segment. Accept that form only
    // when it resolves to a real entry inside this archive.
    const normalizedTarget = isArchivePathWithin(target.normalized, normalizedRoot)
      ? target.normalized
      : path.posix.join(normalizedRoot, target.normalized);
    if (!isArchivePathWithin(normalizedTarget, normalizedRoot)) {
      throw new Error(
        `Archive hardlink target is outside the declared archive root: ${target.entryPath} -> ${normalizedTarget}`,
      );
    }
    if (!entries.has(normalizedTarget)) {
      throw new Error(
        `Archive hardlink target is missing from archive entries: ${target.entryPath} -> ${normalizedTarget}`,
      );
    }
  }
}

function formatResult(result: BackupVerifyResult): string {
  return [
    `${result.artifactType === "continuity" ? "Continuity" : "Backup"} archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Components verified: ${result.componentCount}`,
    `Archive entries scanned: ${result.entryCount}`,
    `Archive SHA-256: ${result.archiveSha256}`,
    `Manifest SHA-256: ${result.manifestSha256}`,
    ...(result.continuityAssessment
      ? [
          `Archived continuity eligible: ${result.continuityAssessment.eligible ? "yes" : "no"}`,
          `Continuity blockers: ${result.continuityAssessment.blockers.map((blocker) => blocker.code).join(", ")}`,
        ]
      : []),
    ...(result.continuityCapture
      ? [
          "Archived continuity eligible: yes",
          `SQLite snapshots sanitized: ${result.continuityCapture.evidence.sqliteSnapshotCount}`,
        ]
      : []),
  ].join("\n");
}

function findDuplicateNormalizedEntryPath(
  entries: Array<{ normalized: string }>,
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalized)) {
      return entry.normalized;
    }
    seen.add(entry.normalized);
  }
  return undefined;
}

/** Verify a backup archive and return its validated manifest without extracting its payload. */
export async function verifyBackupArchive(
  opts: BackupVerifyOptions,
): Promise<VerifiedBackupArchive> {
  const archivePath = resolveUserPath(opts.archive);
  const maxEntries = opts.maxEntries ?? DEFAULT_BACKUP_VERIFY_MAX_ENTRIES;
  const maxContentBytes = opts.maxContentBytes ?? DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Backup verify maxEntries must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes <= 0) {
    throw new Error("Backup verify maxContentBytes must be a positive safe integer.");
  }
  if (
    opts.maxArchiveBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxArchiveBytes) || opts.maxArchiveBytes <= 0)
  ) {
    throw new Error("Backup verify maxArchiveBytes must be a positive safe integer.");
  }
  const inspection = await inspectArchive(archivePath, maxEntries, opts.maxArchiveBytes);
  const rawEntries = inspection.entries;
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
  }));
  const hardlinkTargets = rawEntries
    .filter((entry) => entry.type === "Link" && entry.linkpath)
    .map((entry) => ({
      entryPath: entry.path,
      normalized: normalizeArchivePath(
        entry.linkpath ?? "",
        `Archive hardlink target for ${entry.path}`,
      ),
    }));
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }
  const manifestRawBytes = inspection.manifestContents[0];
  if (!manifestRawBytes) {
    throw new Error("Backup archive manifest contents could not be resolved.");
  }
  const manifestRaw = manifestRawBytes.toString("utf8");
  const manifest = parseBackupManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet, entries);
  verifyHardlinkTargetsAgainstArchiveRoot(
    hardlinkTargets,
    manifest.archiveRoot,
    normalizedEntrySet,
  );
  await verifyContinuityManifestContents({
    archivePath,
    manifest,
    entries,
    maxContentBytes,
  });

  const result: BackupVerifyResult = {
    ok: true,
    artifactType: manifest.artifactType,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    componentCount: manifest.assets.filter((asset) => asset.component !== undefined).length,
    entryCount: rawEntries.length,
    archiveSha256: inspection.archiveSha256,
    manifestSha256: sha256Hex(manifestRawBytes),
    ...(manifest.continuityAssessment
      ? { continuityAssessment: manifest.continuityAssessment }
      : {}),
    ...(manifest.continuityCapture ? { continuityCapture: manifest.continuityCapture } : {}),
  };

  return { manifest, result };
}

/** Verify a backup archive without extracting payload files to disk. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const { result } = await verifyBackupArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
