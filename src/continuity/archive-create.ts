import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import * as tar from "tar";
import type { BackupManifestComponent } from "../commands/backup-manifest-components.js";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { publishTempArchive, writeArchiveStreamToFile } from "../infra/backup-create.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  buildContinuityArchiveCapture,
  type ContinuityArchiveCapture,
} from "./archive-manifest.js";
import {
  buildContinuityArchiveObligations,
  type ContinuityArchiveObligations,
} from "./archive-obligations.js";
import type { ContinuityArchivePlan, ContinuityCaptureSource } from "./archive-plan.js";
import { stageContinuityArchivePlan } from "./archive-stage.js";

type ContinuityManifestAsset = {
  kind: ContinuityCaptureSource["kind"];
  sourcePath: string;
  archivePath: string;
  component: BackupManifestComponent;
  contentSha256?: string;
};

type ContinuityManifest = {
  schemaVersion: 1;
  artifactType: "continuity";
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  options: {
    includeWorkspace: true;
  };
  assets: ContinuityManifestAsset[];
  stateFilePaths: string[];
  sanitizedSqlitePaths: string[];
  continuityCapture: ContinuityArchiveCapture;
  continuityObligations: ContinuityArchiveObligations;
};

export type ContinuityArchiveCreateResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  archiveSha256: string;
  manifestSha256: string;
  assetCount: number;
  componentCount: number;
  entryCount: number;
  continuityCapture: ContinuityArchiveCapture;
  continuityObligations: ContinuityArchiveObligations;
};

function buildContinuityComponents(
  sources: readonly ContinuityCaptureSource[],
): BackupManifestComponent[] {
  const rootConfig = sources.find((source) => source.kind === "config");
  const state = sources.find((source) => source.kind === "state");
  if (!rootConfig || !state) {
    throw new Error("Continuity artifact requires root config and state components.");
  }
  const includes = sources
    .filter((source) => source.kind === "config-include")
    .toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const workspaces = sources
    .filter((source) => source.kind === "workspace")
    .toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const components = new Map<ContinuityCaptureSource, BackupManifestComponent>();
  let restoreOrder = 0;
  const includeIds: string[] = [];
  for (const include of includes) {
    const id = `config-include-${sha256Hex(include.sourcePath).slice(0, 16)}`;
    includeIds.push(id);
    components.set(include, { id, restoreOrder, dependsOn: [] });
    restoreOrder += 1;
  }
  components.set(rootConfig, {
    id: "config",
    restoreOrder,
    dependsOn: includeIds,
  });
  restoreOrder += 1;
  components.set(state, {
    id: "state",
    restoreOrder,
    dependsOn: ["config"],
  });
  restoreOrder += 1;
  for (const workspace of workspaces) {
    components.set(workspace, {
      id: `workspace-${sha256Hex(workspace.sourcePath).slice(0, 16)}`,
      restoreOrder,
      dependsOn: ["state"],
    });
    restoreOrder += 1;
  }
  return sources.map((source) => {
    const component = components.get(source);
    if (!component) {
      throw new Error(`Continuity component is missing for source: ${source.sourcePath}`);
    }
    return component;
  });
}

function buildManifest(params: {
  plan: ContinuityArchivePlan;
  createdAt: string;
  continuityCapture: ContinuityArchiveCapture;
  sanitizedSqlitePaths: string[];
  stateFilePaths: string[];
}): ContinuityManifest {
  const sources = [
    params.plan.sources.state,
    ...params.plan.sources.config,
    ...params.plan.sources.workspaces,
  ];
  const components = buildContinuityComponents(sources);
  return {
    schemaVersion: 1,
    artifactType: "continuity",
    createdAt: params.createdAt,
    archiveRoot: params.plan.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: true,
    },
    assets: sources.map((source, index) => {
      const asset: ContinuityManifestAsset = {
        kind: source.kind,
        sourcePath: source.sourcePath,
        archivePath: source.archivePath,
        component: components[index]!,
      };
      if (source.expectedSha256) {
        asset.contentSha256 = source.expectedSha256;
      }
      return asset;
    }),
    stateFilePaths: params.stateFilePaths,
    sanitizedSqlitePaths: params.sanitizedSqlitePaths,
    continuityCapture: params.continuityCapture,
    continuityObligations: buildContinuityArchiveObligations(params.continuityCapture.evidence),
  };
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

async function assertOutputReady(
  outputPath: string,
  sources: readonly ContinuityCaptureSource[],
): Promise<void> {
  const canonicalOutput = await canonicalizeProspectivePath(outputPath);
  const overlappingSource = sources.find(
    (source) =>
      canonicalOutput === source.sourcePath || isPathWithin(canonicalOutput, source.sourcePath),
  );
  if (overlappingSource) {
    throw new Error(
      `Continuity archive output must be outside every source: ${overlappingSource.sourcePath}`,
    );
  }
  try {
    await fs.lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Refusing to overwrite existing continuity archive: ${outputPath}`);
}

/** Stage, package, verify, and immutably publish one dedicated continuity artifact. */
export async function createContinuityArchive(params: {
  plan: ContinuityArchivePlan;
  outputPath: string;
  stagingParent: string;
  nowMs?: number;
}): Promise<ContinuityArchiveCreateResult> {
  const outputPath = path.resolve(params.outputPath);
  const sources = [
    params.plan.sources.state,
    ...params.plan.sources.config,
    ...params.plan.sources.workspaces,
  ];
  await assertOutputReady(outputPath, sources);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const staging = await stageContinuityArchivePlan({
    plan: params.plan,
    stagingParent: params.stagingParent,
  });
  const tempArchivePath = `${outputPath}.${randomUUID()}.tmp`;
  let result: ContinuityArchiveCreateResult | undefined;
  let operationError: unknown;
  try {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    const createdAt = new Date(nowMs).toISOString();
    const continuityCapture = buildContinuityArchiveCapture(staging.evidence);
    const manifest = buildManifest({
      plan: params.plan,
      createdAt,
      continuityCapture,
      stateFilePaths: staging.stateFileArchivePaths,
      sanitizedSqlitePaths: staging.sanitizedSqliteArchivePaths,
    });
    const manifestPath = path.join(staging.artifactRoot, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await writeArchiveStreamToFile({
      archivePath: tempArchivePath,
      archiveStream: tar.c(
        {
          cwd: staging.stagingDir,
          gzip: true,
          portable: true,
          preservePaths: false,
        },
        [params.plan.archiveRoot],
      ),
    });
    const verification = await backupVerifyCommand(
      { log: () => {}, error: () => {}, exit: () => {} },
      { archive: tempArchivePath },
    );
    if (
      verification.artifactType !== "continuity" ||
      !verification.continuityCapture ||
      !verification.continuityObligations
    ) {
      throw new Error("Packaged continuity artifact did not verify as continuity.");
    }
    await publishTempArchive({ tempArchivePath, outputPath });
    result = {
      ok: true,
      archivePath: outputPath,
      archiveRoot: verification.archiveRoot,
      createdAt,
      archiveSha256: verification.archiveSha256,
      manifestSha256: verification.manifestSha256,
      assetCount: verification.assetCount,
      componentCount: verification.componentCount,
      entryCount: verification.entryCount,
      continuityCapture: verification.continuityCapture,
      continuityObligations: verification.continuityObligations,
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const cleanupPath of [tempArchivePath, staging.stagingDir]) {
    try {
      await fs.rm(cleanupPath, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Continuity archive creation failed and cleanup was incomplete.",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Continuity archive was published but staging cleanup failed: ${outputPath}`,
    );
  }
  if (!result) {
    throw new Error("Continuity archive creation completed without a result.");
  }
  return result;
}
