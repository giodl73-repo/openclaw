import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContinuityArchiveObligations } from "../continuity/archive-obligations.js";
import {
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  normalizeContinuityPublicationProviderIdV1,
  parseContinuityPublicationAcceptanceReceiptV1,
  parseContinuityPublicationIdentityV1,
  type ContinuityPublicationAcceptanceReceiptV1,
  type ContinuityPublicationIdentityV1,
} from "../continuity/publication-provider.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { type FileLockOptions, withFileLock } from "../infra/file-lock.js";
import {
  ensureDurableDirectoryTree,
  syncDirectoryEntry,
  syncFileContent,
} from "../infra/fs-durability.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { isRecord } from "../utils.js";
import {
  materializeContinuityArchive,
  type BackupMaterializeResult,
} from "./backup-materialize.js";
import { planContinuityRestore, type BackupPlanRestoreResult } from "./backup-plan-restore.js";
import {
  executeManagedPublicationRetrieval,
  type ManagedPublicationHooks,
  type ManagedPublicationRetrievalRequest,
} from "./backup-publish-managed.js";
import { verifyBackupArchive, type VerifiedBackupArchive } from "./backup-verify.js";

const REQUEST_VERSION = "continuity-managed-preparation/v1";
const RESULT_VERSION = "continuity-managed-preparation-result/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 4096;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MATERIALIZATION_PUBLICATION_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 60,
    factor: 1.2,
    minTimeout: 50,
    maxTimeout: 1_000,
    randomize: true,
  },
  stale: 24 * 60 * 60 * 1_000,
  staleRecovery: "fail-closed",
};
const MATERIALIZATION_PUBLICATION_QUEUES = new Map<string, StoreWriterQueue>();

export type ManagedPreparationRequest = {
  version: typeof REQUEST_VERSION;
  authority: {
    ownerId: string;
    ownerGeneration: string;
    preparationIdentity: string;
    executionIncarnationIdentity: string;
  };
  identity: ContinuityPublicationIdentityV1;
  provider: {
    pluginId: string;
    id: string;
    version: typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION;
    generation: string;
  };
  acceptance: ContinuityPublicationAcceptanceReceiptV1;
  destination: {
    archivePath: string;
    materializedRoot: string;
  };
  policy: {
    authorizedPublicationRoots: string[];
  };
  journalRoot: string;
};

export type ManagedPreparationSuccess = {
  version: typeof RESULT_VERSION;
  ok: true;
  authority: ManagedPreparationRequest["authority"];
  archivePath: string;
  archiveSha256: string;
  manifestSha256: string;
  materializedRoot: string;
  materializationReceiptSha256: string;
  expectedPlanId: string;
  continuityObligations: ContinuityArchiveObligations;
};

export type ManagedPreparationFailureCode =
  | "continuity.preparation.request_invalid"
  | "continuity.preparation.journal_conflict"
  | "continuity.preparation.journal_unavailable"
  | "continuity.preparation.retrieval_unavailable"
  | "continuity.preparation.retrieval_resource_exhausted"
  | "continuity.preparation.retrieval_corrupt"
  | "continuity.preparation.retrieval_stale"
  | "continuity.preparation.materialization_resource_exhausted"
  | "continuity.preparation.materialization_failed"
  | "continuity.preparation.materialization_unavailable"
  | "continuity.preparation.plan_mismatch";

export type ManagedPreparationFailure = {
  version: typeof RESULT_VERSION;
  ok: false;
  preparationIdentity: string;
  executionIncarnationIdentity: string;
  phase: "request" | "journal" | "retrieval" | "materialization" | "plan";
  code: ManagedPreparationFailureCode;
  disposition: "hold" | "retry-same-preparation" | "quarantine";
};

export type ManagedPreparationResult = ManagedPreparationSuccess | ManagedPreparationFailure;

export type ManagedPreparationHooks = {
  publication?: ManagedPublicationHooks;
  retrieve?: (
    request: ManagedPublicationRetrievalRequest,
    destinationPath: string,
  ) => Promise<void>;
  verifyArchive?: (archivePath: string) => Promise<VerifiedBackupArchive>;
  materialize?: (params: {
    archive: string;
    destination: string;
  }) => Promise<BackupMaterializeResult>;
  syncArchiveDirectory?: (directoryPath: string) => Promise<void>;
  syncJournalDirectory?: (directoryPath: string) => Promise<void>;
  syncDirectory?: (directoryPath: string) => Promise<void>;
  plan?: (params: {
    archive: string;
    materialized: string;
    authorize: string[];
    requireContentInventory: true;
  }) => Promise<BackupPlanRestoreResult>;
};

class ManagedPreparationError extends Error {
  constructor(
    public readonly phase: ManagedPreparationFailure["phase"],
    public readonly code: ManagedPreparationFailureCode,
    public readonly disposition: ManagedPreparationFailure["disposition"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedPreparationError";
  }
}

function expectExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(record).find((key) => !expected.includes(key));
  if (unexpected || Object.keys(record).length !== expected.length) {
    throw new Error(`${label} contains an unknown or missing field.`);
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

function readIdentifier(
  record: Record<string, unknown>,
  key: string,
  label: string,
  pattern = IDENTIFIER_PATTERN,
): string {
  const value = record[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label}.${key} is invalid.`);
  }
  return value;
}

function readAbsolutePath(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw new Error(`${label}.${key} must be a normalized absolute path.`);
  }
  return value;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftRoot = path.parse(left).root;
  const rightRoot = path.parse(right).root;
  if (process.platform === "win32" && leftRoot.toLowerCase() !== rightRoot.toLowerCase()) {
    return false;
  }
  const relative = path.relative(left, right);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..") ||
    (() => {
      const reverse = path.relative(right, left);
      return reverse === "" || (!reverse.startsWith(`..${path.sep}`) && reverse !== "..");
    })()
  );
}

function identitiesEqual(
  left: ContinuityPublicationIdentityV1,
  right: ContinuityPublicationIdentityV1,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.sourceRuntimeGeneration === right.sourceRuntimeGeneration &&
    left.handoffId === right.handoffId &&
    left.captureId === right.captureId &&
    left.archiveSha256 === right.archiveSha256 &&
    left.manifestSha256 === right.manifestSha256 &&
    left.archiveSize === right.archiveSize
  );
}

export function parseManagedPreparationRequest(raw: string): ManagedPreparationRequest {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    throw new Error("Continuity managed preparation request is too large.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Continuity managed preparation request must be an object.");
  }
  expectExactKeys(
    parsed,
    [
      "version",
      "authority",
      "identity",
      "provider",
      "acceptance",
      "destination",
      "policy",
      "journalRoot",
    ],
    "Request",
  );
  if (parsed.version !== REQUEST_VERSION) {
    throw new Error("Continuity managed preparation request version is unsupported.");
  }

  const authority = readRecord(parsed, "authority", "Request");
  expectExactKeys(
    authority,
    ["ownerId", "ownerGeneration", "preparationIdentity", "executionIncarnationIdentity"],
    "Authority",
  );
  const provider = readRecord(parsed, "provider", "Request");
  expectExactKeys(provider, ["pluginId", "id", "version", "generation"], "Provider");
  const destination = readRecord(parsed, "destination", "Request");
  expectExactKeys(destination, ["archivePath", "materializedRoot"], "Destination");
  const policy = readRecord(parsed, "policy", "Request");
  expectExactKeys(policy, ["authorizedPublicationRoots"], "Policy");
  const identityRecord = readRecord(parsed, "identity", "Request");
  expectExactKeys(
    identityRecord,
    [
      "ownerId",
      "sourceRuntimeGeneration",
      "handoffId",
      "captureId",
      "archiveSha256",
      "manifestSha256",
      "archiveSize",
    ],
    "Identity",
  );
  const acceptanceRecord = readRecord(parsed, "acceptance", "Request");
  expectExactKeys(
    acceptanceRecord,
    [
      "version",
      "publicationId",
      "identity",
      "durabilityClass",
      "acceptedAt",
      "publicationPluginId",
      "publicationBindingId",
      "publicationBindingVersion",
      "publicationBindingGeneration",
    ],
    "Acceptance",
  );
  const acceptanceIdentity = readRecord(acceptanceRecord, "identity", "Acceptance");
  expectExactKeys(
    acceptanceIdentity,
    [
      "ownerId",
      "sourceRuntimeGeneration",
      "handoffId",
      "captureId",
      "archiveSha256",
      "manifestSha256",
      "archiveSize",
    ],
    "Acceptance.identity",
  );

  const providerId = normalizeContinuityPublicationProviderIdV1(provider.id);
  if (
    !providerId ||
    provider.id !== providerId ||
    provider.version !== CONTINUITY_PUBLICATION_PROVIDER_VERSION
  ) {
    throw new Error("Provider reference is unsupported.");
  }
  const roots = policy.authorizedPublicationRoots;
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 64) {
    throw new Error("Policy.authorizedPublicationRoots is invalid.");
  }
  const authorizedPublicationRoots = roots.map((root, index) => {
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.length > MAX_PATH_LENGTH ||
      !path.isAbsolute(root) ||
      path.normalize(root) !== root
    ) {
      throw new Error(`Policy.authorizedPublicationRoots[${index}] is invalid.`);
    }
    return root;
  });
  if (new Set(authorizedPublicationRoots).size !== authorizedPublicationRoots.length) {
    throw new Error("Policy.authorizedPublicationRoots contains duplicates.");
  }

  const parsedAuthority = {
    ownerId: readIdentifier(authority, "ownerId", "Authority", PREFIXED_SHA256_PATTERN),
    ownerGeneration: readIdentifier(authority, "ownerGeneration", "Authority"),
    preparationIdentity: readIdentifier(authority, "preparationIdentity", "Authority"),
    executionIncarnationIdentity: readIdentifier(
      authority,
      "executionIncarnationIdentity",
      "Authority",
      PREFIXED_SHA256_PATTERN,
    ),
  };
  for (const [label, value, pattern] of [
    ["Identity.ownerId", identityRecord.ownerId, PREFIXED_SHA256_PATTERN],
    [
      "Identity.sourceRuntimeGeneration",
      identityRecord.sourceRuntimeGeneration,
      IDENTIFIER_PATTERN,
    ],
    ["Identity.handoffId", identityRecord.handoffId, IDENTIFIER_PATTERN],
    ["Identity.captureId", identityRecord.captureId, IDENTIFIER_PATTERN],
    ["Acceptance.identity.ownerId", acceptanceIdentity.ownerId, PREFIXED_SHA256_PATTERN],
    [
      "Acceptance.identity.sourceRuntimeGeneration",
      acceptanceIdentity.sourceRuntimeGeneration,
      IDENTIFIER_PATTERN,
    ],
    ["Acceptance.identity.handoffId", acceptanceIdentity.handoffId, IDENTIFIER_PATTERN],
    ["Acceptance.identity.captureId", acceptanceIdentity.captureId, IDENTIFIER_PATTERN],
    ["Acceptance.publicationId", acceptanceRecord.publicationId, IDENTIFIER_PATTERN],
    ["Acceptance.publicationPluginId", acceptanceRecord.publicationPluginId, IDENTIFIER_PATTERN],
    [
      "Acceptance.publicationBindingGeneration",
      acceptanceRecord.publicationBindingGeneration,
      IDENTIFIER_PATTERN,
    ],
  ] as const) {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error(`${label} is invalid.`);
    }
  }
  const acceptanceProviderId = normalizeContinuityPublicationProviderIdV1(
    acceptanceRecord.publicationBindingId,
  );
  if (!acceptanceProviderId || acceptanceRecord.publicationBindingId !== acceptanceProviderId) {
    throw new Error("Acceptance.publicationBindingId is invalid.");
  }
  const identity = parseContinuityPublicationIdentityV1(identityRecord);
  const acceptance = parseContinuityPublicationAcceptanceReceiptV1(acceptanceRecord);
  for (const [label, value] of [
    ["Identity.archiveSha256", identityRecord.archiveSha256],
    ["Identity.manifestSha256", identityRecord.manifestSha256],
    ["Acceptance.identity.archiveSha256", acceptanceIdentity.archiveSha256],
    ["Acceptance.identity.manifestSha256", acceptanceIdentity.manifestSha256],
  ] as const) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new Error(`${label} is invalid.`);
    }
  }
  const parsedProvider = {
    pluginId: readIdentifier(provider, "pluginId", "Provider"),
    id: providerId,
    version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
    generation: readIdentifier(provider, "generation", "Provider"),
  };
  if (
    parsedAuthority.ownerId !== identity.ownerId ||
    parsedAuthority.ownerGeneration !== identity.sourceRuntimeGeneration ||
    !identitiesEqual(acceptance.identity, identity)
  ) {
    throw new Error("Managed preparation identities do not match.");
  }
  if (
    acceptance.publicationPluginId !== parsedProvider.pluginId ||
    acceptance.publicationBindingId !== parsedProvider.id ||
    acceptance.publicationBindingVersion !== parsedProvider.version ||
    acceptance.publicationBindingGeneration !== parsedProvider.generation
  ) {
    throw new Error("Managed preparation provider does not match acceptance.");
  }

  const archivePath = readAbsolutePath(destination, "archivePath", "Destination");
  const materializedRoot = readAbsolutePath(destination, "materializedRoot", "Destination");
  const journalRoot = readAbsolutePath(parsed, "journalRoot", "Request");
  if (
    pathsOverlap(archivePath, materializedRoot) ||
    pathsOverlap(archivePath, journalRoot) ||
    pathsOverlap(materializedRoot, journalRoot)
  ) {
    throw new Error("Managed preparation destination paths overlap.");
  }
  return {
    version: REQUEST_VERSION,
    authority: parsedAuthority,
    identity,
    provider: parsedProvider,
    acceptance,
    destination: { archivePath, materializedRoot },
    policy: { authorizedPublicationRoots },
    journalRoot,
  };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function writeNewRecord(
  filePath: string,
  value: unknown,
  syncDirectory: (directoryPath: string) => Promise<void>,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function requireExactRecord(filePath: string, value: unknown): Promise<void> {
  let actual: string;
  try {
    actual = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ManagedPreparationError(
      "journal",
      "continuity.preparation.journal_conflict",
      "quarantine",
      "Continuity preparation journal record is missing.",
      { cause: error },
    );
  }
  if (actual !== canonicalJson(value)) {
    throw new ManagedPreparationError(
      "journal",
      "continuity.preparation.journal_conflict",
      "quarantine",
      "Continuity preparation journal record conflicts.",
    );
  }
}

async function writeOrRequireRecord(
  filePath: string,
  value: unknown,
  syncDirectory: (directoryPath: string) => Promise<void> = syncDirectoryEntry,
): Promise<void> {
  try {
    await writeNewRecord(filePath, value, syncDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await requireExactRecord(filePath, value);
    await syncDirectory(path.dirname(filePath));
  }
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

async function canonicalizeProspectivePath(targetPath: string): Promise<string> {
  const suffix: string[] = [];
  let probe = targetPath;
  while (true) {
    try {
      const canonical = await fs.realpath(probe);
      return suffix.length === 0 ? canonical : path.join(canonical, ...suffix.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        return targetPath;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function assertCanonicalPathsDoNotOverlap(request: ManagedPreparationRequest): Promise<void> {
  const [archivePath, materializedRoot, journalRoot] = await Promise.all([
    canonicalizeProspectivePath(request.destination.archivePath),
    canonicalizeProspectivePath(request.destination.materializedRoot),
    canonicalizeProspectivePath(request.journalRoot),
  ]);
  if (
    pathsOverlap(archivePath, materializedRoot) ||
    pathsOverlap(archivePath, journalRoot) ||
    pathsOverlap(materializedRoot, journalRoot)
  ) {
    throw new ManagedPreparationError(
      "plan",
      "continuity.preparation.plan_mismatch",
      "quarantine",
      "Continuity preparation paths overlap through a filesystem alias.",
    );
  }
}

function findErrnoCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      return code;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
    pending.push((current as Error).cause);
  }
  return undefined;
}

function classifyRetrievalError(error: unknown): ManagedPreparationError {
  const code = (error as { code?: unknown } | undefined)?.code;
  const causeCode = (error as { causeCode?: unknown } | undefined)?.causeCode;
  if (code === "continuity.publication.resource_exhausted" || findErrnoCode(error) === "ENOSPC") {
    return new ManagedPreparationError(
      "retrieval",
      "continuity.preparation.retrieval_resource_exhausted",
      "hold",
      "Continuity preparation retrieval exhausted destination resources.",
      { cause: error },
    );
  }
  if (
    code === "continuity.publication.retrieval_corrupt" ||
    code === "invalid-retrieval" ||
    causeCode === "corrupt-retrieval" ||
    causeCode === "invalid-retrieval"
  ) {
    return new ManagedPreparationError(
      "retrieval",
      "continuity.preparation.retrieval_corrupt",
      "quarantine",
      "Continuity preparation retrieval is corrupt.",
      { cause: error },
    );
  }
  if (
    code === "continuity.publication.provider_stale" ||
    code === "stale-provider-generation" ||
    code === "provider-provenance-mismatch" ||
    code === "provider-incompatible" ||
    code === "provider-ambiguous" ||
    causeCode === "stale-provider-generation" ||
    causeCode === "provider-provenance-mismatch" ||
    causeCode === "provider-incompatible" ||
    causeCode === "provider-ambiguous"
  ) {
    return new ManagedPreparationError(
      "retrieval",
      "continuity.preparation.retrieval_stale",
      "quarantine",
      "Continuity preparation retrieval provider is stale.",
      { cause: error },
    );
  }
  return new ManagedPreparationError(
    "retrieval",
    "continuity.preparation.retrieval_unavailable",
    "retry-same-preparation",
    "Continuity preparation retrieval is unavailable.",
    { cause: error },
  );
}

async function verifyExactArchive(
  request: ManagedPreparationRequest,
  verifyArchive: NonNullable<ManagedPreparationHooks["verifyArchive"]>,
): Promise<VerifiedBackupArchive> {
  const stat = await fs.lstat(request.destination.archivePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size !== request.identity.archiveSize ||
    (await sha256File(request.destination.archivePath)) !== request.identity.archiveSha256
  ) {
    throw new ManagedPreparationError(
      "retrieval",
      "continuity.preparation.retrieval_corrupt",
      "quarantine",
      "Continuity preparation archive identity is invalid.",
    );
  }
  let verified: VerifiedBackupArchive;
  try {
    verified = await verifyArchive(request.destination.archivePath);
  } catch (error) {
    throw new ManagedPreparationError(
      "retrieval",
      "continuity.preparation.retrieval_corrupt",
      "quarantine",
      "Continuity preparation archive verification failed.",
      { cause: error },
    );
  }
  if (
    verified.result.artifactType !== "continuity" ||
    verified.result.archiveSha256 !== request.identity.archiveSha256 ||
    verified.result.manifestSha256 !== request.identity.manifestSha256 ||
    !verified.manifest.continuityObligations
  ) {
    throw new ManagedPreparationError(
      "retrieval",
      "continuity.preparation.retrieval_corrupt",
      "quarantine",
      "Continuity preparation archive evidence is invalid.",
    );
  }
  return verified;
}

function retrievalRequest(request: ManagedPreparationRequest): ManagedPublicationRetrievalRequest {
  return {
    version: "continuity-managed-publication-retrieval/v1",
    ownerId: request.authority.ownerId,
    identity: request.identity,
    provider: request.provider,
    acceptance: request.acceptance,
  };
}

async function prepareArchive(
  request: ManagedPreparationRequest,
  hooks: ManagedPreparationHooks,
): Promise<VerifiedBackupArchive> {
  const verifyArchive =
    hooks.verifyArchive ??
    (async (archivePath) => await verifyBackupArchive({ archive: archivePath }));
  try {
    await ensureDurableDirectoryTree(path.dirname(request.destination.archivePath), {
      allowExistingSymlink: true,
      mode: 0o700,
    });
    if (!(await pathExists(request.destination.archivePath))) {
      if (hooks.retrieve) {
        await hooks.retrieve(retrievalRequest(request), request.destination.archivePath);
      } else {
        await executeManagedPublicationRetrieval(retrievalRequest(request), hooks.publication, {
          destinationPath: request.destination.archivePath,
        });
      }
    }
  } catch (error) {
    throw classifyRetrievalError(error);
  }
  try {
    const verified = await verifyExactArchive(request, verifyArchive);
    try {
      await (hooks.syncArchiveDirectory ?? syncDirectoryEntry)(
        path.dirname(request.destination.archivePath),
      );
    } catch (error) {
      throw new ManagedPreparationError(
        "retrieval",
        "continuity.preparation.retrieval_unavailable",
        "hold",
        "Continuity preparation archive exists but could not be committed durably.",
        { cause: error },
      );
    }
    return verified;
  } catch (error) {
    if (error instanceof ManagedPreparationError) {
      throw error;
    }
    throw classifyRetrievalError(error);
  }
}

async function syncMaterializedTree(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Materialized continuity tree contains a symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await syncMaterializedTree(entryPath);
    }
  }
  await syncDirectoryEntry(root);
}

async function prepareMaterialization(
  request: ManagedPreparationRequest,
  hooks: ManagedPreparationHooks,
): Promise<void> {
  const parent = path.dirname(request.destination.materializedRoot);
  const temporaryRoot = path.join(
    parent,
    `.${path.basename(request.destination.materializedRoot)}.${randomUUID()}.tmp`,
  );
  try {
    await ensureDurableDirectoryTree(parent, {
      allowExistingSymlink: true,
      mode: 0o700,
    });
    if (await pathExists(request.destination.materializedRoot)) {
      const incompleteMarker = path.join(
        request.destination.materializedRoot,
        ".openclaw-materialize-incomplete",
      );
      if (await pathExists(incompleteMarker)) {
        const rootStat = await fs.lstat(request.destination.materializedRoot);
        const marker = await fs.readFile(incompleteMarker, "utf8");
        if (
          rootStat.isSymbolicLink() ||
          !rootStat.isDirectory() ||
          marker !== `${request.identity.archiveSha256}\n`
        ) {
          throw new ManagedPreparationError(
            "materialization",
            "continuity.preparation.materialization_failed",
            "quarantine",
            "Existing continuity materialization is incomplete or conflicting.",
          );
        }
        await fs.rm(request.destination.materializedRoot, { recursive: true });
        await syncDirectoryEntry(parent);
      } else {
        try {
          await syncFileContent(
            path.join(
              request.destination.materializedRoot,
              ".openclaw-continuity-materialization.json",
            ),
          );
          await syncMaterializedTree(request.destination.materializedRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ManagedPreparationError(
              "materialization",
              "continuity.preparation.materialization_failed",
              "quarantine",
              "Existing continuity materialization is missing its receipt.",
              { cause: error },
            );
          }
          throw new ManagedPreparationError(
            "materialization",
            "continuity.preparation.materialization_unavailable",
            "hold",
            "Existing continuity materialization could not be committed durably.",
            { cause: error },
          );
        }
        try {
          await (hooks.syncDirectory ?? syncDirectoryEntry)(parent);
        } catch (error) {
          throw new ManagedPreparationError(
            "materialization",
            "continuity.preparation.materialization_unavailable",
            "hold",
            "Continuity materialization exists but could not be committed durably.",
            { cause: error },
          );
        }
        return;
      }
    }
    await (hooks.materialize ?? materializeContinuityArchive)({
      archive: request.destination.archivePath,
      destination: temporaryRoot,
    });
    try {
      await syncFileContent(path.join(temporaryRoot, ".openclaw-continuity-materialization.json"));
      await syncMaterializedTree(temporaryRoot);
    } catch (error) {
      throw new ManagedPreparationError(
        "materialization",
        "continuity.preparation.materialization_unavailable",
        "hold",
        "Continuity materialization could not be committed durably.",
        { cause: error },
      );
    }
    try {
      await runQueuedStoreWrite({
        queues: MATERIALIZATION_PUBLICATION_QUEUES,
        storePath: request.destination.materializedRoot,
        label: "publishManagedContinuityMaterialization",
        fn: async () =>
          await withFileLock(
            request.destination.materializedRoot,
            MATERIALIZATION_PUBLICATION_LOCK_OPTIONS,
            async () => {
              if (!(await pathExists(request.destination.materializedRoot))) {
                await fs.rename(temporaryRoot, request.destination.materializedRoot);
              }
              await (hooks.syncDirectory ?? syncDirectoryEntry)(parent);
            },
          ),
      });
    } catch (error) {
      if (error instanceof ManagedPreparationError) {
        throw error;
      }
      throw new ManagedPreparationError(
        "materialization",
        "continuity.preparation.materialization_unavailable",
        "hold",
        "Continuity materialization could not be published durably.",
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof ManagedPreparationError) {
      throw error;
    }
    let failure = error;
    try {
      if (await pathExists(request.destination.materializedRoot)) {
        return;
      }
    } catch (resumeError) {
      failure = new AggregateError(
        [error, resumeError],
        "Continuity materialization and resume validation failed.",
      );
    }
    const resourceExhausted = findErrnoCode(failure) === "ENOSPC";
    throw new ManagedPreparationError(
      "materialization",
      resourceExhausted
        ? "continuity.preparation.materialization_resource_exhausted"
        : "continuity.preparation.materialization_failed",
      resourceExhausted ? "hold" : "quarantine",
      "Continuity preparation materialization failed.",
      { cause: failure },
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function preparePlan(
  request: ManagedPreparationRequest,
  hooks: ManagedPreparationHooks,
): Promise<BackupPlanRestoreResult> {
  try {
    return await (hooks.plan ?? planContinuityRestore)({
      archive: request.destination.archivePath,
      materialized: request.destination.materializedRoot,
      authorize: request.policy.authorizedPublicationRoots,
      requireContentInventory: true,
    });
  } catch (error) {
    throw new ManagedPreparationError(
      "plan",
      "continuity.preparation.plan_mismatch",
      "quarantine",
      "Continuity preparation restore plan validation failed.",
      { cause: error },
    );
  }
}

async function assertPlanTargetsDoNotOverlapPreparation(
  request: ManagedPreparationRequest,
  planned: BackupPlanRestoreResult,
): Promise<void> {
  const preparationPaths = await Promise.all([
    canonicalizeProspectivePath(request.destination.archivePath),
    canonicalizeProspectivePath(request.destination.materializedRoot),
    canonicalizeProspectivePath(request.journalRoot),
  ]);
  if (
    planned.plan.groups.some((group) =>
      preparationPaths.some((preparationPath) =>
        pathsOverlap(preparationPath, group.canonicalTargetPath),
      ),
    )
  ) {
    throw new ManagedPreparationError(
      "plan",
      "continuity.preparation.plan_mismatch",
      "quarantine",
      "Continuity preparation paths overlap an exact restore target.",
    );
  }
}

export async function executeManagedPreparation(
  request: ManagedPreparationRequest,
  hooks: ManagedPreparationHooks = {},
): Promise<ManagedPreparationSuccess> {
  try {
    await assertCanonicalPathsDoNotOverlap(request);
  } catch (error) {
    if (error instanceof ManagedPreparationError) {
      throw error;
    }
    throw new ManagedPreparationError(
      "plan",
      "continuity.preparation.plan_mismatch",
      "quarantine",
      "Continuity preparation path validation failed.",
      { cause: error },
    );
  }

  const operationDirectory = path.join(
    request.journalRoot,
    sha256Hex(request.authority.preparationIdentity),
  );
  const intent = {
    schemaVersion: 1,
    recordType: "continuity-managed-preparation-intent",
    request,
  } as const;
  try {
    await ensureDurableDirectoryTree(request.journalRoot, {
      mode: 0o700,
      requirePrivateExisting: true,
    });
    await ensureDurableDirectoryTree(operationDirectory, {
      mode: 0o700,
      requirePrivateExisting: true,
    });
    await writeOrRequireRecord(
      path.join(operationDirectory, "intent.json"),
      intent,
      hooks.syncJournalDirectory ?? syncDirectoryEntry,
    );
  } catch (error) {
    if (error instanceof ManagedPreparationError) {
      throw error;
    }
    throw new ManagedPreparationError(
      "journal",
      "continuity.preparation.journal_unavailable",
      "hold",
      "Continuity preparation intent could not be committed.",
      { cause: error },
    );
  }

  const verified = await prepareArchive(request, hooks);
  await prepareMaterialization(request, hooks);
  const planned = await preparePlan(request, hooks);
  await assertPlanTargetsDoNotOverlapPreparation(request, planned);
  const receiptPath = path.join(
    request.destination.materializedRoot,
    ".openclaw-continuity-materialization.json",
  );
  let materializationReceiptSha256: string;
  let canonicalMaterializedRoot: string;
  try {
    materializationReceiptSha256 = await sha256File(receiptPath);
    canonicalMaterializedRoot = await fs.realpath(request.destination.materializedRoot);
  } catch (error) {
    throw new ManagedPreparationError(
      "plan",
      "continuity.preparation.plan_mismatch",
      "quarantine",
      "Continuity preparation materialization receipt is unavailable.",
      { cause: error },
    );
  }
  if (
    planned.archivePath !== request.destination.archivePath ||
    planned.materializedRoot !== canonicalMaterializedRoot ||
    planned.plan.artifact.archiveSha256 !== request.identity.archiveSha256 ||
    planned.plan.artifact.manifestSha256 !== request.identity.manifestSha256 ||
    planned.plan.materialization.receiptSha256 !== materializationReceiptSha256
  ) {
    throw new ManagedPreparationError(
      "plan",
      "continuity.preparation.plan_mismatch",
      "quarantine",
      "Continuity preparation restore plan identities do not match.",
    );
  }
  const result: ManagedPreparationSuccess = {
    version: RESULT_VERSION,
    ok: true,
    authority: request.authority,
    archivePath: request.destination.archivePath,
    archiveSha256: request.identity.archiveSha256,
    manifestSha256: request.identity.manifestSha256,
    materializedRoot: request.destination.materializedRoot,
    materializationReceiptSha256,
    expectedPlanId: planned.plan.planId,
    continuityObligations: verified.manifest.continuityObligations!,
  };
  try {
    await writeOrRequireRecord(
      path.join(operationDirectory, "result.json"),
      result,
      hooks.syncJournalDirectory ?? syncDirectoryEntry,
    );
  } catch (error) {
    if (error instanceof ManagedPreparationError) {
      throw error;
    }
    throw new ManagedPreparationError(
      "journal",
      "continuity.preparation.journal_unavailable",
      "hold",
      "Continuity preparation result could not be committed.",
      { cause: error },
    );
  }
  return result;
}

function failureResult(
  request: Pick<ManagedPreparationRequest, "authority"> | undefined,
  error: ManagedPreparationError,
): ManagedPreparationFailure {
  return {
    version: RESULT_VERSION,
    ok: false,
    preparationIdentity: request?.authority.preparationIdentity ?? "unavailable",
    executionIncarnationIdentity: request?.authority.executionIncarnationIdentity ?? "unavailable",
    phase: error.phase,
    code: error.code,
    disposition: error.disposition,
  };
}

export function managedPreparationRequestFailure(
  runtime: RuntimeEnv,
  error: unknown,
): ManagedPreparationFailure {
  const result = failureResult(
    undefined,
    new ManagedPreparationError(
      "request",
      "continuity.preparation.request_invalid",
      "quarantine",
      "Continuity managed preparation request is invalid.",
      { cause: error },
    ),
  );
  writeRuntimeJson(runtime, result);
  runtime.exit(1);
  return result;
}

export async function backupPrepareManagedCommand(
  runtime: RuntimeEnv,
  rawRequest: string,
  hooks: ManagedPreparationHooks = {},
): Promise<ManagedPreparationResult> {
  let request: ManagedPreparationRequest;
  try {
    request = parseManagedPreparationRequest(rawRequest);
  } catch (error) {
    return managedPreparationRequestFailure(runtime, error);
  }
  let result: ManagedPreparationResult;
  try {
    result = await executeManagedPreparation(request, hooks);
  } catch (error) {
    if (!(error instanceof ManagedPreparationError)) {
      throw error;
    }
    result = failureResult(request, error);
  }
  writeRuntimeJson(runtime, result);
  if (!result.ok) {
    runtime.exit(1);
  }
  return result;
}

export async function readManagedPreparationRequestFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Continuity managed preparation request is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
