import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "../config/channel-config-metadata.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
import { resolveIncludeRoots } from "../config/paths.js";
import { buildConfigSchema } from "../config/schema.js";
import { createContinuityArchive } from "../continuity/archive-create.js";
import {
  parseContinuityArchiveCapture,
  type ContinuityArchiveCapture,
} from "../continuity/archive-manifest.js";
import {
  parseContinuityArchiveObligations,
  type ContinuityArchiveObligations,
} from "../continuity/archive-obligations.js";
import {
  type ContinuityArchivePlan,
  resolveContinuityArchivePlanFromPaths,
} from "../continuity/archive-plan.js";
import {
  CONTINUITY_WAKE_DESCRIPTOR_VERSION,
  type ContinuityWakeDescriptor,
  resolveContinuityWakeDescriptor,
  resolveContinuityWakeDescriptorFromStore,
} from "../continuity/wake-descriptor.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { ensureDurableDirectoryTree, syncDirectoryEntry } from "../infra/fs-durability.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord } from "../utils.js";
import { sleep } from "../utils/sleep.js";
import { resolveBackupPlanFromConfigSnapshot } from "./backup-shared.js";

const REQUEST_VERSION = "continuity-final-capture/v1";
const RESULT_VERSION = "continuity-final-capture-result/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 4096;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CONCURRENT_RESULT_WAIT_ATTEMPTS = 100;
const CONCURRENT_RESULT_WAIT_MS = 50;

export type ManagedFinalCaptureRequest = {
  version: typeof REQUEST_VERSION;
  authority: {
    ownerId: string;
    ownerGeneration: string;
    holdRevision: number;
    handoffIdentity: string;
    captureIdentity: string;
    executionIncarnationIdentity: string;
  };
  capture: {
    capturedAtMs: number;
    outputPath: string;
    stagingParent: string;
  };
  journalRoot: string;
};

export type ManagedFinalCaptureSuccess = {
  version: typeof RESULT_VERSION;
  ok: true;
  ownerId: string;
  ownerGeneration: string;
  holdRevision: number;
  handoffIdentity: string;
  captureIdentity: string;
  executionIncarnationIdentity: string;
  capturedAtMs: number;
  planIdentity: string;
  archivePath: string;
  archiveSha256: string;
  archiveSize: number;
  manifestSha256: string;
  entryCount: number;
  configFileCount: number;
  workspaceCount: number;
  oauthExcluded: true;
  stagingCleaned: true;
  continuityCapture: ContinuityArchiveCapture;
  continuityObligations: ContinuityArchiveObligations;
  continuityWake: ContinuityWakeDescriptor;
};

export type ManagedFinalCaptureFailureCode =
  | "continuity.capture.request_invalid"
  | "continuity.capture.plan_failed"
  | "continuity.capture.plan_blocked"
  | "continuity.capture.journal_conflict"
  | "continuity.capture.archive_failed";

export type ManagedFinalCaptureFailure = {
  version: typeof RESULT_VERSION;
  ok: false;
  captureIdentity: string;
  executionIncarnationIdentity: string;
  phase: "request" | "plan" | "journal" | "capture";
  code: ManagedFinalCaptureFailureCode;
  disposition: "hold" | "retry-same-capture" | "quarantine";
  blockers?: string[];
};

export type ManagedFinalCaptureResult = ManagedFinalCaptureSuccess | ManagedFinalCaptureFailure;

export type ManagedFinalCaptureHooks = {
  resolvePlan?: (request: ManagedFinalCaptureRequest) => Promise<ContinuityArchivePlan>;
  resolveWakeDescriptor?: (
    request: ManagedFinalCaptureRequest,
  ) => Promise<ContinuityWakeDescriptor>;
  afterArchiveCreated?: () => Promise<void>;
};

class ManagedFinalCaptureError extends Error {
  constructor(
    public readonly phase: ManagedFinalCaptureFailure["phase"],
    public readonly code: ManagedFinalCaptureFailureCode,
    public readonly disposition: ManagedFinalCaptureFailure["disposition"],
    message: string,
    public readonly blockers?: string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedFinalCaptureError";
  }
}

function assertExactFields(
  value: Record<string, unknown>,
  label: string,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} fields are invalid: unknown=[${unknown.join(",")}], missing=[${missing.join(",")}].`,
    );
  }
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${label}.${key} must be an object.`);
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  pattern?: RegExp,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error(`${label}.${key} is invalid.`);
  }
  return value;
}

function readAbsolutePath(record: Record<string, unknown>, key: string, label: string): string {
  const value = readString(record, key, label);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label}.${key} must be a normalized absolute path.`);
  }
  return path.resolve(value);
}

export function parseManagedFinalCaptureRequest(raw: string): ManagedFinalCaptureRequest {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    throw new Error("Continuity final capture request is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Continuity final capture request is not valid JSON.", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("Continuity final capture request must be an object.");
  }
  assertExactFields(parsed, "Request", ["version", "authority", "capture", "journalRoot"]);
  if (parsed.version !== REQUEST_VERSION) {
    throw new Error("Continuity final capture request version is unsupported.");
  }
  const authority = readRecord(parsed, "authority", "Request");
  assertExactFields(authority, "Authority", [
    "ownerId",
    "ownerGeneration",
    "holdRevision",
    "handoffIdentity",
    "captureIdentity",
    "executionIncarnationIdentity",
  ]);
  const holdRevision = authority.holdRevision;
  if (!Number.isSafeInteger(holdRevision) || Number(holdRevision) < 0) {
    throw new Error("Authority.holdRevision must be a non-negative safe integer.");
  }
  const capture = readRecord(parsed, "capture", "Request");
  assertExactFields(capture, "Capture", ["capturedAtMs", "outputPath", "stagingParent"]);
  const capturedAtMs = capture.capturedAtMs;
  if (!Number.isSafeInteger(capturedAtMs) || Number(capturedAtMs) < 0) {
    throw new Error("Capture.capturedAtMs must be a non-negative safe integer.");
  }
  return {
    version: REQUEST_VERSION,
    authority: {
      ownerId: readString(authority, "ownerId", "Authority", PREFIXED_SHA256_PATTERN),
      ownerGeneration: readString(authority, "ownerGeneration", "Authority"),
      holdRevision: Number(holdRevision),
      handoffIdentity: readString(authority, "handoffIdentity", "Authority"),
      captureIdentity: readString(authority, "captureIdentity", "Authority"),
      executionIncarnationIdentity: readString(
        authority,
        "executionIncarnationIdentity",
        "Authority",
        PREFIXED_SHA256_PATTERN,
      ),
    },
    capture: {
      capturedAtMs: Number(capturedAtMs),
      outputPath: readAbsolutePath(capture, "outputPath", "Capture"),
      stagingParent: readAbsolutePath(capture, "stagingParent", "Capture"),
    },
    journalRoot: readAbsolutePath(parsed, "journalRoot", "Request"),
  };
}

async function resolveManagedFinalCaptureInputs(
  request: ManagedFinalCaptureRequest,
  journaledWake?: ContinuityWakeDescriptor,
): Promise<[ContinuityArchivePlan, ContinuityWakeDescriptor]> {
  const configRead = await readConfigFileSnapshotWithPluginMetadata({
    observe: false,
    isolateEnv: true,
  });
  const backupPlan = await resolveBackupPlanFromConfigSnapshot(configRead.snapshot, {
    nowMs: request.capture.capturedAtMs,
  });
  const metadata = configRead.pluginMetadataSnapshot;
  const configSchema = buildConfigSchema({
    cache: false,
    plugins: metadata ? collectPluginSchemaMetadata(metadata.manifestRegistry) : [],
    channels: metadata ? collectChannelSchemaMetadata(metadata.manifestRegistry) : [],
  });
  const plan = await resolveContinuityArchivePlanFromPaths({
    stateDir: backupPlan.stateDir,
    configPath: backupPlan.configPath,
    configRaw: configRead.snapshot.raw ?? "",
    oauthDir: backupPlan.oauthDir,
    workspaceDirs: backupPlan.workspaceDirs,
    uiHints: configSchema.uiHints,
    extensionMetadataComplete: Boolean(
      metadata && !metadata.diagnostics.some((entry) => entry.level === "error"),
    ),
    allowedConfigRoots: [
      backupPlan.stateDir,
      path.dirname(backupPlan.configPath),
      ...backupPlan.workspaceDirs,
      ...resolveIncludeRoots(),
    ],
    nowMs: request.capture.capturedAtMs,
  });
  const wake =
    journaledWake ??
    (await resolveContinuityWakeDescriptorFromStore(
      configRead.snapshot.config.cron?.store,
      process.env.OPENCLAW_SKIP_CRON !== "1" && configRead.snapshot.config.cron?.enabled !== false,
      request.capture.capturedAtMs,
    ));
  return [plan, wake];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

async function resolveJournalRootOutsideSources(
  plan: ContinuityArchivePlan,
  request: ManagedFinalCaptureRequest,
): Promise<string> {
  const sources = [
    plan.sources.state.sourcePath,
    ...plan.sources.config.map((source) => source.sourcePath),
    ...plan.sources.workspaces.map((source) => source.sourcePath),
  ];
  const resolvedJournal = await canonicalizeProspectivePath(request.journalRoot);
  const resolvedOutput = await canonicalizeProspectivePath(request.capture.outputPath);
  if (
    sources.some(
      (source) =>
        isPathWithin(path.resolve(source), resolvedJournal) ||
        isPathWithin(resolvedJournal, path.resolve(source)),
    )
  ) {
    throw new ManagedFinalCaptureError(
      "journal",
      "continuity.capture.journal_conflict",
      "quarantine",
      "Continuity capture journal overlaps a captured source.",
    );
  }
  if (
    isPathWithin(resolvedJournal, resolvedOutput) ||
    isPathWithin(resolvedOutput, resolvedJournal)
  ) {
    throw new ManagedFinalCaptureError(
      "journal",
      "continuity.capture.journal_conflict",
      "quarantine",
      "Continuity capture output overlaps journal evidence.",
    );
  }
  return resolvedJournal;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(tempPath, filePath);
    await syncDirectoryEntry(directory);
  } finally {
    await fs.rm(tempPath, { force: true });
    await syncDirectoryEntry(directory);
  }
}

async function writeOrRequirePrivateJson(filePath: string, value: unknown): Promise<void> {
  try {
    await writePrivateJson(filePath, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await readJournalJsonIfPresent(filePath);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(value)) {
      throw new ManagedFinalCaptureError(
        "journal",
        "continuity.capture.journal_conflict",
        "quarantine",
        "Continuity capture journal record conflicts with a concurrent writer.",
        undefined,
        { cause: error },
      );
    }
  }
}

async function readJournalJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ManagedFinalCaptureError(
      "journal",
      "continuity.capture.journal_conflict",
      "quarantine",
      "Continuity capture journal evidence is malformed or unreadable.",
      undefined,
      { cause: error },
    );
  }
}

async function runJournalPhase<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ManagedFinalCaptureError) {
      throw error;
    }
    throw new ManagedFinalCaptureError(
      "journal",
      "continuity.capture.journal_conflict",
      "quarantine",
      "Continuity capture journal operation failed.",
      undefined,
      { cause: error },
    );
  }
}

function parseCommittedResult(value: unknown): ManagedFinalCaptureSuccess {
  if (!isRecord(value) || value.version !== RESULT_VERSION || value.ok !== true) {
    throw new Error("Continuity capture committed result is invalid.");
  }
  assertExactFields(value, "Committed result", [
    "version",
    "ok",
    "ownerId",
    "ownerGeneration",
    "holdRevision",
    "handoffIdentity",
    "captureIdentity",
    "executionIncarnationIdentity",
    "capturedAtMs",
    "planIdentity",
    "archivePath",
    "archiveSha256",
    "archiveSize",
    "manifestSha256",
    "entryCount",
    "configFileCount",
    "workspaceCount",
    "oauthExcluded",
    "stagingCleaned",
    "continuityCapture",
    "continuityObligations",
    "continuityWake",
  ]);
  const holdRevision = value.holdRevision;
  const capturedAtMs = value.capturedAtMs;
  const archiveSize = value.archiveSize;
  const entryCount = value.entryCount;
  const configFileCount = value.configFileCount;
  const workspaceCount = value.workspaceCount;
  if (
    !Number.isSafeInteger(holdRevision) ||
    !Number.isSafeInteger(capturedAtMs) ||
    !Number.isSafeInteger(archiveSize) ||
    !Number.isSafeInteger(entryCount) ||
    !Number.isSafeInteger(configFileCount) ||
    !Number.isSafeInteger(workspaceCount) ||
    value.oauthExcluded !== true ||
    value.stagingCleaned !== true
  ) {
    throw new Error("Continuity capture committed result contains invalid evidence.");
  }
  return {
    version: RESULT_VERSION,
    ok: true,
    ownerId: readString(value, "ownerId", "Committed result", PREFIXED_SHA256_PATTERN),
    ownerGeneration: readString(value, "ownerGeneration", "Committed result"),
    holdRevision: Number(holdRevision),
    handoffIdentity: readString(value, "handoffIdentity", "Committed result"),
    captureIdentity: readString(value, "captureIdentity", "Committed result"),
    executionIncarnationIdentity: readString(
      value,
      "executionIncarnationIdentity",
      "Committed result",
      PREFIXED_SHA256_PATTERN,
    ),
    capturedAtMs: Number(capturedAtMs),
    planIdentity: readString(value, "planIdentity", "Committed result", /^[a-f0-9]{64}$/u),
    archivePath: readAbsolutePath(value, "archivePath", "Committed result"),
    archiveSha256: readString(value, "archiveSha256", "Committed result", /^[a-f0-9]{64}$/u),
    archiveSize: Number(archiveSize),
    manifestSha256: readString(value, "manifestSha256", "Committed result", /^[a-f0-9]{64}$/u),
    entryCount: Number(entryCount),
    configFileCount: Number(configFileCount),
    workspaceCount: Number(workspaceCount),
    oauthExcluded: true,
    stagingCleaned: true,
    continuityCapture: parseContinuityArchiveCapture(value.continuityCapture),
    continuityObligations: parseContinuityArchiveObligations(value.continuityObligations),
    continuityWake: parseContinuityWakeDescriptor(value.continuityWake),
  };
}

function parseContinuityWakeDescriptor(value: unknown): ContinuityWakeDescriptor {
  if (!isRecord(value)) {
    throw new Error("Continuity wake descriptor must be an object.");
  }
  assertExactFields(value, "Continuity wake descriptor", [
    "version",
    "schedulerGeneration",
    "nextRequiredAt",
    "reasonClass",
  ]);
  const nextRequiredAt = value.nextRequiredAt;
  const reasonClass = value.reasonClass;
  if (
    value.version !== CONTINUITY_WAKE_DESCRIPTOR_VERSION ||
    typeof value.schedulerGeneration !== "string" ||
    !PREFIXED_SHA256_PATTERN.test(value.schedulerGeneration)
  ) {
    throw new Error("Continuity wake descriptor is invalid.");
  }
  if (nextRequiredAt === null) {
    if (reasonClass !== "none") {
      throw new Error("Continuity wake descriptor is invalid.");
    }
    return {
      version: CONTINUITY_WAKE_DESCRIPTOR_VERSION,
      schedulerGeneration: value.schedulerGeneration,
      nextRequiredAt: null,
      reasonClass: "none",
    };
  }
  if (typeof nextRequiredAt !== "string") {
    throw new Error("Continuity wake descriptor is invalid.");
  }
  const nextRequiredAtMs = Date.parse(nextRequiredAt);
  if (
    reasonClass !== "cron" ||
    !Number.isFinite(nextRequiredAtMs) ||
    new Date(nextRequiredAtMs).toISOString() !== nextRequiredAt
  ) {
    throw new Error("Continuity wake descriptor is invalid.");
  }
  return {
    version: CONTINUITY_WAKE_DESCRIPTOR_VERSION,
    schedulerGeneration: value.schedulerGeneration,
    nextRequiredAt,
    reasonClass: "cron",
  };
}

async function verifyCommittedReplay(
  request: ManagedFinalCaptureRequest,
  result: ManagedFinalCaptureSuccess,
): Promise<ManagedFinalCaptureSuccess> {
  if (
    result.ownerId !== request.authority.ownerId ||
    result.ownerGeneration !== request.authority.ownerGeneration ||
    result.holdRevision !== request.authority.holdRevision ||
    result.handoffIdentity !== request.authority.handoffIdentity ||
    result.captureIdentity !== request.authority.captureIdentity ||
    result.executionIncarnationIdentity !== request.authority.executionIncarnationIdentity ||
    result.capturedAtMs !== request.capture.capturedAtMs ||
    result.archivePath !== request.capture.outputPath ||
    (await sha256File(result.archivePath)) !== result.archiveSha256
  ) {
    throw new ManagedFinalCaptureError(
      "journal",
      "continuity.capture.journal_conflict",
      "quarantine",
      "Continuity capture committed result no longer matches the request or artifact.",
    );
  }
  return result;
}

async function tryReplayCommittedCapture(
  request: ManagedFinalCaptureRequest,
): Promise<ManagedFinalCaptureSuccess | undefined> {
  return await runJournalPhase(async () => {
    const journalRoot = await canonicalizeProspectivePath(request.journalRoot);
    const outputPath = await canonicalizeProspectivePath(request.capture.outputPath);
    if (isPathWithin(journalRoot, outputPath) || isPathWithin(outputPath, journalRoot)) {
      throw new ManagedFinalCaptureError(
        "journal",
        "continuity.capture.journal_conflict",
        "quarantine",
        "Continuity capture output overlaps journal evidence.",
      );
    }
    try {
      await fs.lstat(journalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    await ensureDurableDirectoryTree(journalRoot, { requirePrivateExisting: true });
    const journalDir = path.join(journalRoot, sha256Hex(request.authority.captureIdentity));
    try {
      await fs.lstat(journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    await ensureDurableDirectoryTree(journalDir, { requirePrivateExisting: true });
    const intent = await readJournalJsonIfPresent(path.join(journalDir, "intent.json"));
    const committed = await readJournalJsonIfPresent(path.join(journalDir, "result.json"));
    if (committed === undefined) {
      return undefined;
    }
    if (
      !isRecord(intent) ||
      !Object.hasOwn(intent, "request") ||
      !Object.hasOwn(intent, "planIdentity") ||
      !Object.hasOwn(intent, "continuityWake") ||
      Object.keys(intent).length !== 3 ||
      canonicalJson(intent.request) !== canonicalJson(request) ||
      typeof intent.planIdentity !== "string" ||
      !/^[a-f0-9]{64}$/u.test(intent.planIdentity)
    ) {
      throw new ManagedFinalCaptureError(
        "journal",
        "continuity.capture.journal_conflict",
        "quarantine",
        "Continuity capture committed result has invalid intent evidence.",
      );
    }
    const intentWake = parseContinuityWakeDescriptor(intent.continuityWake);
    const result = parseCommittedResult(committed);
    if (
      result.planIdentity !== intent.planIdentity ||
      canonicalJson(result.continuityWake) !== canonicalJson(intentWake)
    ) {
      throw new ManagedFinalCaptureError(
        "journal",
        "continuity.capture.journal_conflict",
        "quarantine",
        "Continuity capture committed result disagrees with its intent.",
      );
    }
    return await verifyCommittedReplay(request, result);
  });
}

async function tryReadJournaledWakeDescriptor(
  request: ManagedFinalCaptureRequest,
): Promise<ContinuityWakeDescriptor | undefined> {
  return runJournalPhase(async () => {
    const journalRoot = path.resolve(request.journalRoot);
    try {
      await fs.lstat(journalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    await ensureDurableDirectoryTree(journalRoot, { requirePrivateExisting: true });
    const journalDir = path.join(journalRoot, sha256Hex(request.authority.captureIdentity));
    try {
      await fs.lstat(journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    await ensureDurableDirectoryTree(journalDir, { requirePrivateExisting: true });
    const intent = await readJournalJsonIfPresent(path.join(journalDir, "intent.json"));
    if (intent === undefined) {
      return undefined;
    }
    if (
      !isRecord(intent) ||
      !Object.hasOwn(intent, "request") ||
      !Object.hasOwn(intent, "planIdentity") ||
      !Object.hasOwn(intent, "continuityWake") ||
      Object.keys(intent).length !== 3 ||
      canonicalJson(intent.request) !== canonicalJson(request) ||
      typeof intent.planIdentity !== "string" ||
      !/^[a-f0-9]{64}$/u.test(intent.planIdentity)
    ) {
      throw new ManagedFinalCaptureError(
        "journal",
        "continuity.capture.journal_conflict",
        "quarantine",
        "Continuity capture journal has invalid intent evidence.",
      );
    }
    return parseContinuityWakeDescriptor(intent.continuityWake);
  });
}

async function captureOutputExists(outputPath: string): Promise<boolean> {
  try {
    await fs.access(outputPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new ManagedFinalCaptureError(
      "capture",
      "continuity.capture.archive_failed",
      "retry-same-capture",
      "Continuity capture output preflight failed.",
      undefined,
      { cause: error },
    );
  }
}

async function reconcileConcurrentPublication(
  request: ManagedFinalCaptureRequest,
  resultPath: string,
  cause?: unknown,
): Promise<ManagedFinalCaptureSuccess> {
  for (let attempt = 0; attempt < CONCURRENT_RESULT_WAIT_ATTEMPTS; attempt += 1) {
    const committed = await runJournalPhase(async () => await readJournalJsonIfPresent(resultPath));
    if (committed !== undefined) {
      return await runJournalPhase(
        async () => await verifyCommittedReplay(request, parseCommittedResult(committed)),
      );
    }
    await sleep(CONCURRENT_RESULT_WAIT_MS);
  }
  throw new ManagedFinalCaptureError(
    "journal",
    "continuity.capture.journal_conflict",
    "quarantine",
    "Continuity capture output exists without a durable committed result.",
    undefined,
    { cause },
  );
}

export async function executeManagedFinalCapture(
  request: ManagedFinalCaptureRequest,
  hooks: ManagedFinalCaptureHooks = {},
): Promise<ManagedFinalCaptureSuccess> {
  const committedReplay = await tryReplayCommittedCapture(request);
  if (committedReplay) {
    return committedReplay;
  }
  const journaledWake = await tryReadJournaledWakeDescriptor(request);
  let plan: ContinuityArchivePlan;
  let continuityWake: ContinuityWakeDescriptor;
  try {
    if (!hooks.resolvePlan && !hooks.resolveWakeDescriptor) {
      [plan, continuityWake] = await resolveManagedFinalCaptureInputs(request, journaledWake);
    } else {
      [plan, continuityWake] = await Promise.all([
        hooks.resolvePlan
          ? hooks.resolvePlan(request)
          : resolveManagedFinalCaptureInputs(request, journaledWake).then(
              ([resolvedPlan]) => resolvedPlan,
            ),
        journaledWake
          ? Promise.resolve(journaledWake)
          : hooks.resolveWakeDescriptor
            ? hooks.resolveWakeDescriptor(request)
            : resolveContinuityWakeDescriptor(),
      ]);
    }
  } catch (error) {
    throw new ManagedFinalCaptureError(
      "plan",
      "continuity.capture.plan_failed",
      "retry-same-capture",
      "Continuity final capture plan resolution failed.",
      undefined,
      { cause: error },
    );
  }
  const planIdentity = sha256Hex(canonicalJson(plan));
  if (!plan.eligible) {
    throw new ManagedFinalCaptureError(
      "plan",
      "continuity.capture.plan_blocked",
      "hold",
      "Continuity final capture plan is blocked.",
      plan.blockers.map((blocker) => blocker.code),
    );
  }
  const journal = await runJournalPhase(async () => {
    const journalRoot = await resolveJournalRootOutsideSources(plan, request);
    await ensureDurableDirectoryTree(journalRoot, { requirePrivateExisting: true });
    const journalDir = path.join(journalRoot, sha256Hex(request.authority.captureIdentity));
    await ensureDurableDirectoryTree(journalDir, { requirePrivateExisting: true });
    const intentPath = path.join(journalDir, "intent.json");
    const resultPath = path.join(journalDir, "result.json");
    const intent = { request, planIdentity, continuityWake };
    const existingIntent = await readJournalJsonIfPresent(intentPath);
    if (existingIntent === undefined) {
      await writeOrRequirePrivateJson(intentPath, intent);
    } else {
      if (
        !isRecord(existingIntent) ||
        !Object.hasOwn(existingIntent, "request") ||
        !Object.hasOwn(existingIntent, "planIdentity") ||
        !Object.hasOwn(existingIntent, "continuityWake") ||
        Object.keys(existingIntent).length !== 3 ||
        canonicalJson(existingIntent.request) !== canonicalJson(request) ||
        existingIntent.planIdentity !== planIdentity
      ) {
        throw new ManagedFinalCaptureError(
          "journal",
          "continuity.capture.journal_conflict",
          "quarantine",
          "Continuity capture identity is already bound to a different request or plan.",
        );
      }
      continuityWake = parseContinuityWakeDescriptor(existingIntent.continuityWake);
    }
    return {
      resultPath,
      committed: await readJournalJsonIfPresent(resultPath),
    };
  });
  const committed = journal.committed;
  if (committed !== undefined) {
    try {
      return await verifyCommittedReplay(request, parseCommittedResult(committed));
    } catch (error) {
      if (error instanceof ManagedFinalCaptureError) {
        throw error;
      }
      throw new ManagedFinalCaptureError(
        "journal",
        "continuity.capture.journal_conflict",
        "quarantine",
        "Continuity capture committed result is invalid.",
        undefined,
        { cause: error },
      );
    }
  }
  if (await captureOutputExists(request.capture.outputPath)) {
    return await reconcileConcurrentPublication(request, journal.resultPath);
  }
  let created;
  let archiveSize: number;
  try {
    created = await createContinuityArchive({
      plan,
      stagingParent: request.capture.stagingParent,
      outputPath: request.capture.outputPath,
      nowMs: request.capture.capturedAtMs,
    });
    archiveSize = (await fs.stat(created.archivePath)).size;
    await hooks.afterArchiveCreated?.();
  } catch (error) {
    if (await captureOutputExists(request.capture.outputPath)) {
      return await reconcileConcurrentPublication(request, journal.resultPath, error);
    }
    throw new ManagedFinalCaptureError(
      "capture",
      "continuity.capture.archive_failed",
      "retry-same-capture",
      "Continuity final capture failed.",
      undefined,
      { cause: error },
    );
  }
  const result: ManagedFinalCaptureSuccess = {
    version: RESULT_VERSION,
    ok: true,
    ownerId: request.authority.ownerId,
    ownerGeneration: request.authority.ownerGeneration,
    holdRevision: request.authority.holdRevision,
    handoffIdentity: request.authority.handoffIdentity,
    captureIdentity: request.authority.captureIdentity,
    executionIncarnationIdentity: request.authority.executionIncarnationIdentity,
    capturedAtMs: request.capture.capturedAtMs,
    planIdentity,
    archivePath: created.archivePath,
    archiveSha256: created.archiveSha256,
    archiveSize,
    manifestSha256: created.manifestSha256,
    entryCount: created.entryCount,
    configFileCount: plan.evidence.configFileCount,
    workspaceCount: plan.evidence.workspaceCount,
    oauthExcluded: true,
    stagingCleaned: true,
    continuityCapture: created.continuityCapture,
    continuityObligations: created.continuityObligations,
    continuityWake,
  };
  try {
    await runJournalPhase(async () => await writeOrRequirePrivateJson(journal.resultPath, result));
  } catch (error) {
    throw new ManagedFinalCaptureError(
      "journal",
      "continuity.capture.journal_conflict",
      "quarantine",
      "Continuity capture artifact was created but its committed result was not durable.",
      undefined,
      { cause: error },
    );
  }
  return result;
}

function failureResult(
  request: Pick<ManagedFinalCaptureRequest, "authority"> | undefined,
  error: ManagedFinalCaptureError,
): ManagedFinalCaptureFailure {
  return {
    version: RESULT_VERSION,
    ok: false,
    captureIdentity: request?.authority.captureIdentity ?? "unavailable",
    executionIncarnationIdentity: request?.authority.executionIncarnationIdentity ?? "unavailable",
    phase: error.phase,
    code: error.code,
    disposition: error.disposition,
    ...(error.blockers ? { blockers: error.blockers } : {}),
  };
}

export function managedFinalCaptureRequestFailure(
  runtime: RuntimeEnv,
  error: unknown,
  options: { json?: boolean } = {},
): ManagedFinalCaptureFailure {
  const result = failureResult(
    undefined,
    new ManagedFinalCaptureError(
      "request",
      "continuity.capture.request_invalid",
      "quarantine",
      "Continuity final capture request is invalid.",
      undefined,
      { cause: error },
    ),
  );
  if (options.json !== false) {
    writeRuntimeJson(runtime, result);
  }
  runtime.exit(1);
  return result;
}

export async function backupCaptureManagedCommand(
  runtime: RuntimeEnv,
  rawRequest: string,
  options: { json?: boolean; hooks?: ManagedFinalCaptureHooks } = {},
): Promise<ManagedFinalCaptureResult> {
  let request: ManagedFinalCaptureRequest;
  try {
    request = parseManagedFinalCaptureRequest(rawRequest);
  } catch (error) {
    return managedFinalCaptureRequestFailure(runtime, error, options);
  }
  let result: ManagedFinalCaptureResult;
  try {
    result = await executeManagedFinalCapture(request, options.hooks);
  } catch (error) {
    if (!(error instanceof ManagedFinalCaptureError)) {
      throw error;
    }
    result = failureResult(request, error);
  }
  if (options.json !== false) {
    writeRuntimeJson(runtime, result);
  }
  if (!result.ok) {
    runtime.exit(1);
  }
  return result;
}

export async function readManagedFinalCaptureRequestFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Continuity final capture request is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
