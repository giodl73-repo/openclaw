import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithin } from "../commands/cleanup-utils.js";
import {
  buildExtensionsNodeModulesFilter,
  classifyStateSqliteBackupSourcePath,
  createStateSqliteBackupPlan,
} from "../infra/backup-create.js";
import {
  isLegacyDeliveryQueueBackupPath,
  isLegacySessionTranscriptBackupPath,
  isVolatileBackupPath,
} from "../infra/backup-volatile-filter.js";
import type { ContinuityArchiveCaptureEvidence } from "./archive-manifest.js";
import type { ContinuityArchivePlan, ContinuityCaptureSource } from "./archive-plan.js";
import { sanitizeContinuitySqliteSnapshot } from "./sqlite-sanitize.js";

export type ContinuityArchiveStagingEvidence = ContinuityArchiveCaptureEvidence;

export type ContinuityArchiveStagingResult = {
  stagingDir: string;
  artifactRoot: string;
  stateFileArchivePaths: string[];
  sanitizedSqliteArchivePaths: string[];
  evidence: ContinuityArchiveStagingEvidence;
};

type CopyContext = {
  stateDir: string;
  excludePaths: readonly string[];
  skippedSqliteSourcePaths?: ReadonlySet<string>;
  snapshotSqlite: boolean;
  extensionsFilter: (sourcePath: string) => boolean;
  stats: {
    copiedFileCount: number;
    omittedPluginDependencyTreeCount: number;
    skippedVolatileCount: number;
  };
};

function isExcluded(sourcePath: string, excludePaths: readonly string[]): boolean {
  const resolvedSourcePath = path.resolve(sourcePath);
  return excludePaths.some((excludePath) => {
    const resolvedExcludePath = path.resolve(excludePath);
    return (
      resolvedSourcePath === resolvedExcludePath ||
      isPathWithin(resolvedSourcePath, resolvedExcludePath)
    );
  });
}

function resolveStagedPath(stagingDir: string, archivePath: string): string {
  const segments = archivePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (
    path.isAbsolute(archivePath) ||
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid continuity staging path: ${archivePath}`);
  }
  const destination = path.join(stagingDir, ...segments);
  if (!isPathWithin(destination, stagingDir)) {
    throw new Error(`Continuity staging path escaped its root: ${archivePath}`);
  }
  return destination;
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
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

function assertStagingOutsideSources(
  stagingPath: string,
  sources: readonly ContinuityCaptureSource[],
): void {
  const overlappingSource = sources.find(
    (source) => stagingPath === source.sourcePath || isPathWithin(stagingPath, source.sourcePath),
  );
  if (overlappingSource) {
    throw new Error(
      `Continuity staging must be outside every capture source: ${overlappingSource.sourcePath}`,
    );
  }
}

async function copyRegularFile(params: {
  sourcePath: string;
  destinationPath: string;
  expectedSha256?: string;
}): Promise<void> {
  const sourceStat = await fs.lstat(params.sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Continuity capture requires a regular file: ${params.sourcePath}`);
  }
  if (sourceStat.nlink > 1) {
    throw new Error(`Continuity capture refuses hard-linked files: ${params.sourcePath}`);
  }
  await ensurePrivateDirectory(path.dirname(params.destinationPath));
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const sourceHandle = await fs.open(params.sourcePath, fsConstants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const openedStat = await sourceHandle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino
    ) {
      throw new Error(`Continuity capture source changed before copy: ${params.sourcePath}`);
    }
    if (openedStat.nlink > 1) {
      throw new Error(`Continuity capture refuses hard-linked files: ${params.sourcePath}`);
    }
    const destinationMode = openedStat.mode & 0o100 ? 0o700 : 0o600;
    destinationHandle = await fs.open(
      params.destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      destinationMode,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          chunk,
          offset,
          bytesRead - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error(`Continuity capture could not write: ${params.destinationPath}`);
        }
        offset += bytesWritten;
      }
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(destinationMode);
    const digest = hash.digest("hex");
    if (params.expectedSha256 && digest !== params.expectedSha256) {
      throw new Error(`Continuity config changed after classification: ${params.sourcePath}`);
    }
  } catch (error) {
    await fs.rm(params.destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

async function copyTree(params: {
  sourcePath: string;
  destinationPath: string;
  context: CopyContext;
}): Promise<void> {
  if (isExcluded(params.sourcePath, params.context.excludePaths)) {
    return;
  }
  const resolvedSourcePath = path.resolve(params.sourcePath);
  if (params.context.skippedSqliteSourcePaths?.has(resolvedSourcePath)) {
    return;
  }
  const sourceStat = await fs.lstat(params.sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Continuity capture refuses symbolic links: ${params.sourcePath}`);
  }
  if (!params.context.extensionsFilter(params.sourcePath)) {
    if (sourceStat.isDirectory()) {
      params.context.stats.omittedPluginDependencyTreeCount += 1;
    }
    return;
  }
  if (sourceStat.isDirectory()) {
    await ensurePrivateDirectory(params.destinationPath);
    const entries = await fs.readdir(params.sourcePath, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      await copyTree({
        sourcePath: path.join(params.sourcePath, entry.name),
        destinationPath: path.join(params.destinationPath, entry.name),
        context: params.context,
      });
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Continuity capture refuses special files: ${params.sourcePath}`);
  }
  if (
    isLegacySessionTranscriptBackupPath(params.sourcePath, {
      stateDirs: [params.context.stateDir],
    })
  ) {
    throw new Error(`Legacy transcript appeared during continuity capture: ${params.sourcePath}`);
  }
  if (
    isLegacyDeliveryQueueBackupPath(params.sourcePath, {
      stateDirs: [params.context.stateDir],
    })
  ) {
    throw new Error(
      `Legacy delivery queue input appeared during continuity capture: ${params.sourcePath}`,
    );
  }
  if (params.context.snapshotSqlite) {
    const sqliteKind = classifyStateSqliteBackupSourcePath(
      resolvedSourcePath,
      params.context.stateDir,
    );
    if (sqliteKind === "excluded") {
      return;
    }
    if (sqliteKind === "sqlite") {
      throw new Error(`SQLite state appeared after continuity discovery: ${params.sourcePath}`);
    }
  }
  if (
    isVolatileBackupPath(params.sourcePath, {
      stateDirs: [params.context.stateDir],
    })
  ) {
    params.context.stats.skippedVolatileCount += 1;
    return;
  }
  await copyRegularFile({
    sourcePath: params.sourcePath,
    destinationPath: params.destinationPath,
  });
  params.context.stats.copiedFileCount += 1;
}

async function assertSourceStillCanonical(source: ContinuityCaptureSource): Promise<void> {
  const canonicalSource = await fs.realpath(source.sourcePath);
  if (canonicalSource !== source.sourcePath) {
    throw new Error(`Continuity capture source changed after planning: ${source.sourcePath}`);
  }
}

async function listStagedFileArchivePaths(params: {
  directoryPath: string;
  archivePath: string;
}): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(params.directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(params.directoryPath, entry.name);
    const archivePath = path.posix.join(params.archivePath, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await listStagedFileArchivePaths({
          directoryPath: entryPath,
          archivePath,
        })),
      );
    } else if (entry.isFile()) {
      files.push(archivePath);
    } else {
      throw new Error(`Continuity staging contains an unsupported entry: ${entryPath}`);
    }
  }
  return files.toSorted();
}

/**
 * Materialize an eligible continuity plan into a new owner-private directory.
 * The returned directory is not an archive and is never activated as live state.
 */
export async function stageContinuityArchivePlan(params: {
  plan: ContinuityArchivePlan;
  stagingParent: string;
}): Promise<ContinuityArchiveStagingResult> {
  if (!params.plan.eligible) {
    throw new Error(
      `Continuity archive plan is blocked: ${params.plan.blockers.map((entry) => entry.code).join(", ")}`,
    );
  }
  const allSources = [
    params.plan.sources.state,
    ...params.plan.sources.config,
    ...params.plan.sources.workspaces,
  ];
  const prospectiveParent = await canonicalizeProspectivePath(params.stagingParent);
  assertStagingOutsideSources(prospectiveParent, allSources);
  await fs.mkdir(params.stagingParent, { recursive: true, mode: 0o700 });
  const canonicalParent = await fs.realpath(params.stagingParent);
  const stagingDir = await fs.mkdtemp(path.join(canonicalParent, "openclaw-continuity-stage-"));
  await fs.chmod(stagingDir, 0o700);
  try {
    assertStagingOutsideSources(stagingDir, allSources);
    await Promise.all(allSources.map(assertSourceStillCanonical));

    const snapshotDir = path.join(stagingDir, ".sqlite-snapshots");
    await ensurePrivateDirectory(snapshotDir);
    const sqlitePlan = await createStateSqliteBackupPlan({
      stateDir: params.plan.sources.state.sourcePath,
      tempDir: snapshotDir,
      excludePaths: params.plan.sources.state.excludePaths,
      rejectHardlinks: true,
    });
    const skippedSqliteSourcePaths = new Set<string>();
    let removedAuthProfileStoreRows = 0;
    let removedAuthProfileStateRows = 0;
    for (const snapshot of sqlitePlan.snapshots) {
      for (const skippedSourcePath of snapshot.skippedSourcePaths) {
        skippedSqliteSourcePaths.add(skippedSourcePath);
      }
      const sanitation = await sanitizeContinuitySqliteSnapshot({
        sourcePath: snapshot.archiveSourcePath,
        snapshotPath: snapshot.sourcePath,
      });
      removedAuthProfileStoreRows += sanitation.removedAuthProfileStoreRows;
      removedAuthProfileStateRows += sanitation.removedAuthProfileStateRows;
    }

    const stats = {
      copiedFileCount: 0,
      omittedPluginDependencyTreeCount: 0,
      skippedVolatileCount: 0,
    };
    const context: CopyContext = {
      stateDir: params.plan.sources.state.sourcePath,
      excludePaths: params.plan.sources.state.excludePaths,
      skippedSqliteSourcePaths,
      snapshotSqlite: true,
      extensionsFilter: buildExtensionsNodeModulesFilter(params.plan.sources.state.sourcePath),
      stats,
    };
    const stateDestination = resolveStagedPath(stagingDir, params.plan.sources.state.archivePath);
    await copyTree({
      sourcePath: params.plan.sources.state.sourcePath,
      destinationPath: stateDestination,
      context,
    });
    const sanitizedSqliteArchivePaths: string[] = [];
    for (const snapshot of sqlitePlan.snapshots) {
      const relativePath = path.relative(
        params.plan.sources.state.sourcePath,
        snapshot.archiveSourcePath,
      );
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(
          `Continuity SQLite snapshot source escaped state: ${snapshot.archiveSourcePath}`,
        );
      }
      const destinationPath = path.join(stateDestination, relativePath);
      await ensurePrivateDirectory(path.dirname(destinationPath));
      await fs.rename(snapshot.sourcePath, destinationPath);
      sanitizedSqliteArchivePaths.push(
        path.posix.join(
          params.plan.sources.state.archivePath,
          relativePath.replaceAll(path.sep, "/"),
        ),
      );
      stats.copiedFileCount += 1;
    }
    const stateFileArchivePaths = await listStagedFileArchivePaths({
      directoryPath: stateDestination,
      archivePath: params.plan.sources.state.archivePath,
    });
    await fs.rm(snapshotDir, { recursive: true, force: true });

    for (const configSource of params.plan.sources.config) {
      if (!configSource.expectedSha256) {
        throw new Error(
          `Continuity config source lacks classified identity: ${configSource.sourcePath}`,
        );
      }
      await copyRegularFile({
        sourcePath: configSource.sourcePath,
        destinationPath: resolveStagedPath(stagingDir, configSource.archivePath),
        expectedSha256: configSource.expectedSha256,
      });
      stats.copiedFileCount += 1;
    }
    for (const workspaceSource of params.plan.sources.workspaces) {
      await copyTree({
        sourcePath: workspaceSource.sourcePath,
        destinationPath: resolveStagedPath(stagingDir, workspaceSource.archivePath),
        context: {
          ...context,
          excludePaths: workspaceSource.excludePaths,
          skippedSqliteSourcePaths: undefined,
          snapshotSqlite: false,
        },
      });
    }

    return {
      stagingDir,
      artifactRoot: resolveStagedPath(stagingDir, params.plan.archiveRoot),
      stateFileArchivePaths,
      sanitizedSqliteArchivePaths: sanitizedSqliteArchivePaths.toSorted(),
      evidence: {
        configClassificationComplete: true,
        includeClosureComplete: true,
        sqliteSanitationComplete: true,
        config: params.plan.evidence.config,
        configFileCount: params.plan.evidence.configFileCount,
        workspaceCount: params.plan.evidence.workspaceCount,
        oauthExcluded: true,
        legacyDeliveryQueueCount: 0,
        legacyTranscriptCount: 0,
        sqliteSnapshotCount: sqlitePlan.snapshots.length,
        removedAuthProfileStoreRows,
        removedAuthProfileStateRows,
        credentialStoreRows: 0,
        authProfileStateRows: 0,
        omittedPluginDependencyTreeCount: stats.omittedPluginDependencyTreeCount,
        copiedFileCount: stats.copiedFileCount,
        skippedVolatileCount: stats.skippedVolatileCount,
      },
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
