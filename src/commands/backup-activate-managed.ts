import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CONTINUITY_RESTORE_CLAIM_MARKER } from "../continuity/restore-claim.js";
import type {
  ContinuityRestorePlanFile,
  ContinuityRestorePlanGroup,
} from "../continuity/restore-plan.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { syncDirectoryEntry } from "../infra/fs-durability.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord } from "../utils.js";
import { planContinuityRestore } from "./backup-plan-restore.js";

const REQUEST_VERSION = "continuity-restore-execution/v1";
const RESULT_VERSION = "continuity-restore-execution-result/v1";
const CLAIM_MARKER = CONTINUITY_RESTORE_CLAIM_MARKER;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 4096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type ManagedRestoreRequest = {
  version: typeof REQUEST_VERSION;
  authority: {
    ownerId: string;
    ownerGeneration: string;
    holdRevision: number;
    restoreIdentity: string;
    executionIncarnationIdentity: string;
  };
  source: {
    archivePath: string;
    archiveSha256: string;
    manifestSha256: string;
    materializedRoot: string;
    materializationReceiptSha256: string;
    expectedPlanId: string;
  };
  policy: {
    authorizedPublicationRoots: string[];
  };
  journalRoot: string;
};

export type ManagedRestoreSuccess = {
  version: typeof RESULT_VERSION;
  ok: true;
  ownerGeneration: string;
  holdRevision: number;
  restoreIdentity: string;
  executionIncarnationIdentity: string;
  planId: string;
  receiptIdentity: string;
  receiptPath: string;
  committedRecordIdentity: string;
  targetRootCount: number;
  fileCount: number;
};

export type ManagedRestoreFailureCode =
  | "continuity.restore.request_invalid"
  | "continuity.restore.materialization_content_identity_required"
  | "continuity.restore.plan_mismatch"
  | "continuity.restore.target_unattributed"
  | "continuity.restore.target_identity_mismatch"
  | "continuity.restore.journal_conflict";

export type ManagedRestoreFailure = {
  version: typeof RESULT_VERSION;
  ok: false;
  restoreIdentity: string;
  executionIncarnationIdentity: string;
  phase: "request" | "preflight" | "journal" | "claim" | "assembly" | "verify";
  code: ManagedRestoreFailureCode;
  disposition: "retry-same-restore" | "quarantine";
};

export type ManagedRestoreResult = ManagedRestoreSuccess | ManagedRestoreFailure;

export type ManagedRestoreExecutionHooks = {
  afterFileCommitted?: (count: number) => void | Promise<void>;
};

class ManagedRestoreError extends Error {
  constructor(
    public readonly phase: ManagedRestoreFailure["phase"],
    public readonly code: ManagedRestoreFailureCode,
    public readonly disposition: ManagedRestoreFailure["disposition"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedRestoreError";
  }
}

async function runManagedPhase<T>(
  phase: ManagedRestoreFailure["phase"],
  code: ManagedRestoreFailureCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ManagedRestoreError) {
      throw error;
    }
    throw new ManagedRestoreError(
      phase,
      code,
      "quarantine",
      `Continuity restore ${phase} operation failed.`,
      { cause: error },
    );
  }
}

function expectExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(record).find((key) => !expected.includes(key));
  if (unexpected || Object.keys(record).length !== expected.length) {
    throw new Error(`${label} contains an unknown or missing field: ${unexpected ?? "unknown"}.`);
  }
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${label} ${key} must be an object.`);
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
    throw new Error(`${label} ${key} is invalid.`);
  }
  return value;
}

function readAbsolutePath(record: Record<string, unknown>, key: string, label: string): string {
  const value = readString(record, key, label);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} ${key} must be an absolute normalized path.`);
  }
  return value;
}

export function parseManagedRestoreRequest(raw: string): ManagedRestoreRequest {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    throw new Error("Continuity restore execution request is too large.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Continuity restore execution request must be an object.");
  }
  expectExactKeys(parsed, ["version", "authority", "source", "policy", "journalRoot"], "Request");
  if (parsed.version !== REQUEST_VERSION) {
    throw new Error("Continuity restore execution request version is unsupported.");
  }
  const authority = readRecord(parsed, "authority", "Request");
  expectExactKeys(
    authority,
    [
      "ownerId",
      "ownerGeneration",
      "holdRevision",
      "restoreIdentity",
      "executionIncarnationIdentity",
    ],
    "Authority",
  );
  const holdRevision = authority.holdRevision;
  if (!Number.isSafeInteger(holdRevision) || (holdRevision as number) < 0) {
    throw new Error("Authority holdRevision is invalid.");
  }
  const source = readRecord(parsed, "source", "Request");
  expectExactKeys(
    source,
    [
      "archivePath",
      "archiveSha256",
      "manifestSha256",
      "materializedRoot",
      "materializationReceiptSha256",
      "expectedPlanId",
    ],
    "Source",
  );
  const policy = readRecord(parsed, "policy", "Request");
  expectExactKeys(policy, ["authorizedPublicationRoots"], "Policy");
  const roots = policy.authorizedPublicationRoots;
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 64) {
    throw new Error("Policy authorizedPublicationRoots is invalid.");
  }
  const authorizedPublicationRoots = roots.map((root, index) => {
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.length > MAX_STRING_LENGTH ||
      !path.isAbsolute(root) ||
      path.normalize(root) !== root
    ) {
      throw new Error(`Policy authorizedPublicationRoots[${index}] is invalid.`);
    }
    return root;
  });
  if (new Set(authorizedPublicationRoots).size !== authorizedPublicationRoots.length) {
    throw new Error("Policy authorizedPublicationRoots contains duplicates.");
  }
  return {
    version: REQUEST_VERSION,
    authority: {
      ownerId: readString(authority, "ownerId", "Authority", PREFIXED_SHA256_PATTERN),
      ownerGeneration: readString(authority, "ownerGeneration", "Authority"),
      holdRevision: holdRevision as number,
      restoreIdentity: readString(authority, "restoreIdentity", "Authority"),
      executionIncarnationIdentity: readString(
        authority,
        "executionIncarnationIdentity",
        "Authority",
        PREFIXED_SHA256_PATTERN,
      ),
    },
    source: {
      archivePath: readAbsolutePath(source, "archivePath", "Source"),
      archiveSha256: readString(source, "archiveSha256", "Source", SHA256_PATTERN),
      manifestSha256: readString(source, "manifestSha256", "Source", SHA256_PATTERN),
      materializedRoot: readAbsolutePath(source, "materializedRoot", "Source"),
      materializationReceiptSha256: readString(
        source,
        "materializationReceiptSha256",
        "Source",
        SHA256_PATTERN,
      ),
      expectedPlanId: readString(source, "expectedPlanId", "Source", SHA256_PATTERN),
    },
    policy: { authorizedPublicationRoots },
    journalRoot: readAbsolutePath(parsed, "journalRoot", "Request"),
  };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function recordIdentity(raw: string): string {
  return `sha256:${sha256Hex(raw)}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeNewRecord(filePath: string, value: unknown): Promise<string> {
  const raw = canonicalJson(value);
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryEntry(path.dirname(filePath));
  return recordIdentity(raw);
}

async function requireExactRecord(filePath: string, value: unknown): Promise<string> {
  const expected = canonicalJson(value);
  let actual: string;
  try {
    actual = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ManagedRestoreError(
      "journal",
      "continuity.restore.journal_conflict",
      "quarantine",
      `Continuity restore journal record is missing: ${path.basename(filePath)}`,
      { cause: error },
    );
  }
  if (actual !== expected) {
    throw new ManagedRestoreError(
      "journal",
      "continuity.restore.journal_conflict",
      "quarantine",
      `Continuity restore journal record conflicts: ${path.basename(filePath)}`,
    );
  }
  return recordIdentity(actual);
}

async function writeOrRequireRecord(filePath: string, value: unknown): Promise<string> {
  try {
    return await writeNewRecord(filePath, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return await requireExactRecord(filePath, value);
  }
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function assertPrivateDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ManagedRestoreError(
      "preflight",
      "continuity.restore.plan_mismatch",
      "quarantine",
      `${label} must be a regular directory.`,
    );
  }
}

function flattenPlanFiles(groups: ContinuityRestorePlanGroup[]): ContinuityRestorePlanFile[] {
  const files = groups.flatMap((group) => group.files ?? []);
  if (files.length === 0 || groups.some((group) => group.files === undefined)) {
    throw new ManagedRestoreError(
      "preflight",
      "continuity.restore.materialization_content_identity_required",
      "quarantine",
      "Continuity restore execution requires exact materialized file identities.",
    );
  }
  const markerCollision = groups.find((group) =>
    group.members
      .filter((member) => member.targetKind === "directory")
      .some((member) =>
        group.files?.some(
          (file) =>
            file.targetRelativePath ===
            path.join(member.targetRelativePath, CONTINUITY_RESTORE_CLAIM_MARKER),
        ),
      ),
  );
  if (markerCollision) {
    throw new ManagedRestoreError(
      "preflight",
      "continuity.restore.plan_mismatch",
      "quarantine",
      `Continuity restore payload collides with reserved claim evidence: ${markerCollision.canonicalTargetPath}`,
    );
  }
  return files.toSorted((left, right) =>
    left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0,
  );
}

async function verifyExactFile(
  filePath: string,
  expected: Pick<ContinuityRestorePlanFile, "sha256" | "size" | "executable">,
): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size !== expected.size ||
    (stat.mode & 0o100) !== (expected.executable ? 0o100 : 0) ||
    (await sha256File(filePath)) !== expected.sha256
  ) {
    throw new ManagedRestoreError(
      "verify",
      "continuity.restore.target_identity_mismatch",
      "quarantine",
      `Continuity restore file identity mismatch: ${filePath}`,
    );
  }
}

async function ensureDirectoryPath(
  relativeDirectory: string,
  group: ContinuityRestorePlanGroup,
): Promise<void> {
  // E4d serializes this operation with Gateway absent; these checks reject links
  // persisted by interruption or replay before path-based publication resumes.
  const rootStat = await fs.lstat(group.canonicalTargetPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ManagedRestoreError(
      "assembly",
      "continuity.restore.target_identity_mismatch",
      "quarantine",
      `Continuity restore directory root changed: ${group.canonicalTargetPath}`,
    );
  }
  if (
    path.isAbsolute(relativeDirectory) ||
    path.normalize(relativeDirectory) !== relativeDirectory ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`)
  ) {
    throw new ManagedRestoreError(
      "assembly",
      "continuity.restore.plan_mismatch",
      "quarantine",
      `Continuity restore directory escaped its publication root: ${relativeDirectory}`,
    );
  }
  if (relativeDirectory === ".") {
    return;
  }
  let current = group.canonicalTargetPath;
  for (const segment of relativeDirectory.split(path.sep)) {
    const parent = current;
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
      await syncDirectoryEntry(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ManagedRestoreError(
        "assembly",
        "continuity.restore.target_identity_mismatch",
        "quarantine",
        `Continuity restore target parent is not a regular directory: ${current}`,
      );
    }
  }
}

async function copyOrVerifyFile(
  file: ContinuityRestorePlanFile,
  group: ContinuityRestorePlanGroup,
): Promise<void> {
  if (group.targetKind === "directory") {
    await ensureDirectoryPath(path.dirname(file.targetRelativePath), group);
  } else if (file.canonicalTargetPath !== group.canonicalTargetPath) {
    throw new ManagedRestoreError(
      "claim",
      "continuity.restore.plan_mismatch",
      "quarantine",
      "Continuity restore file root does not match its only payload file.",
    );
  }
  const sourceStat = await fs.lstat(file.materializedSourcePath);
  if (
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    sourceStat.nlink !== 1 ||
    sourceStat.size !== file.size ||
    (sourceStat.mode & 0o100) !== (file.executable ? 0o100 : 0)
  ) {
    throw new ManagedRestoreError(
      "assembly",
      "continuity.restore.target_identity_mismatch",
      "quarantine",
      `Continuity restore materialized source changed: ${file.archivePath}`,
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    destinationHandle = await fs.open(
      file.canonicalTargetPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      file.executable ? 0o700 : 0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await verifyExactFile(file.canonicalTargetPath, file);
    return;
  }
  const sourceHandle = await fs.open(file.materializedSourcePath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedStat = await sourceHandle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino ||
      openedStat.nlink !== 1
    ) {
      throw new ManagedRestoreError(
        "assembly",
        "continuity.restore.target_identity_mismatch",
        "quarantine",
        `Continuity restore materialized source changed before copy: ${file.archivePath}`,
      );
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copiedBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      copiedBytes += bytesRead;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          offset,
          bytesRead - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error("Continuity restore target write stalled.");
        }
        offset += bytesWritten;
      }
    }
    if (copiedBytes !== file.size) {
      throw new ManagedRestoreError(
        "assembly",
        "continuity.restore.target_identity_mismatch",
        "quarantine",
        `Continuity restore materialized source size changed: ${file.archivePath}`,
      );
    }
    await destinationHandle.chmod(file.executable ? 0o700 : 0o600);
    await destinationHandle.sync();
  } catch (error) {
    await destinationHandle.close().catch(() => undefined);
    destinationHandle = undefined;
    await fs.rm(file.canonicalTargetPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
  await syncDirectoryEntry(path.dirname(file.canonicalTargetPath));
  await verifyExactFile(file.canonicalTargetPath, file);
}

async function assertPublicationParents(groups: ContinuityRestorePlanGroup[]): Promise<void> {
  for (const group of groups) {
    const parent = path.dirname(group.canonicalTargetPath);
    let stat;
    try {
      stat = await fs.lstat(parent);
    } catch (error) {
      throw new ManagedRestoreError(
        "preflight",
        "continuity.restore.plan_mismatch",
        "quarantine",
        `Continuity restore target parent is unavailable: ${parent}`,
        { cause: error },
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ManagedRestoreError(
        "preflight",
        "continuity.restore.plan_mismatch",
        "quarantine",
        `Continuity restore target parent is not a regular directory: ${parent}`,
      );
    }
  }
}

async function listTargetEntries(directory: string, relative = ""): Promise<string[]> {
  const entries: string[] = [];
  const current = path.join(directory, relative);
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const relativePath = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      entries.push(...(await listTargetEntries(directory, relativePath)));
    } else if (entry.isFile()) {
      entries.push(`file:${relativePath}`);
    } else {
      throw new ManagedRestoreError(
        "verify",
        "continuity.restore.target_identity_mismatch",
        "quarantine",
        `Continuity restore target contains an unsupported entry: ${relativePath}`,
      );
    }
  }
  return entries.toSorted();
}

function addDirectoryAndParents(entries: Set<string>, relativeDirectory: string): void {
  let current = relativeDirectory;
  while (current !== ".") {
    entries.add(`directory:${current}`);
    current = path.dirname(current);
  }
}

function expectedTargetEntries(group: ContinuityRestorePlanGroup): string[] {
  const entries = new Set<string>([`file:${CLAIM_MARKER}`]);
  for (const member of group.members) {
    if (member.targetKind === "directory") {
      addDirectoryAndParents(entries, member.targetRelativePath);
    }
  }
  for (const file of group.files ?? []) {
    entries.add(`file:${file.targetRelativePath}`);
    addDirectoryAndParents(entries, path.dirname(file.targetRelativePath));
  }
  return [...entries].toSorted();
}

async function verifyTargetGroups(groups: ContinuityRestorePlanGroup[]): Promise<void> {
  for (const group of groups) {
    if (group.targetKind === "file") {
      const onlyFile = group.files?.[0];
      if (!onlyFile || group.files?.length !== 1) {
        throw new ManagedRestoreError(
          "verify",
          "continuity.restore.plan_mismatch",
          "quarantine",
          "Continuity restore file root has invalid inventory.",
        );
      }
      await verifyExactFile(group.canonicalTargetPath, onlyFile);
      continue;
    }
    const expected = expectedTargetEntries(group);
    const observed = await listTargetEntries(group.canonicalTargetPath);
    if (
      observed.length !== expected.length ||
      observed.some((relativePath, index) => relativePath !== expected[index])
    ) {
      throw new ManagedRestoreError(
        "verify",
        "continuity.restore.target_identity_mismatch",
        "quarantine",
        `Continuity restore target tree contains missing or foreign files: ${group.canonicalTargetPath}`,
      );
    }
  }
}

function buildClaimMarker(
  request: ManagedRestoreRequest,
  planId: string,
  intentRecordIdentity: string,
  group: ContinuityRestorePlanGroup,
) {
  return {
    schemaVersion: 1,
    recordType: "continuity-restore-root-claim",
    ownerGeneration: request.authority.ownerGeneration,
    holdRevision: request.authority.holdRevision,
    restoreIdentity: request.authority.restoreIdentity,
    executionIncarnationIdentity: request.authority.executionIncarnationIdentity,
    planId,
    intentRecordIdentity,
    rootComponentId: group.rootComponentId,
  } as const;
}

async function claimDirectoryRoot(
  request: ManagedRestoreRequest,
  planId: string,
  intentRecordIdentity: string,
  group: ContinuityRestorePlanGroup,
): Promise<void> {
  let created = false;
  try {
    await fs.mkdir(group.canonicalTargetPath, { mode: 0o700 });
    created = true;
    await syncDirectoryEntry(path.dirname(group.canonicalTargetPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const markerPath = path.join(group.canonicalTargetPath, CLAIM_MARKER);
  const marker = buildClaimMarker(request, planId, intentRecordIdentity, group);
  if (created) {
    await writeNewRecord(markerPath, marker);
    return;
  }
  try {
    await requireExactRecord(markerPath, marker);
  } catch (error) {
    if (error instanceof ManagedRestoreError) {
      throw new ManagedRestoreError(
        "claim",
        "continuity.restore.target_unattributed",
        "quarantine",
        `Continuity restore directory root is not attributable: ${group.canonicalTargetPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function executeManagedRestore(
  request: ManagedRestoreRequest,
  hooks: ManagedRestoreExecutionHooks = {},
): Promise<ManagedRestoreSuccess> {
  const journalRoot = await runManagedPhase(
    "preflight",
    "continuity.restore.plan_mismatch",
    async () => {
      await assertPrivateDirectory(request.journalRoot, "Continuity restore journal root");
      return await fs.realpath(request.journalRoot);
    },
  );
  let planned;
  try {
    planned = await planContinuityRestore({
      archive: request.source.archivePath,
      materialized: request.source.materializedRoot,
      authorize: request.policy.authorizedPublicationRoots,
      allowExistingTargets: true,
      requireContentInventory: true,
    });
  } catch (error) {
    const missingInventory =
      error instanceof Error && /requires materialized content identity/i.test(error.message);
    throw new ManagedRestoreError(
      "preflight",
      missingInventory
        ? "continuity.restore.materialization_content_identity_required"
        : "continuity.restore.plan_mismatch",
      "quarantine",
      "Continuity restore plan revalidation failed.",
      { cause: error },
    );
  }
  const { plan } = planned;
  if (
    plan.planId !== request.source.expectedPlanId ||
    plan.artifact.archiveSha256 !== request.source.archiveSha256 ||
    plan.artifact.manifestSha256 !== request.source.manifestSha256 ||
    plan.materialization.receiptSha256 !== request.source.materializationReceiptSha256
  ) {
    throw new ManagedRestoreError(
      "preflight",
      "continuity.restore.plan_mismatch",
      "quarantine",
      "Continuity restore plan identities do not match the managed request.",
    );
  }
  if (
    isPathWithin(journalRoot, plan.materialization.root) ||
    isPathWithin(plan.materialization.root, journalRoot) ||
    plan.groups.some(
      (group) =>
        isPathWithin(journalRoot, group.canonicalTargetPath) ||
        isPathWithin(group.canonicalTargetPath, journalRoot),
    )
  ) {
    throw new ManagedRestoreError(
      "preflight",
      "continuity.restore.plan_mismatch",
      "quarantine",
      "Continuity restore journal root overlaps its source or a publication root.",
    );
  }
  const files = flattenPlanFiles(plan.groups);
  await runManagedPhase("preflight", "continuity.restore.plan_mismatch", async () => {
    await assertPublicationParents(plan.groups);
  });
  const restoreDirectory = path.join(journalRoot, sha256Hex(request.authority.restoreIdentity));
  const intentPath = path.join(restoreDirectory, "intent.json");
  const receiptPath = path.join(restoreDirectory, "receipt.json");
  const intent = {
    schemaVersion: 1,
    recordType: "continuity-restore-intent",
    authority: request.authority,
    artifact: plan.artifact,
    materialization: plan.materialization,
    authorization: plan.authorization,
    planId: plan.planId,
    receiptPath,
    groups: plan.groups.map((group) => ({
      rootComponentId: group.rootComponentId,
      canonicalTargetPath: group.canonicalTargetPath,
      targetKind: group.targetKind,
    })),
  } as const;
  const intentRecordIdentity = await runManagedPhase(
    "journal",
    "continuity.restore.journal_conflict",
    async () => {
      const restoreDirectoryExists = await pathExists(restoreDirectory);
      if (restoreDirectoryExists) {
        return await requireExactRecord(intentPath, intent);
      }
      const existingRoot = (
        await Promise.all(
          plan.groups.map(async (group) => ({
            group,
            exists: await pathExists(group.canonicalTargetPath),
          })),
        )
      ).find((entry) => entry.exists);
      if (existingRoot) {
        throw new ManagedRestoreError(
          "preflight",
          "continuity.restore.target_unattributed",
          "quarantine",
          `Continuity restore target already exists without intent: ${existingRoot.group.canonicalTargetPath}`,
        );
      }
      await fs.mkdir(restoreDirectory, { mode: 0o700 });
      await syncDirectoryEntry(journalRoot);
      return await writeNewRecord(intentPath, intent);
    },
  );

  await runManagedPhase("claim", "continuity.restore.target_unattributed", async () => {
    for (const group of plan.groups) {
      if (group.targetKind === "directory") {
        await claimDirectoryRoot(request, plan.planId, intentRecordIdentity, group);
        for (const member of group.members) {
          if (member.targetKind === "directory") {
            await ensureDirectoryPath(member.targetRelativePath, group);
          }
        }
      } else if ((group.files?.length ?? 0) !== 1) {
        throw new ManagedRestoreError(
          "claim",
          "continuity.restore.plan_mismatch",
          "quarantine",
          "Continuity restore file root must contain exactly one file.",
        );
      }
    }
  });

  let committedFiles = 0;
  for (const group of plan.groups) {
    for (const file of group.files ?? []) {
      await runManagedPhase("assembly", "continuity.restore.target_identity_mismatch", async () => {
        await copyOrVerifyFile(file, group);
      });
      committedFiles += 1;
      await hooks.afterFileCommitted?.(committedFiles);
    }
  }
  await runManagedPhase("verify", "continuity.restore.target_identity_mismatch", async () => {
    for (const file of files) {
      await verifyExactFile(file.canonicalTargetPath, file);
    }
    await verifyTargetGroups(plan.groups);
  });
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const verified = {
    schemaVersion: 1,
    recordType: "continuity-restore-verified",
    intentRecordIdentity,
    planId: plan.planId,
    targetRootCount: plan.groups.length,
    fileCount: files.length,
    totalBytes,
    fileInventoryIdentity: `sha256:${sha256Hex(
      JSON.stringify(
        files.map((file) => ({
          archivePath: file.archivePath,
          sha256: file.sha256,
          size: file.size,
          executable: file.executable,
          canonicalTargetPath: file.canonicalTargetPath,
        })),
      ),
    )}`,
  } as const;
  const receiptBase = {
    schemaVersion: 1,
    artifactType: "continuity-restore",
    authority: request.authority,
    planId: plan.planId,
    artifact: plan.artifact,
    materialization: plan.materialization,
    authorization: plan.authorization,
    intentRecordIdentity,
    targetRootCount: plan.groups.length,
    fileCount: files.length,
    totalBytes,
  } as const;
  const { receiptIdentity, committedRecordIdentity } = await runManagedPhase(
    "journal",
    "continuity.restore.journal_conflict",
    async () => {
      const verifiedRecordIdentity = await writeOrRequireRecord(
        path.join(restoreDirectory, "verified.json"),
        verified,
      );
      const committedReceipt = { ...receiptBase, verifiedRecordIdentity };
      const writtenReceiptIdentity = await writeOrRequireRecord(receiptPath, committedReceipt);
      const committed = {
        schemaVersion: 1,
        recordType: "continuity-restore-committed",
        intentRecordIdentity,
        verifiedRecordIdentity,
        receiptIdentity: writtenReceiptIdentity,
      } as const;
      const writtenCommittedRecordIdentity = await writeOrRequireRecord(
        path.join(restoreDirectory, "committed.json"),
        committed,
      );
      return {
        receiptIdentity: writtenReceiptIdentity,
        committedRecordIdentity: writtenCommittedRecordIdentity,
      };
    },
  );
  return {
    version: RESULT_VERSION,
    ok: true,
    ownerGeneration: request.authority.ownerGeneration,
    holdRevision: request.authority.holdRevision,
    restoreIdentity: request.authority.restoreIdentity,
    executionIncarnationIdentity: request.authority.executionIncarnationIdentity,
    planId: plan.planId,
    receiptIdentity,
    receiptPath,
    committedRecordIdentity,
    targetRootCount: plan.groups.length,
    fileCount: files.length,
  };
}

function failureResult(
  request: Pick<ManagedRestoreRequest, "authority"> | undefined,
  error: ManagedRestoreError,
): ManagedRestoreFailure {
  return {
    version: RESULT_VERSION,
    ok: false,
    restoreIdentity: request?.authority.restoreIdentity ?? "unavailable",
    executionIncarnationIdentity: request?.authority.executionIncarnationIdentity ?? "unavailable",
    phase: error.phase,
    code: error.code,
    disposition: error.disposition,
  };
}

export function managedRestoreRequestFailure(
  runtime: RuntimeEnv,
  error: unknown,
  options: { json?: boolean } = {},
): ManagedRestoreFailure {
  const result = failureResult(
    undefined,
    new ManagedRestoreError(
      "request",
      "continuity.restore.request_invalid",
      "quarantine",
      "Continuity restore execution request is invalid.",
      { cause: error },
    ),
  );
  if (options.json !== false) {
    writeRuntimeJson(runtime, result);
  }
  runtime.exit(1);
  return result;
}

export async function backupActivateManagedCommand(
  runtime: RuntimeEnv,
  rawRequest: string,
  options: { json?: boolean; hooks?: ManagedRestoreExecutionHooks } = {},
): Promise<ManagedRestoreResult> {
  let request: ManagedRestoreRequest;
  try {
    request = parseManagedRestoreRequest(rawRequest);
  } catch (error) {
    return managedRestoreRequestFailure(runtime, error, options);
  }
  let result: ManagedRestoreResult;
  try {
    result = await executeManagedRestore(request, options.hooks);
  } catch (error) {
    if (!(error instanceof ManagedRestoreError)) {
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

export async function readManagedRestoreRequestFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Continuity restore execution request is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
