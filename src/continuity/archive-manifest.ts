import { isRecord } from "../utils.js";
import type { ContinuityConfigDependencyEvidence } from "./config-dependencies.js";

export type ContinuityArchiveCaptureEvidence = {
  configClassificationComplete: true;
  includeClosureComplete: true;
  sqliteSanitationComplete: true;
  config: ContinuityConfigDependencyEvidence;
  configFileCount: number;
  workspaceCount: number;
  oauthExcluded: true;
  legacyTranscriptCount: 0;
  legacyDeliveryQueueCount: 0;
  sqliteSnapshotCount: number;
  removedAuthProfileStoreRows: number;
  removedAuthProfileStateRows: number;
  credentialStoreRows: 0;
  authProfileStateRows: 0;
  omittedPluginDependencyTreeCount: number;
  copiedFileCount: number;
  skippedVolatileCount: number;
};

export type ContinuityArchiveCapture = {
  targetLevel: "archived";
  eligible: true;
  evidence: ContinuityArchiveCaptureEvidence;
};

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Continuity capture evidence ${key} must be a non-negative safe integer.`);
  }
  return value;
}

function readZero(record: Record<string, unknown>, key: string): 0 {
  if (readNonNegativeInteger(record, key) !== 0) {
    throw new Error(`Continuity capture evidence ${key} must be zero.`);
  }
  return 0;
}

function readTrue(record: Record<string, unknown>, key: string): true {
  if (record[key] !== true) {
    throw new Error(`Continuity capture evidence ${key} must be true.`);
  }
  return true;
}

function parseConfigEvidence(value: unknown): ContinuityConfigDependencyEvidence {
  if (!isRecord(value) || !isRecord(value.secretReferencesBySource)) {
    throw new Error("Continuity capture config evidence must be an object.");
  }
  const secretReferencesBySource = {
    env: readNonNegativeInteger(value.secretReferencesBySource, "env"),
    file: readNonNegativeInteger(value.secretReferencesBySource, "file"),
    exec: readNonNegativeInteger(value.secretReferencesBySource, "exec"),
  };
  const secretReferenceCount = readNonNegativeInteger(value, "secretReferenceCount");
  if (
    secretReferenceCount !==
    secretReferencesBySource.env + secretReferencesBySource.file + secretReferencesBySource.exec
  ) {
    throw new Error("Continuity capture secret-reference counts are inconsistent.");
  }
  return {
    includeFileCount: readNonNegativeInteger(value, "includeFileCount"),
    secretReferenceCount,
    secretReferencesBySource,
    literalSensitiveValueCount: readZero(value, "literalSensitiveValueCount"),
  };
}

export function buildContinuityArchiveCapture(
  evidence: ContinuityArchiveCaptureEvidence,
): ContinuityArchiveCapture {
  return {
    targetLevel: "archived",
    eligible: true,
    evidence,
  };
}

export function parseContinuityArchiveCapture(value: unknown): ContinuityArchiveCapture {
  if (!isRecord(value)) {
    throw new Error("Continuity manifest capture metadata must be an object.");
  }
  if (value.targetLevel !== "archived" || value.eligible !== true || !isRecord(value.evidence)) {
    throw new Error("Continuity manifest capture metadata has unsupported eligibility.");
  }
  const evidence = value.evidence;
  const config = parseConfigEvidence(evidence.config);
  const configFileCount = readNonNegativeInteger(evidence, "configFileCount");
  if (configFileCount !== config.includeFileCount + 1) {
    throw new Error("Continuity capture config file and include counts are inconsistent.");
  }
  return {
    targetLevel: "archived",
    eligible: true,
    evidence: {
      configClassificationComplete: readTrue(evidence, "configClassificationComplete"),
      includeClosureComplete: readTrue(evidence, "includeClosureComplete"),
      sqliteSanitationComplete: readTrue(evidence, "sqliteSanitationComplete"),
      config,
      configFileCount,
      workspaceCount: readNonNegativeInteger(evidence, "workspaceCount"),
      oauthExcluded: readTrue(evidence, "oauthExcluded"),
      legacyTranscriptCount: readZero(evidence, "legacyTranscriptCount"),
      legacyDeliveryQueueCount: readZero(evidence, "legacyDeliveryQueueCount"),
      sqliteSnapshotCount: readNonNegativeInteger(evidence, "sqliteSnapshotCount"),
      removedAuthProfileStoreRows: readNonNegativeInteger(evidence, "removedAuthProfileStoreRows"),
      removedAuthProfileStateRows: readNonNegativeInteger(evidence, "removedAuthProfileStateRows"),
      credentialStoreRows: readZero(evidence, "credentialStoreRows"),
      authProfileStateRows: readZero(evidence, "authProfileStateRows"),
      omittedPluginDependencyTreeCount: readNonNegativeInteger(
        evidence,
        "omittedPluginDependencyTreeCount",
      ),
      copiedFileCount: readNonNegativeInteger(evidence, "copiedFileCount"),
      skippedVolatileCount: readNonNegativeInteger(evidence, "skippedVolatileCount"),
    },
  };
}
