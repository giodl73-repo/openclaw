import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedRestoreSuccess } from "../commands/backup-activate-managed.js";
import { ensureDurableDirectoryTree, syncDirectoryEntry } from "../infra/fs-durability.js";
import { isRecord } from "../utils.js";
import {
  parseContinuityArchiveObligations,
  type ContinuityArchiveObligations,
} from "./archive-obligations.js";
import type { ContinuityWakeDescriptor } from "./wake-descriptor.js";

const RESTORE_COMPLETE_VERSION = "continuity-restore-complete/v2";
const RESTORE_COMPLETE_OUTCOME_VERSION = "continuity-restore-complete-result/v1";
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,255}$/u;
const MAX_RECORD_BYTES = 64 * 1024;

export type ContinuityStartupMode = "ordinary" | "restored";

export type AcceptedRecoveryPoint = {
  recoveryPointId: string;
  publicationIdentity: string;
  manifestSha256: string;
};

export type CommittedRestoreEvidence = Pick<
  ManagedRestoreSuccess,
  | "version"
  | "ok"
  | "ownerGeneration"
  | "restoreIdentity"
  | "planId"
  | "receiptIdentity"
  | "committedRecordIdentity"
>;

export type RequiredOwnerReadinessRequirement = {
  obligationId:
    | "reconstructed.pluginRuntimeDependencies"
    | "external.configSecretReferences"
    | "external.authProfileCredentials";
  owner: "plugins" | "secrets" | "auth-profiles";
};

export type OwnerReadinessFinding = RequiredOwnerReadinessRequirement & {
  ready: boolean;
  evidenceIdentity: string;
  detail?: string;
};

export type GatewayReadinessEvidence = {
  ready: boolean;
  generation: string;
  failing: string[];
};

export type ContinuityRestoreCompleteEvidence = {
  startupMode: ContinuityStartupMode;
  operationId: string;
  ownerId: string;
  destinationRuntimeGeneration: string;
  lifecycleOwnerGeneration: string;
  acceptedRecoveryPoint: AcceptedRecoveryPoint;
  preparationIdentity: string;
  admissionIdentity: string;
  expectedPlanId: string;
  continuityObligations: ContinuityArchiveObligations;
  restore: CommittedRestoreEvidence;
};

export type ContinuityRestoreCompleteRecord = {
  version: typeof RESTORE_COMPLETE_VERSION;
  ownerId: string;
  destinationRuntimeGeneration: string;
  lifecycleOwnerGeneration: string;
  recoveryPointId: string;
  manifestSha256: string;
  preparationIdentity: string;
  restoreIdentity: string;
  restoreReceiptIdentity: string;
  committedRecordIdentity: string;
  planId: string;
  schedulerGeneration: string;
  nextRequiredAt: string | null;
  reasonClass: "cron" | "none";
  requiredOwnerReadinessDigest: string;
  admissionIdentity: string;
  readinessGeneration: string;
};

export type ContinuityRestoreFailureCode =
  | "ContinuityRestoreFailed"
  | "SchedulerReconciliationFailed"
  | "ContinuityReadinessFailed"
  | "ReadinessGenerationConflict";

export type ContinuityRestoreCompleteFailure = {
  version: typeof RESTORE_COMPLETE_OUTCOME_VERSION;
  ok: false;
  phase: "restoring" | "reconciling" | "blocked";
  code: ContinuityRestoreFailureCode;
  disposition: "retry-same-incarnation" | "hold" | "quarantine";
};

export type ContinuityRestoreCompleteSuccess = {
  version: typeof RESTORE_COMPLETE_OUTCOME_VERSION;
  ok: true;
  phase: "reconciling";
  readinessGeneration: string;
  record: ContinuityRestoreCompleteRecord;
  replayed: boolean;
  admissionOpen: false;
};

export type ContinuityRestoreCompleteSkipped = {
  version: typeof RESTORE_COMPLETE_OUTCOME_VERSION;
  ok: true;
  skipped: true;
  reason: "ordinary-startup";
};

export type ContinuityRestoreCompleteOutcome =
  | ContinuityRestoreCompleteFailure
  | ContinuityRestoreCompleteSuccess
  | ContinuityRestoreCompleteSkipped;

export type ContinuityRestoreCompleteDependencies = {
  reconcileScheduler: () => Promise<void>;
  resolveWakeDescriptor: () => ContinuityWakeDescriptor | Promise<ContinuityWakeDescriptor>;
  resolveOwnerReadiness: (
    requirements: readonly RequiredOwnerReadinessRequirement[],
  ) => Promise<readonly OwnerReadinessFinding[]>;
  resolveGatewayReadiness: () => Promise<GatewayReadinessEvidence>;
  syncJournalDirectory?: (directoryPath: string) => Promise<void>;
};

export type RestoredAdmission = {
  open: true;
  phase: "ready";
  admissionIdentity: string;
  readinessGeneration: string;
  record: ContinuityRestoreCompleteRecord;
};

export type ContinuityRestoreStatus = {
  phase: "hibernated" | "restoring" | "reconciling" | "ready" | "blocked" | "degraded";
  readinessGeneration?: string;
  admissionOpen: boolean;
  code?: ContinuityRestoreFailureCode;
  disposition?: ContinuityRestoreCompleteFailure["disposition"];
};

class ContinuityRestoreCompleteError extends Error {
  constructor(
    readonly phase: ContinuityRestoreCompleteFailure["phase"],
    readonly code: ContinuityRestoreFailureCode,
    readonly disposition: ContinuityRestoreCompleteFailure["disposition"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContinuityRestoreCompleteError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalContinuityJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalContinuityJson(value)).digest("hex")}`;
}

function requireString(value: unknown, label: string, pattern = IDENTIFIER_PATTERN): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ContinuityRestoreCompleteError(
      "restoring",
      "ContinuityRestoreFailed",
      "quarantine",
      `${label} is invalid.`,
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

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

function readEvidenceString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

export function parseContinuityRestoreCompleteEvidence(
  value: unknown,
): ContinuityRestoreCompleteEvidence {
  const parsed = requireRecord(value, "Restore-complete evidence");
  requireExactFields(parsed, "Restore-complete evidence", [
    "startupMode",
    "operationId",
    "ownerId",
    "destinationRuntimeGeneration",
    "lifecycleOwnerGeneration",
    "acceptedRecoveryPoint",
    "preparationIdentity",
    "admissionIdentity",
    "expectedPlanId",
    "continuityObligations",
    "restore",
  ]);
  if (parsed.startupMode !== "restored") {
    throw new Error("Restore-complete startup mode must be restored.");
  }
  const accepted = requireRecord(parsed.acceptedRecoveryPoint, "Accepted recovery point");
  requireExactFields(accepted, "Accepted recovery point", [
    "recoveryPointId",
    "publicationIdentity",
    "manifestSha256",
  ]);
  const restore = requireRecord(parsed.restore, "Committed restore evidence");
  requireExactFields(restore, "Committed restore evidence", [
    "version",
    "ok",
    "ownerGeneration",
    "restoreIdentity",
    "planId",
    "receiptIdentity",
    "committedRecordIdentity",
  ]);
  if (restore.ok !== true) {
    throw new Error("Committed restore evidence must be successful.");
  }
  if (restore.version !== "continuity-restore-execution-result/v1") {
    throw new Error("Committed restore version is invalid.");
  }
  const evidence: ContinuityRestoreCompleteEvidence = {
    startupMode: "restored",
    operationId: readEvidenceString(parsed.operationId, "Restore-complete operation identity"),
    ownerId: readEvidenceString(parsed.ownerId, "Owner identity"),
    destinationRuntimeGeneration: readEvidenceString(
      parsed.destinationRuntimeGeneration,
      "Destination runtime generation",
    ),
    lifecycleOwnerGeneration: readEvidenceString(
      parsed.lifecycleOwnerGeneration,
      "Lifecycle owner generation",
    ),
    acceptedRecoveryPoint: {
      recoveryPointId: readEvidenceString(accepted.recoveryPointId, "Recovery-point identity"),
      publicationIdentity: readEvidenceString(accepted.publicationIdentity, "Publication identity"),
      manifestSha256: readEvidenceString(accepted.manifestSha256, "Manifest digest"),
    },
    preparationIdentity: readEvidenceString(parsed.preparationIdentity, "Preparation identity"),
    admissionIdentity: readEvidenceString(parsed.admissionIdentity, "Admission identity"),
    expectedPlanId: readEvidenceString(parsed.expectedPlanId, "Expected restore plan identity"),
    continuityObligations: parseContinuityArchiveObligations(parsed.continuityObligations),
    restore: {
      version: "continuity-restore-execution-result/v1",
      ok: true,
      ownerGeneration: readEvidenceString(
        restore.ownerGeneration,
        "Committed lifecycle owner generation",
      ),
      restoreIdentity: readEvidenceString(restore.restoreIdentity, "Restore identity"),
      planId: readEvidenceString(restore.planId, "Committed restore plan identity"),
      receiptIdentity: readEvidenceString(restore.receiptIdentity, "Restore receipt identity"),
      committedRecordIdentity: readEvidenceString(
        restore.committedRecordIdentity,
        "Committed restore record identity",
      ),
    },
  };
  validateStaticEvidence(evidence);
  return evidence;
}

function validateStaticEvidence(evidence: ContinuityRestoreCompleteEvidence): void {
  if (evidence.startupMode !== "restored") {
    throw new ContinuityRestoreCompleteError(
      "restoring",
      "ContinuityRestoreFailed",
      "quarantine",
      "Continuity startup mode is invalid for restored readiness.",
    );
  }
  requireString(evidence.operationId, "Restore-complete operation identity");
  requireString(evidence.ownerId, "Owner identity", PREFIXED_SHA256_PATTERN);
  requireString(evidence.destinationRuntimeGeneration, "Destination runtime generation");
  requireString(evidence.lifecycleOwnerGeneration, "Lifecycle owner generation");
  requireString(evidence.acceptedRecoveryPoint.recoveryPointId, "Recovery-point identity");
  requireString(evidence.acceptedRecoveryPoint.publicationIdentity, "Publication identity");
  requireString(evidence.acceptedRecoveryPoint.manifestSha256, "Manifest digest", SHA256_PATTERN);
  requireString(evidence.preparationIdentity, "Preparation identity");
  requireString(evidence.admissionIdentity, "Admission identity");
  requireString(evidence.expectedPlanId, "Expected restore plan identity", SHA256_PATTERN);
  requireString(evidence.restore.ownerGeneration, "Committed lifecycle owner generation");
  requireString(evidence.restore.restoreIdentity, "Restore identity");
  requireString(evidence.restore.planId, "Committed restore plan identity", SHA256_PATTERN);
  requireString(
    evidence.restore.receiptIdentity,
    "Restore receipt identity",
    PREFIXED_SHA256_PATTERN,
  );
  requireString(
    evidence.restore.committedRecordIdentity,
    "Committed restore record identity",
    PREFIXED_SHA256_PATTERN,
  );
  if (
    evidence.restore.ok !== true ||
    evidence.restore.version !== "continuity-restore-execution-result/v1"
  ) {
    throw new ContinuityRestoreCompleteError(
      "restoring",
      "ContinuityRestoreFailed",
      "quarantine",
      "Committed restore evidence is invalid.",
    );
  }
  if (
    evidence.restore.ownerGeneration !== evidence.lifecycleOwnerGeneration ||
    evidence.restore.planId !== evidence.expectedPlanId
  ) {
    throw new ContinuityRestoreCompleteError(
      "restoring",
      "ContinuityRestoreFailed",
      "quarantine",
      "Committed restore evidence does not bind the requested destination.",
    );
  }
}

function requiredOwnerReadiness(
  obligations: ContinuityArchiveObligations,
): RequiredOwnerReadinessRequirement[] {
  return [
    {
      obligationId: "reconstructed.pluginRuntimeDependencies",
      owner: obligations.reconstructed.pluginRuntimeDependencies.owner,
    },
    {
      obligationId: "external.configSecretReferences",
      owner: obligations.external.configSecretReferences.owner,
    },
    {
      obligationId: "external.authProfileCredentials",
      owner: obligations.external.authProfileCredentials.owner,
    },
  ];
}

function validateOwnerReadiness(
  requirements: readonly RequiredOwnerReadinessRequirement[],
  findings: readonly OwnerReadinessFinding[],
): string {
  const byId = new Map<string, OwnerReadinessFinding>();
  for (const finding of findings) {
    if (byId.has(finding.obligationId)) {
      throw new ContinuityRestoreCompleteError(
        "blocked",
        "ContinuityReadinessFailed",
        "hold",
        "Required owner readiness contains duplicate obligations.",
      );
    }
    byId.set(finding.obligationId, finding);
  }
  if (findings.length !== requirements.length) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ContinuityReadinessFailed",
      "hold",
      "Required owner readiness is incomplete.",
    );
  }
  const canonicalFindings = requirements
    .map((requirement) => {
      const finding = byId.get(requirement.obligationId);
      if (
        !finding ||
        finding.owner !== requirement.owner ||
        finding.ready !== true ||
        !PREFIXED_SHA256_PATTERN.test(finding.evidenceIdentity)
      ) {
        throw new ContinuityRestoreCompleteError(
          "blocked",
          "ContinuityReadinessFailed",
          "hold",
          `Required owner ${requirement.owner} is not ready.`,
        );
      }
      return {
        obligationId: requirement.obligationId,
        owner: requirement.owner,
        evidenceIdentity: finding.evidenceIdentity,
        ...(finding.detail === undefined ? {} : { detail: finding.detail }),
      };
    })
    .toSorted((left, right) => left.obligationId.localeCompare(right.obligationId));
  return digestCanonical(canonicalFindings);
}

function validateGatewayReadiness(gatewayReadiness: GatewayReadinessEvidence): void {
  if (
    gatewayReadiness.ready !== true ||
    gatewayReadiness.failing.length !== 0 ||
    !PREFIXED_SHA256_PATTERN.test(gatewayReadiness.generation)
  ) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ContinuityReadinessFailed",
      "hold",
      "Gateway readiness has not completed.",
    );
  }
}

function recordWithoutGeneration(
  record: ContinuityRestoreCompleteRecord,
): Omit<ContinuityRestoreCompleteRecord, "readinessGeneration"> {
  const { readinessGeneration: _readinessGeneration, ...input } = record;
  return input;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateWakeDescriptor(wake: ContinuityWakeDescriptor): void {
  const hasValidDeadline =
    wake.nextRequiredAt === null ||
    (typeof wake.nextRequiredAt === "string" && isCanonicalIsoTimestamp(wake.nextRequiredAt));
  if (
    wake.version !== "continuity-wake-descriptor/v1" ||
    !PREFIXED_SHA256_PATTERN.test(wake.schedulerGeneration) ||
    !hasValidDeadline ||
    (wake.reasonClass !== "cron" && wake.reasonClass !== "none") ||
    (wake.reasonClass === "none" && wake.nextRequiredAt !== null) ||
    (wake.reasonClass === "cron" && wake.nextRequiredAt === null)
  ) {
    throw new ContinuityRestoreCompleteError(
      "reconciling",
      "SchedulerReconciliationFailed",
      "retry-same-incarnation",
      "Scheduler reconciliation produced an invalid wake descriptor.",
    );
  }
}

function buildRecord(
  evidence: ContinuityRestoreCompleteEvidence,
  wake: ContinuityWakeDescriptor,
  ownerReadinessDigest: string,
): ContinuityRestoreCompleteRecord {
  validateWakeDescriptor(wake);
  const recordWithoutReadiness = {
    // RFC v1 binds the accepted publication through recoveryPointId + manifestSha256.
    // Gateway readiness is a publication gate; its generation is not a record identity.
    version: RESTORE_COMPLETE_VERSION,
    ownerId: evidence.ownerId,
    destinationRuntimeGeneration: evidence.destinationRuntimeGeneration,
    lifecycleOwnerGeneration: evidence.lifecycleOwnerGeneration,
    recoveryPointId: evidence.acceptedRecoveryPoint.recoveryPointId,
    manifestSha256: evidence.acceptedRecoveryPoint.manifestSha256,
    preparationIdentity: evidence.preparationIdentity,
    restoreIdentity: evidence.restore.restoreIdentity,
    restoreReceiptIdentity: evidence.restore.receiptIdentity,
    committedRecordIdentity: evidence.restore.committedRecordIdentity,
    planId: evidence.restore.planId,
    schedulerGeneration: wake.schedulerGeneration,
    nextRequiredAt: wake.nextRequiredAt,
    reasonClass: wake.reasonClass,
    requiredOwnerReadinessDigest: ownerReadinessDigest,
    admissionIdentity: evidence.admissionIdentity,
  } satisfies Omit<ContinuityRestoreCompleteRecord, "readinessGeneration">;
  return {
    ...recordWithoutReadiness,
    readinessGeneration: digestCanonical(recordWithoutReadiness),
  };
}

function assertRecordMatchesEvidence(
  record: ContinuityRestoreCompleteRecord,
  evidence: ContinuityRestoreCompleteEvidence,
): void {
  if (
    record.ownerId !== evidence.ownerId ||
    record.destinationRuntimeGeneration !== evidence.destinationRuntimeGeneration ||
    record.lifecycleOwnerGeneration !== evidence.lifecycleOwnerGeneration ||
    record.recoveryPointId !== evidence.acceptedRecoveryPoint.recoveryPointId ||
    record.manifestSha256 !== evidence.acceptedRecoveryPoint.manifestSha256 ||
    record.preparationIdentity !== evidence.preparationIdentity ||
    record.admissionIdentity !== evidence.admissionIdentity ||
    record.restoreIdentity !== evidence.restore.restoreIdentity ||
    record.restoreReceiptIdentity !== evidence.restore.receiptIdentity ||
    record.committedRecordIdentity !== evidence.restore.committedRecordIdentity ||
    record.planId !== evidence.restore.planId ||
    record.readinessGeneration !== digestCanonical(recordWithoutGeneration(record))
  ) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ReadinessGenerationConflict",
      "quarantine",
      "Durable restore-complete record conflicts with the accepted restore.",
    );
  }
}

function validateRestoreCompleteRecord(parsed: unknown): ContinuityRestoreCompleteRecord {
  if (!isRecord(parsed)) {
    throw new Error("Restore-complete record must be an object.");
  }
  const expectedKeys: Array<keyof ContinuityRestoreCompleteRecord> = [
    "version",
    "ownerId",
    "destinationRuntimeGeneration",
    "lifecycleOwnerGeneration",
    "recoveryPointId",
    "manifestSha256",
    "preparationIdentity",
    "restoreIdentity",
    "restoreReceiptIdentity",
    "committedRecordIdentity",
    "planId",
    "schedulerGeneration",
    "nextRequiredAt",
    "reasonClass",
    "requiredOwnerReadinessDigest",
    "admissionIdentity",
    "readinessGeneration",
  ];
  if (
    Object.keys(parsed).length !== expectedKeys.length ||
    Object.keys(parsed).some(
      (key) => !expectedKeys.includes(key as keyof ContinuityRestoreCompleteRecord),
    )
  ) {
    throw new Error("Restore-complete record has unknown or missing fields.");
  }
  const record = parsed as ContinuityRestoreCompleteRecord;
  if (
    record.version !== RESTORE_COMPLETE_VERSION ||
    (typeof record.nextRequiredAt !== "string" && record.nextRequiredAt !== null) ||
    (record.reasonClass !== "cron" && record.reasonClass !== "none") ||
    (record.nextRequiredAt !== null && !isCanonicalIsoTimestamp(record.nextRequiredAt)) ||
    (record.reasonClass === "none" && record.nextRequiredAt !== null) ||
    (record.reasonClass === "cron" && record.nextRequiredAt === null)
  ) {
    throw new Error("Restore-complete record is invalid.");
  }
  for (const value of [
    record.ownerId,
    record.destinationRuntimeGeneration,
    record.lifecycleOwnerGeneration,
    record.recoveryPointId,
    record.manifestSha256,
    record.preparationIdentity,
    record.restoreIdentity,
    record.restoreReceiptIdentity,
    record.committedRecordIdentity,
    record.planId,
    record.schedulerGeneration,
    record.requiredOwnerReadinessDigest,
    record.admissionIdentity,
    record.readinessGeneration,
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("Restore-complete record contains an invalid identity.");
    }
  }
  if (
    !PREFIXED_SHA256_PATTERN.test(record.ownerId) ||
    !SHA256_PATTERN.test(record.manifestSha256) ||
    !SHA256_PATTERN.test(record.planId) ||
    !PREFIXED_SHA256_PATTERN.test(record.restoreReceiptIdentity) ||
    !PREFIXED_SHA256_PATTERN.test(record.committedRecordIdentity) ||
    !PREFIXED_SHA256_PATTERN.test(record.schedulerGeneration) ||
    !PREFIXED_SHA256_PATTERN.test(record.requiredOwnerReadinessDigest) ||
    !PREFIXED_SHA256_PATTERN.test(record.readinessGeneration) ||
    record.readinessGeneration !== digestCanonical(recordWithoutGeneration(record))
  ) {
    throw new Error("Restore-complete record contains invalid authority evidence.");
  }
  return record;
}

function parseRestoreCompleteRecord(raw: string): ContinuityRestoreCompleteRecord {
  if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) {
    throw new Error("Restore-complete record is too large.");
  }
  const record = validateRestoreCompleteRecord(JSON.parse(raw) as unknown);
  if (raw !== `${canonicalContinuityJson(record)}\n`) {
    throw new Error("Restore-complete record is not canonical exact bytes.");
  }
  return record;
}

async function readExistingRecord(
  recordPath: string,
  evidence: ContinuityRestoreCompleteEvidence,
  syncDirectory: (directoryPath: string) => Promise<void>,
): Promise<ContinuityRestoreCompleteRecord | undefined> {
  let metadata;
  try {
    metadata = await fs.lstat(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ReadinessGenerationConflict",
      "quarantine",
      "Durable restore-complete record is not a private regular file.",
    );
  }
  let record: ContinuityRestoreCompleteRecord;
  try {
    record = parseRestoreCompleteRecord(await fs.readFile(recordPath, "utf8"));
  } catch (error) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ReadinessGenerationConflict",
      "quarantine",
      "Durable restore-complete record is corrupt or non-canonical.",
      { cause: error },
    );
  }
  assertRecordMatchesEvidence(record, evidence);
  await syncDirectory(path.dirname(recordPath));
  return record;
}

function journalFailure(error: unknown): ContinuityRestoreCompleteError {
  if (error instanceof ContinuityRestoreCompleteError) {
    return error;
  }
  return new ContinuityRestoreCompleteError(
    "blocked",
    "ContinuityReadinessFailed",
    "hold",
    "Restore-complete journal is unavailable.",
    { cause: error },
  );
}

async function publishRecord(
  recordPath: string,
  record: ContinuityRestoreCompleteRecord,
  evidence: ContinuityRestoreCompleteEvidence,
  syncDirectory: (directoryPath: string) => Promise<void>,
): Promise<{ record: ContinuityRestoreCompleteRecord; replayed: boolean }> {
  const temporaryPath = path.join(
    path.dirname(recordPath),
    `.${path.basename(recordPath)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${canonicalContinuityJson(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporaryPath, recordPath);
      await syncDirectory(path.dirname(recordPath));
      return { record, replayed: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = await readExistingRecord(recordPath, evidence, syncDirectory);
      if (!existing) {
        throw new ContinuityRestoreCompleteError(
          "blocked",
          "ReadinessGenerationConflict",
          "quarantine",
          "Durable restore-complete record disappeared during publication.",
        );
      }
      // A concurrent valid winner owns the dynamic readiness snapshot for this operation.
      return { record: existing, replayed: true };
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function completeContinuityRestore(
  evidence: ContinuityRestoreCompleteEvidence,
  journalRoot: string,
  dependencies: ContinuityRestoreCompleteDependencies,
): Promise<ContinuityRestoreCompleteOutcome> {
  if (evidence.startupMode === "ordinary") {
    return {
      version: RESTORE_COMPLETE_OUTCOME_VERSION,
      ok: true,
      skipped: true,
      reason: "ordinary-startup",
    };
  }
  try {
    validateStaticEvidence(evidence);
    const operationDirectory = path.join(
      journalRoot,
      digestCanonical(evidence.operationId).slice(7),
    );
    const recordPath = path.join(operationDirectory, "restore-complete.json");
    const syncDirectory = dependencies.syncJournalDirectory ?? syncDirectoryEntry;
    try {
      await ensureDurableDirectoryTree(journalRoot, {
        mode: 0o700,
        requirePrivateExisting: true,
      });
      await ensureDurableDirectoryTree(operationDirectory, {
        mode: 0o700,
        requirePrivateExisting: true,
      });
      const existing = await readExistingRecord(recordPath, evidence, syncDirectory);
      if (existing) {
        return {
          version: RESTORE_COMPLETE_OUTCOME_VERSION,
          ok: true,
          phase: "reconciling",
          readinessGeneration: existing.readinessGeneration,
          record: existing,
          replayed: true,
          admissionOpen: false,
        };
      }
    } catch (error) {
      throw journalFailure(error);
    }

    try {
      await dependencies.reconcileScheduler();
    } catch (error) {
      throw new ContinuityRestoreCompleteError(
        "reconciling",
        "SchedulerReconciliationFailed",
        "retry-same-incarnation",
        "Scheduler reconciliation failed.",
        { cause: error },
      );
    }
    let wake: ContinuityWakeDescriptor;
    try {
      wake = await dependencies.resolveWakeDescriptor();
    } catch (error) {
      throw new ContinuityRestoreCompleteError(
        "reconciling",
        "SchedulerReconciliationFailed",
        "retry-same-incarnation",
        "Scheduler wake descriptor could not be resolved.",
        { cause: error },
      );
    }
    const requirements = requiredOwnerReadiness(evidence.continuityObligations);
    let ownerReadiness: readonly OwnerReadinessFinding[];
    let gatewayReadiness: GatewayReadinessEvidence;
    try {
      ownerReadiness = await dependencies.resolveOwnerReadiness(requirements);
      gatewayReadiness = await dependencies.resolveGatewayReadiness();
    } catch (error) {
      throw new ContinuityRestoreCompleteError(
        "blocked",
        "ContinuityReadinessFailed",
        "hold",
        "Post-restore readiness evidence could not be resolved.",
        { cause: error },
      );
    }
    const ownerReadinessDigest = validateOwnerReadiness(requirements, ownerReadiness);
    validateGatewayReadiness(gatewayReadiness);
    const record = buildRecord(evidence, wake, ownerReadinessDigest);
    let published;
    try {
      published = await publishRecord(recordPath, record, evidence, syncDirectory);
    } catch (error) {
      throw journalFailure(error);
    }
    return {
      version: RESTORE_COMPLETE_OUTCOME_VERSION,
      ok: true,
      phase: "reconciling",
      readinessGeneration: published.record.readinessGeneration,
      record: published.record,
      replayed: published.replayed,
      admissionOpen: false,
    };
  } catch (error) {
    const failure = error instanceof ContinuityRestoreCompleteError ? error : journalFailure(error);
    return {
      version: RESTORE_COMPLETE_OUTCOME_VERSION,
      ok: false,
      phase: failure.phase,
      code: failure.code,
      disposition: failure.disposition,
    };
  }
}

export function openRestoredAdmission(
  record: ContinuityRestoreCompleteRecord,
  expected: {
    ownerId: string;
    destinationRuntimeGeneration: string;
    lifecycleOwnerGeneration: string;
    restoreReceiptIdentity: string;
    admissionIdentity: string;
    readinessGeneration: string;
  },
): RestoredAdmission {
  try {
    validateRestoreCompleteRecord(record);
  } catch (error) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ReadinessGenerationConflict",
      "quarantine",
      "Restored admission record is invalid.",
      { cause: error },
    );
  }
  if (
    record.ownerId !== expected.ownerId ||
    record.destinationRuntimeGeneration !== expected.destinationRuntimeGeneration ||
    record.lifecycleOwnerGeneration !== expected.lifecycleOwnerGeneration ||
    record.restoreReceiptIdentity !== expected.restoreReceiptIdentity ||
    record.admissionIdentity !== expected.admissionIdentity ||
    record.readinessGeneration !== expected.readinessGeneration
  ) {
    throw new ContinuityRestoreCompleteError(
      "blocked",
      "ReadinessGenerationConflict",
      "quarantine",
      "Restored admission evidence does not match the durable completion record.",
    );
  }
  return {
    open: true,
    phase: "ready",
    admissionIdentity: record.admissionIdentity,
    readinessGeneration: record.readinessGeneration,
    record,
  };
}

export function projectContinuityRestoreStatus(
  outcome: ContinuityRestoreCompleteOutcome | RestoredAdmission,
): ContinuityRestoreStatus {
  if ("open" in outcome) {
    return {
      phase: "ready",
      readinessGeneration: outcome.readinessGeneration,
      admissionOpen: true,
    };
  }
  if (outcome.ok && "skipped" in outcome) {
    return { phase: "ready", admissionOpen: true };
  }
  if (!outcome.ok) {
    return {
      phase: outcome.phase,
      admissionOpen: false,
      code: outcome.code,
      disposition: outcome.disposition,
    };
  }
  return {
    phase: "reconciling",
    readinessGeneration: outcome.readinessGeneration,
    admissionOpen: false,
  };
}
