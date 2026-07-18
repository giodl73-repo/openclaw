import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveContinuityPublicationProviderRuntimeV1,
  type ContinuityPublicationProviderRuntimeV1,
} from "../continuity/publication-provider-runtime.js";
import {
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  ContinuityPublicationError,
  normalizeContinuityPublicationProviderIdV1,
  parseContinuityPublicationAcceptanceReceiptV1,
  parseContinuityPublicationIdentityV1,
  publishContinuityArtifactV1,
  retrieveContinuityArtifactV1,
  type ContinuityPublicationAcceptanceReceiptV1,
  type ContinuityPublicationIdentityV1,
} from "../continuity/publication-provider.js";
import { sha256File } from "../infra/crypto-digest.js";
import { syncDirectoryEntry, syncFileContent } from "../infra/fs-durability.js";
import { startPluginServicesStrict, type PluginServicesHandle } from "../plugins/services.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord } from "../utils.js";
import { DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES, verifyBackupArchive } from "./backup-verify.js";

const REQUEST_VERSION = "continuity-managed-publication/v1";
const RESULT_VERSION = "continuity-managed-publication-result/v1";
const RETRIEVAL_REQUEST_VERSION = "continuity-managed-publication-retrieval/v1";
const RETRIEVAL_RESULT_VERSION = "continuity-managed-publication-retrieval-result/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 4096;
const PROVIDER_OPERATION_TIMEOUT_MS = 10 * 60 * 1000;
const RETRIEVAL_PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const SERVICE_STOP_TIMEOUT_MS = 30 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type ManagedPublicationRequest = {
  version: typeof REQUEST_VERSION;
  receipt: {
    ownerId: string;
    ownerGeneration: string;
    handoffIdentity: string;
    captureIdentity: string;
    executionIncarnationIdentity: string;
    archivePath: string;
    archiveSha256: string;
    archiveSize: number;
    manifestSha256: string;
  };
  provider: {
    pluginId: string;
    id: string;
    version: typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION;
    generation: string;
  };
};

export type ManagedPublicationSuccess = {
  version: typeof RESULT_VERSION;
  ok: true;
  ownerId: string;
  ownerGeneration: string;
  handoffIdentity: string;
  captureIdentity: string;
  executionIncarnationIdentity: string;
  acceptance: ContinuityPublicationAcceptanceReceiptV1;
};

export type ManagedPublicationFailureCode =
  | "continuity.publication.request_invalid"
  | "continuity.publication.archive_unavailable"
  | "continuity.publication.archive_identity_mismatch"
  | "continuity.publication.resource_exhausted"
  | "continuity.publication.provider_unavailable"
  | "continuity.publication.provider_outcome_unknown"
  | "continuity.publication.provider_conflict"
  | "continuity.publication.provider_stale"
  | "continuity.publication.provider_invalid"
  | "continuity.publication.retrieval_unavailable"
  | "continuity.publication.retrieval_corrupt";

export type ManagedPublicationFailure = {
  version: typeof RESULT_VERSION;
  ok: false;
  handoffIdentity: string;
  captureIdentity: string;
  executionIncarnationIdentity: string;
  phase: "request" | "archive" | "provider" | "retrieval";
  code: ManagedPublicationFailureCode;
  disposition: "hold" | "retry-same-publication" | "quarantine";
  causeCode?: string;
};

export type ManagedPublicationResult = ManagedPublicationSuccess | ManagedPublicationFailure;

type ManagedPublicationRuntimeContext = {
  config: OpenClawConfig;
  workspaceDir: string;
};

export type ManagedPublicationHooks = {
  operationTimeoutMs?: number;
  resolveRuntimeContext?: () => Promise<ManagedPublicationRuntimeContext>;
  resolveProviderRuntime?: (
    context: ManagedPublicationRuntimeContext,
  ) => ContinuityPublicationProviderRuntimeV1;
  startServices?: (params: {
    registry: ContinuityPublicationProviderRuntimeV1["registry"];
    config: OpenClawConfig;
    workspaceDir: string;
  }) => Promise<PluginServicesHandle>;
  publish?: typeof publishContinuityArtifactV1;
  retrieve?: typeof retrieveContinuityArtifactV1;
  runFreshRetrieval?: (params: {
    request: ManagedPublicationRequest;
    acceptance: ContinuityPublicationAcceptanceReceiptV1;
  }) => Promise<void>;
  syncDirectory?: (directoryPath: string) => Promise<void>;
};

export type ManagedPublicationRetrievalRequest = {
  version: typeof RETRIEVAL_REQUEST_VERSION;
  ownerId: string;
  identity: ContinuityPublicationIdentityV1;
  provider: ManagedPublicationRequest["provider"];
  acceptance: ContinuityPublicationAcceptanceReceiptV1;
};

type ManagedPublicationRetrievalResult =
  | {
      version: typeof RETRIEVAL_RESULT_VERSION;
      ok: true;
    }
  | {
      version: typeof RETRIEVAL_RESULT_VERSION;
      ok: false;
      code: ManagedPublicationFailureCode;
      disposition: ManagedPublicationFailure["disposition"];
      causeCode?: string;
    };

class ManagedPublicationError extends Error {
  constructor(
    public readonly phase: ManagedPublicationFailure["phase"],
    public readonly code: ManagedPublicationFailureCode,
    public readonly disposition: ManagedPublicationFailure["disposition"],
    message: string,
    public readonly causeCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedPublicationError";
  }
}

function assertExactFields(
  value: Record<string, unknown>,
  label: string,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expectedSet.has(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} contains unknown or missing fields.`);
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
  pattern: RegExp,
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

export function parseManagedPublicationRequest(raw: string): ManagedPublicationRequest {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    throw new Error("Continuity publication request is too large.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Continuity publication request must be an object.");
  }
  assertExactFields(parsed, "Request", ["version", "receipt", "provider"]);
  if (parsed.version !== REQUEST_VERSION) {
    throw new Error("Continuity publication request version is unsupported.");
  }
  const receipt = readRecord(parsed, "receipt", "Request");
  assertExactFields(receipt, "Receipt", [
    "ownerId",
    "ownerGeneration",
    "handoffIdentity",
    "captureIdentity",
    "executionIncarnationIdentity",
    "archivePath",
    "archiveSha256",
    "archiveSize",
    "manifestSha256",
  ]);
  if (!Number.isSafeInteger(receipt.archiveSize) || Number(receipt.archiveSize) < 0) {
    throw new Error("Receipt.archiveSize is invalid.");
  }
  const provider = readRecord(parsed, "provider", "Request");
  assertExactFields(provider, "Provider", ["pluginId", "id", "version", "generation"]);
  const providerId = normalizeContinuityPublicationProviderIdV1(provider.id);
  if (!providerId || provider.version !== CONTINUITY_PUBLICATION_PROVIDER_VERSION) {
    throw new Error("Provider reference is unsupported.");
  }
  return {
    version: REQUEST_VERSION,
    receipt: {
      ownerId: readString(receipt, "ownerId", "Receipt", PREFIXED_SHA256_PATTERN),
      ownerGeneration: readString(receipt, "ownerGeneration", "Receipt", IDENTIFIER_PATTERN),
      handoffIdentity: readString(receipt, "handoffIdentity", "Receipt", IDENTIFIER_PATTERN),
      captureIdentity: readString(receipt, "captureIdentity", "Receipt", IDENTIFIER_PATTERN),
      executionIncarnationIdentity: readString(
        receipt,
        "executionIncarnationIdentity",
        "Receipt",
        PREFIXED_SHA256_PATTERN,
      ),
      archivePath: readAbsolutePath(receipt, "archivePath", "Receipt"),
      archiveSha256: readString(receipt, "archiveSha256", "Receipt", SHA256_PATTERN),
      archiveSize: Number(receipt.archiveSize),
      manifestSha256: readString(receipt, "manifestSha256", "Receipt", SHA256_PATTERN),
    },
    provider: {
      pluginId: readString(provider, "pluginId", "Provider", IDENTIFIER_PATTERN),
      id: providerId,
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: readString(provider, "generation", "Provider", IDENTIFIER_PATTERN),
    },
  };
}

export function parseManagedPublicationRetrievalRequest(
  raw: string,
): ManagedPublicationRetrievalRequest {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    throw new Error("Continuity publication retrieval request is too large.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Continuity publication retrieval request must be an object.");
  }
  assertExactFields(parsed, "Request", [
    "version",
    "ownerId",
    "identity",
    "provider",
    "acceptance",
  ]);
  if (parsed.version !== RETRIEVAL_REQUEST_VERSION) {
    throw new Error("Continuity publication retrieval request version is unsupported.");
  }
  const provider = readRecord(parsed, "provider", "Request");
  assertExactFields(provider, "Provider", ["pluginId", "id", "version", "generation"]);
  const providerId = normalizeContinuityPublicationProviderIdV1(provider.id);
  if (!providerId || provider.version !== CONTINUITY_PUBLICATION_PROVIDER_VERSION) {
    throw new Error("Provider reference is unsupported.");
  }
  return {
    version: RETRIEVAL_REQUEST_VERSION,
    ownerId: readString(parsed, "ownerId", "Request", PREFIXED_SHA256_PATTERN),
    identity: parseContinuityPublicationIdentityV1(parsed.identity),
    provider: {
      pluginId: readString(provider, "pluginId", "Provider", IDENTIFIER_PATTERN),
      id: providerId,
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: readString(provider, "generation", "Provider", IDENTIFIER_PATTERN),
    },
    acceptance: parseContinuityPublicationAcceptanceReceiptV1(parsed.acceptance),
  };
}

async function resolveRuntimeContext(): Promise<ManagedPublicationRuntimeContext> {
  const snapshot = await readConfigFileSnapshot({ observe: false, isolateEnv: true });
  if (!snapshot.valid) {
    throw new ManagedPublicationError(
      "provider",
      "continuity.publication.provider_unavailable",
      "hold",
      "OpenClaw configuration is invalid.",
    );
  }
  const config = snapshot.runtimeConfig as OpenClawConfig;
  return {
    config,
    workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
  };
}

function providerFailureCode(error: unknown): string | undefined {
  if (error instanceof ContinuityPublicationError) {
    return error.code;
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function publicationIdentitiesEqual(
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

function classifyError(phase: "provider" | "retrieval", error: unknown): ManagedPublicationError {
  const causeCode = providerFailureCode(error);
  if (phase === "retrieval") {
    if (causeCode === "corrupt-retrieval" || causeCode === "invalid-retrieval") {
      return new ManagedPublicationError(
        phase,
        "continuity.publication.retrieval_corrupt",
        "quarantine",
        "Continuity publication retrieval is corrupt.",
        causeCode,
        { cause: error },
      );
    }
    if (
      causeCode === "stale-provider-generation" ||
      causeCode === "provider-provenance-mismatch" ||
      causeCode === "provider-incompatible"
    ) {
      return new ManagedPublicationError(
        phase,
        "continuity.publication.provider_stale",
        "quarantine",
        "Continuity publication provider reference is stale.",
        causeCode,
        { cause: error },
      );
    }
    return new ManagedPublicationError(
      phase,
      "continuity.publication.retrieval_unavailable",
      "hold",
      "Continuity publication retrieval is unavailable.",
      causeCode,
      { cause: error },
    );
  }
  if (causeCode === "conflict") {
    return new ManagedPublicationError(
      phase,
      "continuity.publication.provider_conflict",
      "quarantine",
      "Continuity publication conflicts with the committed handoff.",
      causeCode,
      { cause: error },
    );
  }
  if (causeCode === "outcome-unknown") {
    return new ManagedPublicationError(
      phase,
      "continuity.publication.provider_outcome_unknown",
      "hold",
      "Continuity publication commit outcome is unknown.",
      causeCode,
      { cause: error },
    );
  }
  if (
    causeCode === "stale-provider-generation" ||
    causeCode === "provider-provenance-mismatch" ||
    causeCode === "provider-incompatible" ||
    causeCode === "provider-ambiguous"
  ) {
    return new ManagedPublicationError(
      phase,
      "continuity.publication.provider_stale",
      "quarantine",
      "Continuity publication provider reference is stale.",
      causeCode,
      { cause: error },
    );
  }
  if (
    causeCode === "invalid-request" ||
    causeCode === "invalid-acceptance" ||
    causeCode === "provider-not-found"
  ) {
    return new ManagedPublicationError(
      phase,
      "continuity.publication.provider_invalid",
      "quarantine",
      "Continuity publication provider response is invalid.",
      causeCode,
      { cause: error },
    );
  }
  return new ManagedPublicationError(
    phase,
    "continuity.publication.provider_unavailable",
    causeCode === "retryable-before-commit" || causeCode === "unavailable"
      ? "retry-same-publication"
      : "hold",
    "Continuity publication provider is unavailable.",
    causeCode,
    { cause: error },
  );
}

async function stopProviderServices(
  services: PluginServicesHandle | undefined,
  phase: "provider" | "retrieval",
): Promise<void> {
  try {
    if (!services) {
      return;
    }
    await runWithTimeout({
      timeoutMs: SERVICE_STOP_TIMEOUT_MS,
      timeoutCode: "outcome-unknown",
      run: () => services.stop(),
    });
  } catch (error) {
    throw classifyError(phase, error);
  }
}

function retainCleanupError(primaryError: unknown, cleanupError: unknown): void {
  if (primaryError instanceof Error) {
    Object.defineProperty(primaryError, "cleanupError", {
      configurable: true,
      enumerable: false,
      value: cleanupError,
    });
  }
}

async function removeTemporaryDirectory(directory: string, primaryError?: unknown): Promise<void> {
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError === undefined) {
      throw cleanupError;
    }
    retainCleanupError(primaryError, cleanupError);
  }
}

async function runWithTimeout<T>(params: {
  timeoutMs: number;
  timeoutCode: "outcome-unknown" | "unavailable";
  run: (signal: AbortSignal) => Promise<T>;
  onLateResolve?: (value: T) => void | Promise<void>;
}): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutError = Object.assign(new Error("Continuity publication operation timed out"), {
    code: params.timeoutCode,
  });
  const operation = Promise.resolve().then(() => params.run(controller.signal));
  void operation.then(
    (value) => {
      if (!timedOut || !params.onLateResolve) {
        return;
      }
      void Promise.resolve(params.onLateResolve(value)).catch((error) => {
        retainCleanupError(timeoutError, error);
      });
    },
    (error) => {
      if (timedOut) {
        retainCleanupError(timeoutError, error);
      }
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError);
    }, params.timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function assertRequestedBinding(
  provider: ManagedPublicationRequest["provider"],
  runtime: ContinuityPublicationProviderRuntimeV1,
): void {
  const reference = runtime.reference;
  if (
    reference.pluginId !== provider.pluginId ||
    reference.id !== provider.id ||
    reference.version !== provider.version ||
    reference.generation !== provider.generation
  ) {
    throw new ContinuityPublicationError(
      "provider-provenance-mismatch",
      "Continuity publication provider does not match the frozen request",
    );
  }
}

async function pinAndVerifyArchive(request: ManagedPublicationRequest): Promise<{
  directory: string;
  archivePath: string;
}> {
  if (request.receipt.archiveSize > DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES) {
    throw new ManagedPublicationError(
      "archive",
      "continuity.publication.resource_exhausted",
      "hold",
      "Continuity archive exceeds the managed publication byte budget.",
    );
  }
  let directory: string | undefined;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-source-"));
    const archivePath = path.join(directory, "archive.tar.gz");
    const sourceStat = await fs.stat(request.receipt.archivePath);
    if (!sourceStat.isFile()) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_identity_mismatch",
        "quarantine",
        "Continuity archive source is not a regular file.",
      );
    }
    if (sourceStat.size > DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.resource_exhausted",
        "hold",
        "Continuity archive source exceeds the managed publication byte budget.",
      );
    }
    let copiedBytes = 0;
    await pipeline(
      createReadStream(request.receipt.archivePath),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          copiedBytes += chunk.byteLength;
          if (
            !Number.isSafeInteger(copiedBytes) ||
            copiedBytes > DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES
          ) {
            callback(
              new ManagedPublicationError(
                "archive",
                "continuity.publication.resource_exhausted",
                "hold",
                "Continuity archive copy exceeded the managed publication byte budget.",
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(archivePath, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    const stat = await fs.stat(archivePath);
    const digest = await sha256File(archivePath);
    if (
      !stat.isFile() ||
      stat.size !== request.receipt.archiveSize ||
      digest !== request.receipt.archiveSha256
    ) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_identity_mismatch",
        "quarantine",
        "Continuity archive bytes do not match the capture receipt.",
      );
    }
    const verified = await verifyBackupArchive({ archive: archivePath });
    if (verified.result.manifestSha256 !== request.receipt.manifestSha256) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_identity_mismatch",
        "quarantine",
        "Continuity archive manifest does not match the capture receipt.",
      );
    }
    return { directory, archivePath };
  } catch (error) {
    const classified =
      error instanceof ManagedPublicationError
        ? error
        : (error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC"
          ? new ManagedPublicationError(
              "archive",
              "continuity.publication.resource_exhausted",
              "hold",
              "Continuity archive pinning exceeded the temporary-disk budget.",
              "ENOSPC",
              { cause: error },
            )
          : new ManagedPublicationError(
              "archive",
              "continuity.publication.archive_unavailable",
              "hold",
              "Continuity archive verification failed.",
              undefined,
              { cause: error },
            );
    if (directory) {
      await removeTemporaryDirectory(directory, classified);
    }
    throw classified;
  }
}

async function verifyFreshRetrieval(params: {
  retrieval: Awaited<ReturnType<typeof retrieveContinuityArtifactV1>>;
  manifestSha256: string;
  destinationPath?: string;
  syncDirectory?: (directoryPath: string) => Promise<void>;
}): Promise<
  | {
      archivePath: string;
      archiveSha256: string;
      manifestSha256: string;
    }
  | undefined
> {
  let directory: string | undefined;
  let verificationFailure: unknown;
  let verificationFailed = false;
  let evidence:
    | {
        archivePath: string;
        archiveSha256: string;
        manifestSha256: string;
      }
    | undefined;
  try {
    const parentDirectory = params.destinationPath
      ? path.dirname(params.destinationPath)
      : os.tmpdir();
    directory = await fs.mkdtemp(path.join(parentDirectory, ".openclaw-continuity-retrieval-"));
    const archivePath = path.join(directory, "archive.tar.gz");
    await pipeline(
      Readable.from(params.retrieval.content),
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    );
    const verified = await verifyBackupArchive({ archive: archivePath });
    if (verified.result.manifestSha256 !== params.manifestSha256) {
      throw new Error("Continuity publication retrieval manifest does not match acceptance.");
    }
    if (params.destinationPath) {
      await syncFileContent(archivePath);
      try {
        await fs.link(archivePath, params.destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existingStat = await fs.lstat(params.destinationPath);
        const existing = await verifyBackupArchive({ archive: params.destinationPath });
        if (
          existingStat.isSymbolicLink() ||
          !existingStat.isFile() ||
          existingStat.size !== params.retrieval.identity.archiveSize ||
          existing.result.archiveSha256 !== params.retrieval.identity.archiveSha256 ||
          existing.result.manifestSha256 !== params.manifestSha256
        ) {
          throw new Error("Continuity publication retrieval destination conflicts.", {
            cause: error,
          });
        }
      }
      try {
        await (params.syncDirectory ?? syncDirectoryEntry)(parentDirectory);
      } catch (error) {
        throw new ManagedPublicationError(
          "retrieval",
          "continuity.publication.retrieval_unavailable",
          "hold",
          "Continuity publication retrieval destination could not be committed durably.",
          undefined,
          { cause: error },
        );
      }
      evidence = {
        archivePath: params.destinationPath,
        archiveSha256: verified.result.archiveSha256,
        manifestSha256: verified.result.manifestSha256,
      };
    }
  } catch (error) {
    verificationFailed = true;
    verificationFailure =
      error instanceof ManagedPublicationError
        ? error
        : (error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC"
          ? new ManagedPublicationError(
              "retrieval",
              "continuity.publication.resource_exhausted",
              "hold",
              "Continuity publication retrieval exceeded the temporary-disk budget.",
              "ENOSPC",
              { cause: error },
            )
          : Object.assign(
              new ContinuityPublicationError(
                "invalid-retrieval",
                "Continuity publication retrieval verification failed",
              ),
              { cause: error },
            );
  }
  if (directory) {
    await removeTemporaryDirectory(directory, verificationFailed ? verificationFailure : undefined);
  }
  if (verificationFailed) {
    throw verificationFailure;
  }
  return evidence;
}

export async function executeManagedPublicationRetrieval(
  request: ManagedPublicationRetrievalRequest,
  hooks: ManagedPublicationHooks = {},
  options: { destinationPath?: string } = {},
): Promise<
  | {
      archivePath: string;
      archiveSha256: string;
      manifestSha256: string;
    }
  | undefined
> {
  if (!publicationIdentitiesEqual(request.acceptance.identity, request.identity)) {
    throw new ContinuityPublicationError(
      "invalid-request",
      "Continuity publication acceptance does not match capture-time identity",
    );
  }
  const context = await (hooks.resolveRuntimeContext ?? resolveRuntimeContext)();
  const resolveProviderRuntime =
    hooks.resolveProviderRuntime ??
    ((runtimeContext) =>
      resolveContinuityPublicationProviderRuntimeV1({
        config: runtimeContext.config,
        workspaceDir: runtimeContext.workspaceDir,
      }));
  const startServices = hooks.startServices ?? startPluginServicesStrict;
  const retrieve = hooks.retrieve ?? retrieveContinuityArtifactV1;
  const operationTimeoutMs = hooks.operationTimeoutMs ?? PROVIDER_OPERATION_TIMEOUT_MS;
  let services: PluginServicesHandle | undefined;
  let retrievalFailure: unknown;
  let retrievalFailed = false;
  let evidence:
    | {
        archivePath: string;
        archiveSha256: string;
        manifestSha256: string;
      }
    | undefined;
  try {
    const runtime = resolveProviderRuntime(context);
    assertRequestedBinding(request.provider, runtime);
    services = await runWithTimeout({
      timeoutMs: operationTimeoutMs,
      timeoutCode: "unavailable",
      run: () =>
        startServices({
          registry: runtime.registry,
          config: context.config,
          workspaceDir: context.workspaceDir,
        }),
    });
    await runWithTimeout({
      timeoutMs: operationTimeoutMs,
      timeoutCode: "unavailable",
      run: async (signal) => {
        const retrieval = await retrieve({
          registry: runtime.registry,
          reference: runtime.reference,
          receipt: request.acceptance,
          expectedOwnerId: request.ownerId,
          signal,
        });
        evidence = await verifyFreshRetrieval({
          retrieval,
          manifestSha256: request.identity.manifestSha256,
          ...(options.destinationPath ? { destinationPath: options.destinationPath } : {}),
          ...(hooks.syncDirectory ? { syncDirectory: hooks.syncDirectory } : {}),
        });
      },
    });
  } catch (error) {
    retrievalFailed = true;
    retrievalFailure = error;
  }
  try {
    await stopProviderServices(services, "retrieval");
  } catch (error) {
    if (!retrievalFailed) {
      throw error;
    }
    retainCleanupError(retrievalFailure, error);
  }
  if (retrievalFailed) {
    throw retrievalFailure;
  }
  return evidence;
}

function buildCurrentCliArgv(args: string[]): string[] {
  const entry = process.argv[1]?.trim();
  if (!entry || entry === process.execPath) {
    throw new ManagedPublicationError(
      "retrieval",
      "continuity.publication.retrieval_unavailable",
      "hold",
      "OpenClaw CLI entrypoint is unavailable for fresh-process retrieval.",
    );
  }
  return [process.execPath, ...process.execArgv, entry, ...args];
}

function parseRetrievalProcessResult(raw: string): ManagedPublicationRetrievalResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.version !== RETRIEVAL_RESULT_VERSION) {
    throw new Error("Fresh retrieval process returned an invalid result.");
  }
  if (parsed.ok === true) {
    return { version: RETRIEVAL_RESULT_VERSION, ok: true };
  }
  if (
    parsed.ok !== false ||
    typeof parsed.code !== "string" ||
    (parsed.disposition !== "hold" &&
      parsed.disposition !== "retry-same-publication" &&
      parsed.disposition !== "quarantine")
  ) {
    throw new Error("Fresh retrieval process returned an invalid failure.");
  }
  return {
    version: RETRIEVAL_RESULT_VERSION,
    ok: false,
    code: parsed.code as ManagedPublicationFailureCode,
    disposition: parsed.disposition,
    ...(typeof parsed.causeCode === "string" ? { causeCode: parsed.causeCode } : {}),
  };
}

async function runFreshRetrievalProcess(params: {
  request: ManagedPublicationRequest;
  acceptance: ContinuityPublicationAcceptanceReceiptV1;
}): Promise<void> {
  const childRequest: ManagedPublicationRetrievalRequest = {
    version: RETRIEVAL_REQUEST_VERSION,
    ownerId: params.request.receipt.ownerId,
    identity: {
      ownerId: params.request.receipt.ownerId,
      sourceRuntimeGeneration: params.request.receipt.ownerGeneration,
      handoffId: params.request.receipt.handoffIdentity,
      captureId: params.request.receipt.captureIdentity,
      archiveSha256: params.request.receipt.archiveSha256,
      archiveSize: params.request.receipt.archiveSize,
      manifestSha256: params.request.receipt.manifestSha256,
    },
    provider: params.request.provider,
    acceptance: params.acceptance,
  };
  const child = await runCommandWithTimeout(
    buildCurrentCliArgv(["backup", "publish-retrieve", "--managed", "--json"]),
    {
      timeoutMs: RETRIEVAL_PROCESS_TIMEOUT_MS,
      input: JSON.stringify(childRequest),
      maxOutputBytes: MAX_REQUEST_BYTES,
      killProcessTree: true,
    },
  );
  if (child.termination !== "exit") {
    throw new ManagedPublicationError(
      "retrieval",
      "continuity.publication.retrieval_unavailable",
      "hold",
      "Fresh continuity retrieval process did not complete.",
      "outcome-unknown",
    );
  }
  let result: ManagedPublicationRetrievalResult;
  try {
    result = parseRetrievalProcessResult(child.stdout.trim());
  } catch (error) {
    throw new ManagedPublicationError(
      "retrieval",
      "continuity.publication.retrieval_unavailable",
      "hold",
      "Fresh continuity retrieval process returned invalid output.",
      undefined,
      { cause: error },
    );
  }
  if (!result.ok) {
    throw new ManagedPublicationError(
      "retrieval",
      result.code,
      result.disposition,
      "Fresh continuity retrieval process failed.",
      result.causeCode,
    );
  }
  if (child.code !== 0) {
    throw new ManagedPublicationError(
      "retrieval",
      "continuity.publication.retrieval_unavailable",
      "hold",
      "Fresh continuity retrieval process exited unsuccessfully.",
    );
  }
}

export async function executeManagedPublication(
  request: ManagedPublicationRequest,
  hooks: ManagedPublicationHooks = {},
): Promise<ManagedPublicationSuccess> {
  let context: ManagedPublicationRuntimeContext;
  try {
    context = await (hooks.resolveRuntimeContext ?? resolveRuntimeContext)();
  } catch (error) {
    if (error instanceof ManagedPublicationError) {
      throw error;
    }
    throw classifyError("provider", error);
  }
  const resolveProviderRuntime =
    hooks.resolveProviderRuntime ??
    ((runtimeContext) =>
      resolveContinuityPublicationProviderRuntimeV1({
        config: runtimeContext.config,
        workspaceDir: runtimeContext.workspaceDir,
      }));
  const startServices = hooks.startServices ?? startPluginServicesStrict;
  const publish = hooks.publish ?? publishContinuityArtifactV1;
  const operationTimeoutMs = hooks.operationTimeoutMs ?? PROVIDER_OPERATION_TIMEOUT_MS;
  const pinned = await pinAndVerifyArchive(request);
  const identity: ContinuityPublicationIdentityV1 = {
    ownerId: request.receipt.ownerId,
    sourceRuntimeGeneration: request.receipt.ownerGeneration,
    handoffId: request.receipt.handoffIdentity,
    captureId: request.receipt.captureIdentity,
    archiveSha256: request.receipt.archiveSha256,
    manifestSha256: request.receipt.manifestSha256,
    archiveSize: request.receipt.archiveSize,
  };

  let acceptance: ContinuityPublicationAcceptanceReceiptV1 | undefined;
  let operationFailure: unknown;
  let operationFailed = false;
  try {
    let sourceServices: PluginServicesHandle | undefined;
    let providerFailure: unknown;
    let providerFailed = false;
    try {
      const source = resolveProviderRuntime(context);
      assertRequestedBinding(request.provider, source);
      sourceServices = await runWithTimeout({
        timeoutMs: operationTimeoutMs,
        timeoutCode: "unavailable",
        run: () =>
          startServices({
            registry: source.registry,
            config: context.config,
            workspaceDir: context.workspaceDir,
          }),
        onLateResolve: (services) => stopProviderServices(services, "provider"),
      });
      acceptance = await runWithTimeout({
        timeoutMs: operationTimeoutMs,
        timeoutCode: "outcome-unknown",
        run: (signal) => {
          const content = createReadStream(pinned.archivePath, { signal });
          return publish({
            registry: source.registry,
            reference: source.reference,
            identity,
            content,
            signal,
          });
        },
      });
    } catch (error) {
      providerFailed = true;
      providerFailure =
        error instanceof ManagedPublicationError ? error : classifyError("provider", error);
    }
    try {
      await stopProviderServices(sourceServices, "provider");
    } catch (error) {
      if (!providerFailed) {
        throw error;
      }
      retainCleanupError(providerFailure, error);
    }
    if (providerFailed) {
      throw providerFailure;
    }
    if (!acceptance) {
      throw new ManagedPublicationError(
        "provider",
        "continuity.publication.provider_invalid",
        "quarantine",
        "Continuity publication provider returned no acceptance receipt.",
      );
    }

    try {
      await (hooks.runFreshRetrieval ?? runFreshRetrievalProcess)({
        request,
        acceptance,
      });
    } catch (error) {
      if (error instanceof ManagedPublicationError) {
        throw error;
      }
      throw classifyError("retrieval", error);
    }
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  await removeTemporaryDirectory(pinned.directory, operationFailed ? operationFailure : undefined);
  if (operationFailed) {
    throw operationFailure;
  }
  if (!acceptance) {
    throw new ManagedPublicationError(
      "provider",
      "continuity.publication.provider_invalid",
      "quarantine",
      "Continuity publication provider returned no acceptance receipt.",
    );
  }

  return {
    version: RESULT_VERSION,
    ok: true,
    ownerId: request.receipt.ownerId,
    ownerGeneration: request.receipt.ownerGeneration,
    handoffIdentity: request.receipt.handoffIdentity,
    captureIdentity: request.receipt.captureIdentity,
    executionIncarnationIdentity: request.receipt.executionIncarnationIdentity,
    acceptance,
  };
}

function failureResult(
  request: Pick<ManagedPublicationRequest, "receipt"> | undefined,
  error: ManagedPublicationError,
): ManagedPublicationFailure {
  return {
    version: RESULT_VERSION,
    ok: false,
    handoffIdentity: request?.receipt.handoffIdentity ?? "unavailable",
    captureIdentity: request?.receipt.captureIdentity ?? "unavailable",
    executionIncarnationIdentity: request?.receipt.executionIncarnationIdentity ?? "unavailable",
    phase: error.phase,
    code: error.code,
    disposition: error.disposition,
    ...(error.causeCode ? { causeCode: error.causeCode } : {}),
  };
}

export function managedPublicationRequestFailure(
  runtime: RuntimeEnv,
  error: unknown,
): ManagedPublicationFailure {
  const result = failureResult(
    undefined,
    new ManagedPublicationError(
      "request",
      "continuity.publication.request_invalid",
      "quarantine",
      "Continuity publication request is invalid.",
      undefined,
      { cause: error },
    ),
  );
  writeRuntimeJson(runtime, result);
  runtime.exit(1);
  return result;
}

export async function backupPublishManagedCommand(
  runtime: RuntimeEnv,
  rawRequest: string,
  options: { hooks?: ManagedPublicationHooks } = {},
): Promise<ManagedPublicationResult> {
  let request: ManagedPublicationRequest;
  try {
    request = parseManagedPublicationRequest(rawRequest);
  } catch (error) {
    return managedPublicationRequestFailure(runtime, error);
  }
  let result: ManagedPublicationResult;
  try {
    result = await executeManagedPublication(request, options.hooks);
  } catch (error) {
    if (!(error instanceof ManagedPublicationError)) {
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

export async function backupPublishManagedRetrievalCommand(
  runtime: RuntimeEnv,
  rawRequest: string,
  options: { hooks?: ManagedPublicationHooks } = {},
): Promise<ManagedPublicationRetrievalResult> {
  let request: ManagedPublicationRetrievalRequest;
  try {
    request = parseManagedPublicationRetrievalRequest(rawRequest);
  } catch {
    const result: ManagedPublicationRetrievalResult = {
      version: RETRIEVAL_RESULT_VERSION,
      ok: false,
      code: "continuity.publication.retrieval_corrupt",
      disposition: "quarantine",
      causeCode: "invalid-request",
    };
    writeRuntimeJson(runtime, result);
    runtime.exit(1);
    return result;
  }
  let result: ManagedPublicationRetrievalResult;
  try {
    await executeManagedPublicationRetrieval(request, options.hooks);
    result = { version: RETRIEVAL_RESULT_VERSION, ok: true };
  } catch (error) {
    const classified =
      error instanceof ManagedPublicationError ? error : classifyError("retrieval", error);
    result = {
      version: RETRIEVAL_RESULT_VERSION,
      ok: false,
      code: classified.code,
      disposition: classified.disposition,
      ...(classified.causeCode ? { causeCode: classified.causeCode } : {}),
    };
  }
  writeRuntimeJson(runtime, result);
  if (!result.ok) {
    runtime.exit(1);
  }
  return result;
}

export async function readManagedPublicationRequestFromStdin(
  input: AsyncIterable<Uint8Array | string> = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Continuity publication request is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
