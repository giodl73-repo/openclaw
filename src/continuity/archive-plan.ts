import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildBackupArchivePath, formatBackupArchiveTimestamp } from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import type { ConfigUiHints } from "../config/schema.js";
import {
  prepareContinuityConfigCapture,
  type ContinuityConfigBlockerCode,
  type ContinuityConfigDependencyEvidence,
} from "./config-dependencies.js";

export type ContinuityCaptureBlockerCode =
  | ContinuityConfigBlockerCode
  | "continuity.capture.legacy_transcripts"
  | "continuity.capture.source_missing"
  | "continuity.capture.source_overlap"
  | "continuity.capture.source_scan_failed";

export type ContinuityCaptureSource = {
  kind: "state" | "config" | "config-include" | "workspace";
  sourcePath: string;
  archivePath: string;
  excludePaths: string[];
  expectedSha256?: string;
};

export type ContinuityArchivePlan = {
  eligible: boolean;
  archiveRoot: string;
  blockers: Array<{ code: ContinuityCaptureBlockerCode; count: number }>;
  sources: {
    state: ContinuityCaptureSource;
    config: ContinuityCaptureSource[];
    workspaces: ContinuityCaptureSource[];
  };
  sqliteTreatment: "snapshot-sanitize-and-verify";
  evidence: {
    config: ContinuityConfigDependencyEvidence;
    configFileCount: number;
    workspaceCount: number;
    oauthExcluded: boolean;
    legacyTranscriptCount: number;
  };
};

type ResolveContinuityArchivePlanParams = {
  stateDir: string;
  configPath: string;
  configRaw: string;
  oauthDir: string;
  workspaceDirs: readonly string[];
  uiHints: ConfigUiHints;
  extensionMetadataComplete: boolean;
  env?: NodeJS.ProcessEnv;
  allowedConfigRoots?: readonly string[];
  nowMs?: number;
};

type RequiredSource = {
  kind: ContinuityCaptureSource["kind"];
  sourcePath: string;
};

function buildContinuityArchiveRoot(nowMs = Date.now()): string {
  return `${formatBackupArchiveTimestamp(nowMs)}-openclaw-continuity`;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function canonicalizeRequiredSource(source: RequiredSource): RequiredSource | null {
  try {
    const stat = fs.statSync(source.sourcePath);
    const expectsDirectory = source.kind === "state" || source.kind === "workspace";
    if ((expectsDirectory && !stat.isDirectory()) || (!expectsDirectory && !stat.isFile())) {
      return null;
    }
    return { ...source, sourcePath: fs.realpathSync(source.sourcePath) };
  } catch {
    return null;
  }
}

function toCaptureSource(
  archiveRoot: string,
  source: RequiredSource,
  excludePaths: string[] = [],
  expectedSha256?: string,
): ContinuityCaptureSource {
  return {
    ...source,
    archivePath: buildBackupArchivePath(archiveRoot, source.sourcePath),
    excludePaths,
    ...(expectedSha256 ? { expectedSha256 } : {}),
  };
}

function scanLegacyTranscriptTree(root: string): { count: number; failed: boolean } {
  if (!fs.existsSync(root)) {
    return { count: 0, failed: false };
  }
  let count = 0;
  const pending = [root];
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        continue;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          return { count, failed: true };
        }
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (
          entry.isFile() &&
          [".jsonl", ".log"].includes(path.extname(entry.name).toLowerCase())
        ) {
          count += 1;
        }
      }
    }
    return { count, failed: false };
  } catch {
    return { count, failed: true };
  }
}

function scanLegacyTranscripts(stateDir: string): { count: number; failed: boolean } {
  const roots = [path.join(stateDir, "sessions")];
  const agentsRoot = path.join(stateDir, "agents");
  try {
    if (fs.existsSync(agentsRoot)) {
      for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          return { count: 0, failed: true };
        }
        if (entry.isDirectory()) {
          roots.push(path.join(agentsRoot, entry.name, "sessions"));
        }
      }
    }
  } catch {
    return { count: 0, failed: true };
  }
  return roots.reduce<{ count: number; failed: boolean }>(
    (total, root) => {
      const result = scanLegacyTranscriptTree(root);
      return {
        count: total.count + result.count,
        failed: total.failed || result.failed,
      };
    },
    { count: 0, failed: false },
  );
}

function hasUnsafeOverlap(
  stateDir: string,
  oauthDir: string,
  workspaces: readonly string[],
): boolean {
  return workspaces.some(
    (workspace, index) =>
      isPathWithin(stateDir, workspace) ||
      isPathWithin(workspace, oauthDir) ||
      isPathWithin(oauthDir, workspace) ||
      workspaces.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (isPathWithin(workspace, other) || isPathWithin(other, workspace)),
      ),
  );
}

/**
 * Resolve the fail-closed source and treatment plan for a dedicated continuity
 * artifact. This does not mutate, snapshot, sanitize, or package any source.
 */
export function resolveContinuityArchivePlanFromPaths(
  params: ResolveContinuityArchivePlanParams,
): ContinuityArchivePlan {
  const archiveRoot = buildContinuityArchiveRoot(params.nowMs);
  const configPreparation = prepareContinuityConfigCapture({
    configPath: params.configPath,
    raw: params.configRaw,
    uiHints: params.uiHints,
    extensionMetadataComplete: params.extensionMetadataComplete,
    env: params.env,
    allowedRoots: params.allowedConfigRoots,
  });
  const requiredSources: RequiredSource[] = [
    { kind: "state", sourcePath: path.resolve(params.stateDir) },
    { kind: "config", sourcePath: path.resolve(params.configPath) },
    ...configPreparation.includedFiles.map((includedFile) => ({
      kind: "config-include" as const,
      sourcePath: includedFile.path,
    })),
    ...params.workspaceDirs.map((sourcePath) => ({
      kind: "workspace" as const,
      sourcePath: path.resolve(sourcePath),
    })),
  ];
  const canonicalSources = requiredSources.map(canonicalizeRequiredSource);
  const missingSourceCount = canonicalSources.filter((source) => source === null).length;
  const presentSources = canonicalSources.filter(
    (source): source is RequiredSource => source !== null,
  );
  const state = presentSources.find((source) => source.kind === "state");
  const configSources = presentSources.filter(
    (source) => source.kind === "config" || source.kind === "config-include",
  );
  const configHashes = new Map<string, string>();
  try {
    configHashes.set(fs.realpathSync(params.configPath), sha256(params.configRaw));
  } catch {
    // The missing source blocker below remains authoritative.
  }
  for (const includedFile of configPreparation.includedFiles) {
    configHashes.set(includedFile.path, includedFile.sha256);
  }
  const workspaceSources = presentSources.filter((source) => source.kind === "workspace");
  const legacy = state ? scanLegacyTranscripts(state.sourcePath) : { count: 0, failed: false };
  const oauthPath = fs.existsSync(params.oauthDir)
    ? fs.realpathSync(params.oauthDir)
    : path.resolve(params.oauthDir);
  const sourceOverlap =
    (state !== undefined &&
      hasUnsafeOverlap(
        state.sourcePath,
        oauthPath,
        workspaceSources.map((source) => source.sourcePath),
      )) ||
    configSources.some((source) => isPathWithin(source.sourcePath, oauthPath));

  const blockers: ContinuityArchivePlan["blockers"] = [
    ...configPreparation.assessment.blockers,
    ...(missingSourceCount > 0
      ? [{ code: "continuity.capture.source_missing" as const, count: missingSourceCount }]
      : []),
    ...(sourceOverlap ? [{ code: "continuity.capture.source_overlap" as const, count: 1 }] : []),
    ...(legacy.failed
      ? [{ code: "continuity.capture.source_scan_failed" as const, count: 1 }]
      : []),
    ...(legacy.count > 0
      ? [{ code: "continuity.capture.legacy_transcripts" as const, count: legacy.count }]
      : []),
  ];
  const fallbackState: RequiredSource = {
    kind: "state",
    sourcePath: path.resolve(params.stateDir),
  };
  const stateSource = state ?? fallbackState;
  const separateSourcePaths = [
    oauthPath,
    ...configSources.map((source) => source.sourcePath),
    ...workspaceSources.map((source) => source.sourcePath),
  ];
  const exclusionsFor = (sourcePath: string, candidates: readonly string[]) =>
    candidates.filter((candidate) => isPathWithin(candidate, sourcePath)).toSorted();

  return {
    eligible: blockers.length === 0,
    archiveRoot,
    blockers,
    sources: {
      state: toCaptureSource(
        archiveRoot,
        stateSource,
        exclusionsFor(stateSource.sourcePath, separateSourcePaths),
      ),
      config: configSources.map((source) =>
        toCaptureSource(archiveRoot, source, [], configHashes.get(path.resolve(source.sourcePath))),
      ),
      workspaces: workspaceSources.map((source) =>
        toCaptureSource(
          archiveRoot,
          source,
          exclusionsFor(source.sourcePath, [
            oauthPath,
            ...configSources.map((configSource) => configSource.sourcePath),
          ]),
        ),
      ),
    },
    sqliteTreatment: "snapshot-sanitize-and-verify",
    evidence: {
      config: configPreparation.assessment.evidence,
      configFileCount: configSources.length,
      workspaceCount: workspaceSources.length,
      oauthExcluded: true,
      legacyTranscriptCount: legacy.count,
    },
  };
}
