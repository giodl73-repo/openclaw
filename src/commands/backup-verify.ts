// Verifies backup archives by validating their manifest, payload entries, and hardlink targets.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import {
  BACKUP_CONTINUITY_BLOCKER_CODES,
  BACKUP_CONTINUITY_TARGET_LEVEL,
  type BackupContinuityAssessment,
  type BackupContinuityBlockerCode,
} from "../continuity/backup-assessment.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";
import {
  type BackupManifestComponent,
  validateBackupManifestComponents,
} from "./backup-manifest-components.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
export const DEFAULT_BACKUP_VERIFY_MAX_ENTRIES = 1_000_000;

type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
  component?: BackupManifestComponent;
};

type BackupManifest = {
  schemaVersion: number;
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
};

type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
  maxEntries?: number;
};

export type BackupVerifyResult = {
  ok: true;
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
};

type ArchiveEntry = {
  path: string;
  linkpath?: string;
  type?: string;
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

function parseManifest(raw: string): BackupManifest {
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
    });
  }
  validateBackupManifestComponents(assets);

  return {
    schemaVersion: 1,
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
    continuityAssessment: parseContinuityAssessment(parsed.continuityAssessment),
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
): Promise<{
  entries: ArchiveEntry[];
  manifestContents: Buffer[];
  archiveSha256: string;
}> {
  const entries: ArchiveEntry[] = [];
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

function verifyManifestAgainstEntries(manifest: BackupManifest, entries: Set<string>): void {
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
    `Backup archive OK: ${result.archivePath}`,
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

/** Verify a backup archive without extracting payload files to disk. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const maxEntries = opts.maxEntries ?? DEFAULT_BACKUP_VERIFY_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Backup verify maxEntries must be a positive safe integer.");
  }
  const inspection = await inspectArchive(archivePath, maxEntries);
  const rawEntries = inspection.entries;
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
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
  const manifest = parseManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet);
  verifyHardlinkTargetsAgainstArchiveRoot(
    hardlinkTargets,
    manifest.archiveRoot,
    normalizedEntrySet,
  );

  const result: BackupVerifyResult = {
    ok: true,
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
  };

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
