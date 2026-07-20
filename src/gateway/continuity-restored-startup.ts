import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalContinuityJson,
  completeContinuityRestore,
  openRestoredAdmission,
  parseContinuityRestoreCompleteEvidence,
  type ContinuityRestoreCompleteDependencies,
  type ContinuityRestoreCompleteEvidence,
  type ContinuityRestoreCompleteFailure,
  type ContinuityRestoreCompleteRecord,
} from "../continuity/restore-complete.js";
import { isRecord } from "../utils.js";

const RESTORED_STARTUP_DESCRIPTOR_VERSION = "continuity-restored-startup/v2";
const RESTORED_STARTUP_RESULT_VERSION = "continuity-restored-startup-result/v2";
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

export const CONTINUITY_RESTORED_STARTUP_FILE_ENV = "OPENCLAW_CONTINUITY_RESTORED_STARTUP_FILE";
export const CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX =
  "[gateway] continuity-restored-startup-result/v2 ";

export type ContinuityRestoredStartupDescriptor = {
  version: typeof RESTORED_STARTUP_DESCRIPTOR_VERSION;
  journalRoot: string;
  evidence: ContinuityRestoreCompleteEvidence;
};

export type ContinuityRestoredStartupSuccess = {
  version: typeof RESTORED_STARTUP_RESULT_VERSION;
  ok: true;
  phase: "ready";
  readinessGeneration: string;
  replayed: boolean;
  admissionOpen: true;
  record: ContinuityRestoreCompleteRecord;
};

export type ContinuityRestoredStartupFailure = {
  version: typeof RESTORED_STARTUP_RESULT_VERSION;
  ok: false;
  phase: ContinuityRestoreCompleteFailure["phase"];
  code: ContinuityRestoreCompleteFailure["code"];
  disposition: ContinuityRestoreCompleteFailure["disposition"];
};

export type ContinuityRestoredStartupResult =
  | ContinuityRestoredStartupSuccess
  | ContinuityRestoredStartupFailure;

function requireExactFields(
  value: Record<string, unknown>,
  label: string,
  fields: readonly string[],
): void {
  const expected = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !expected.has(field))) {
    throw new Error(`${label} fields are invalid.`);
  }
}

export function parseContinuityRestoredStartupDescriptor(
  value: unknown,
): ContinuityRestoredStartupDescriptor {
  if (!isRecord(value)) {
    throw new Error("Continuity restored-startup descriptor must be an object.");
  }
  requireExactFields(value, "Continuity restored-startup descriptor", [
    "version",
    "journalRoot",
    "evidence",
  ]);
  if (value.version !== RESTORED_STARTUP_DESCRIPTOR_VERSION) {
    throw new Error("Continuity restored-startup descriptor version is invalid.");
  }
  if (typeof value.journalRoot !== "string" || !path.isAbsolute(value.journalRoot)) {
    throw new Error("Continuity restored-startup journal root must be an absolute path.");
  }
  return {
    version: RESTORED_STARTUP_DESCRIPTOR_VERSION,
    journalRoot: value.journalRoot,
    evidence: parseContinuityRestoreCompleteEvidence(value.evidence),
  };
}

export async function loadContinuityRestoredStartupDescriptor(
  descriptorPath: string,
): Promise<ContinuityRestoredStartupDescriptor> {
  if (!path.isAbsolute(descriptorPath)) {
    throw new Error("Continuity restored-startup descriptor path must be absolute.");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(descriptorPath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DESCRIPTOR_BYTES) {
      throw new Error("Continuity restored-startup descriptor file is invalid.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("Continuity restored-startup descriptor file must be private.");
    }
    const raw = await handle.readFile("utf8");
    return parseContinuityRestoredStartupDescriptor(JSON.parse(raw));
  } finally {
    await handle.close();
  }
}

function emitResult(
  result: ContinuityRestoredStartupResult,
  writeLine: (line: string) => void,
): void {
  const payload = canonicalContinuityJson(result);
  if (Buffer.byteLength(payload, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Continuity restored-startup result exceeds the protocol size limit.");
  }
  writeLine(`${CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX}${payload}`);
}

export async function runContinuityRestoredStartup(
  descriptor: ContinuityRestoredStartupDescriptor,
  dependencies: ContinuityRestoreCompleteDependencies,
  writeLine: (line: string) => void,
): Promise<ContinuityRestoredStartupResult> {
  const completed = await completeContinuityRestore(
    descriptor.evidence,
    descriptor.journalRoot,
    dependencies,
  );
  if (!completed.ok || "skipped" in completed) {
    const failure: ContinuityRestoredStartupFailure = !completed.ok
      ? {
          version: RESTORED_STARTUP_RESULT_VERSION,
          ok: false,
          phase: completed.phase,
          code: completed.code,
          disposition: completed.disposition,
        }
      : {
          version: RESTORED_STARTUP_RESULT_VERSION,
          ok: false,
          phase: "restoring",
          code: "ContinuityRestoreFailed",
          disposition: "quarantine",
        };
    emitResult(failure, writeLine);
    return failure;
  }
  const admission = openRestoredAdmission(completed.record, {
    ownerId: descriptor.evidence.ownerId,
    destinationRuntimeGeneration: descriptor.evidence.destinationRuntimeGeneration,
    lifecycleOwnerGeneration: descriptor.evidence.lifecycleOwnerGeneration,
    restoreReceiptIdentity: descriptor.evidence.restore.receiptIdentity,
    admissionIdentity: descriptor.evidence.admissionIdentity,
    readinessGeneration: completed.readinessGeneration,
  });
  const success: ContinuityRestoredStartupSuccess = {
    version: RESTORED_STARTUP_RESULT_VERSION,
    ok: true,
    phase: admission.phase,
    readinessGeneration: admission.readinessGeneration,
    replayed: completed.replayed,
    admissionOpen: admission.open,
    record: admission.record,
  };
  emitResult(success, writeLine);
  return success;
}

export async function runContinuityRestoredStartupFromEnvironment(
  env: NodeJS.ProcessEnv,
  dependencies: ContinuityRestoreCompleteDependencies,
  writeLine: (line: string) => void,
): Promise<ContinuityRestoredStartupResult | null> {
  const descriptorPath = env[CONTINUITY_RESTORED_STARTUP_FILE_ENV];
  if (descriptorPath === undefined) {
    return null;
  }
  const descriptor = await loadContinuityRestoredStartupDescriptor(descriptorPath);
  return runContinuityRestoredStartup(descriptor, dependencies, writeLine);
}
