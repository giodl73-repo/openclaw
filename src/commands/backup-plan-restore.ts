import fs from "node:fs/promises";
import path from "node:path";
import {
  buildContinuityRestorePlanReceipt,
  ContinuityRestorePlanError,
  type CanonicalRestorePlanAsset,
  type ContinuityRestorePlanReceipt,
} from "../continuity/restore-plan.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { assertSafeRetrievedTree, DEFAULT_BACKUP_RETRIEVE_MAX_BYTES } from "./backup-retrieve.js";
import {
  type BackupManifest,
  type BackupManifestAsset,
  verifyBackupArchive,
} from "./backup-verify.js";

const MATERIALIZATION_RECEIPT = ".openclaw-continuity-materialization.json";

export type BackupPlanRestoreOptions = {
  archive: string;
  materialized: string;
  authorize: string[];
  json?: boolean;
  maxBytes?: number;
};

export type BackupPlanRestoreResult = {
  ok: true;
  archivePath: string;
  materializedRoot: string;
  plan: ContinuityRestorePlanReceipt;
};

type ProspectiveTarget = {
  canonicalPath: string;
  canonicalAnchor: string;
  exists: boolean;
};

function receiptString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Continuity materialization receipt ${key} is invalid.`);
  }
  return value;
}

function parseMaterializationReceipt(
  raw: string,
  expected: {
    archiveRoot: string;
    archiveSha256: string;
    manifestSha256: string;
  },
): void {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Continuity materialization receipt must be an object.");
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.artifactType !== "continuity" ||
    parsed.activated !== false ||
    parsed.activationReady !== false ||
    parsed.effectiveArchived !== false ||
    receiptString(parsed, "archiveRoot") !== expected.archiveRoot ||
    receiptString(parsed, "archiveSha256") !== expected.archiveSha256 ||
    receiptString(parsed, "manifestSha256") !== expected.manifestSha256
  ) {
    throw new Error("Continuity materialization receipt does not match the verified archive.");
  }
}

async function resolveProspectiveTarget(rawPath: string): Promise<ProspectiveTarget> {
  const resolved = path.resolve(resolveUserPath(rawPath));
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  let canonicalAnchor = await fs.realpath(root);

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return {
        canonicalPath: path.join(canonicalAnchor, ...segments.slice(index)),
        canonicalAnchor,
        exists: false,
      };
    }
    if (stat.isSymbolicLink()) {
      throw new ContinuityRestorePlanError(
        "continuity.restore.target_alias",
        "Continuity restore target traverses a symbolic-link alias.",
      );
    }
    const isTarget = index === segments.length - 1;
    if (!isTarget && !stat.isDirectory()) {
      throw new ContinuityRestorePlanError(
        "continuity.restore.target_alias",
        "Continuity restore target traverses a non-directory path component.",
      );
    }
    const canonicalCurrent = await fs.realpath(current);
    if (isTarget) {
      return {
        canonicalPath: canonicalCurrent,
        canonicalAnchor,
        exists: true,
      };
    }
    canonicalAnchor = canonicalCurrent;
  }
  throw new ContinuityRestorePlanError(
    "continuity.restore.target_alias",
    "Continuity restore cannot target a filesystem root.",
  );
}

function resolveMaterializedAssetPath(params: {
  materializedRoot: string;
  manifest: BackupManifest;
  asset: BackupManifestAsset;
}): string {
  const payloadRoot = path.posix.join(params.manifest.archiveRoot, "payload");
  const relative = path.posix.relative(payloadRoot, params.asset.archivePath);
  if (!relative || relative === ".." || relative.startsWith("../")) {
    throw new Error(`Continuity asset escaped the payload root: ${params.asset.archivePath}`);
  }
  return path.join(params.materializedRoot, ...relative.split("/"));
}

async function resolvePlanAsset(params: {
  materializedRoot: string;
  manifest: BackupManifest;
  asset: BackupManifestAsset;
}): Promise<{ asset: CanonicalRestorePlanAsset; targetExists: boolean }> {
  if (!params.asset.component) {
    throw new Error("Continuity restore planning requires a complete component graph.");
  }
  if (
    params.asset.kind !== "state" &&
    params.asset.kind !== "config" &&
    params.asset.kind !== "config-include" &&
    params.asset.kind !== "workspace"
  ) {
    throw new Error(
      `Continuity restore planning does not support asset kind: ${params.asset.kind}`,
    );
  }
  const target = await resolveProspectiveTarget(params.asset.sourcePath);
  const materializedPath = resolveMaterializedAssetPath(params);
  const materializedStat = await fs.lstat(materializedPath);
  const targetKind =
    params.asset.kind === "state" || params.asset.kind === "workspace" ? "directory" : "file";
  if (
    materializedStat.isSymbolicLink() ||
    (targetKind === "directory" && !materializedStat.isDirectory()) ||
    (targetKind === "file" && !materializedStat.isFile())
  ) {
    throw new Error(
      `Continuity materialized asset has the wrong type: ${params.asset.archivePath}`,
    );
  }
  return {
    asset: {
      componentId: params.asset.component.id,
      kind: params.asset.kind,
      restoreOrder: params.asset.component.restoreOrder,
      canonicalTargetPath: target.canonicalPath,
      canonicalTargetAnchor: target.canonicalAnchor,
      materializedSourcePath: await fs.realpath(materializedPath),
      targetKind,
    },
    targetExists: target.exists,
  };
}

function formatResult(result: BackupPlanRestoreResult): string {
  return [
    `Continuity restore plan: ${result.plan.planId}`,
    `Publication roots: ${result.plan.groups.length}`,
    ...result.plan.groups.map(
      (group) => `- ${group.canonicalTargetPath} (${group.members.length} component(s))`,
    ),
    "Execution blocked: materialized content identity, launcher lease, and atomic no-replace publication are required.",
    "No target, staging, Gateway, or startup state was changed.",
  ].join("\n");
}

async function planContinuityRestore(
  opts: BackupPlanRestoreOptions,
): Promise<BackupPlanRestoreResult> {
  if (opts.authorize.length === 0) {
    throw new Error("Continuity restore planning requires at least one authorized root.");
  }
  const archivePath = resolveUserPath(opts.archive);
  const materializedInput = resolveUserPath(opts.materialized);
  const materializedStat = await fs.lstat(materializedInput);
  if (!materializedStat.isDirectory() || materializedStat.isSymbolicLink()) {
    throw new Error("Continuity materialized root must be a regular directory.");
  }
  const materializedRoot = await fs.realpath(materializedInput);
  const verified = await verifyBackupArchive({
    archive: archivePath,
    maxContentBytes: opts.maxBytes ?? DEFAULT_BACKUP_RETRIEVE_MAX_BYTES,
  });
  if (verified.manifest.artifactType !== "continuity") {
    throw new Error("Restore planning requires a verified continuity archive.");
  }
  const receiptPath = path.join(materializedRoot, MATERIALIZATION_RECEIPT);
  const receiptRaw = await fs.readFile(receiptPath, "utf8");
  parseMaterializationReceipt(receiptRaw, {
    archiveRoot: verified.result.archiveRoot,
    archiveSha256: verified.result.archiveSha256,
    manifestSha256: verified.result.manifestSha256,
  });
  await assertSafeRetrievedTree(
    materializedRoot,
    opts.maxBytes ?? DEFAULT_BACKUP_RETRIEVE_MAX_BYTES,
    new Set([MATERIALIZATION_RECEIPT]),
  );

  const resolvedAssets = await Promise.all(
    verified.manifest.assets.map(
      async (asset) =>
        await resolvePlanAsset({ materializedRoot, manifest: verified.manifest, asset }),
    ),
  );
  const authorizedRoots = await Promise.all(
    opts.authorize.map(async (target) => (await resolveProspectiveTarget(target)).canonicalPath),
  );
  const plan = buildContinuityRestorePlanReceipt({
    runtimeVersion: resolveRuntimeServiceVersion(),
    artifact: {
      archiveSha256: verified.result.archiveSha256,
      manifestSha256: verified.result.manifestSha256,
      archiveRoot: verified.result.archiveRoot,
    },
    materialization: {
      receiptSha256: sha256Hex(receiptRaw),
      root: materializedRoot,
    },
    assets: resolvedAssets.map((entry) => entry.asset),
    authorizedPublicationRoots: authorizedRoots,
    existingTargetPaths: new Set(
      resolvedAssets
        .filter((entry) => entry.targetExists)
        .map((entry) => entry.asset.canonicalTargetPath),
    ),
  });
  return { ok: true, archivePath, materializedRoot, plan };
}

/** Plan exact-path continuity restore without writing targets or staging. */
export async function backupPlanRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupPlanRestoreOptions,
): Promise<BackupPlanRestoreResult> {
  const result = await planContinuityRestore(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
