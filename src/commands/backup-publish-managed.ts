import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  ContinuityPublicationError,
  publishContinuityArtifactV1,
  retrieveContinuityArtifactV1,
  type ContinuityPublicationAcceptanceReceiptV1,
  type ContinuityPublicationIdentityV1,
  type ContinuityPublicationProviderReferenceV1,
  type ContinuityPublicationRetrievalV1,
} from "../continuity/publication-provider.js";
import { getCurrentHostIntegrationBundleSnapshotV1 } from "../hosting/host-integration-bundle.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord } from "../utils.js";
import { verifyBackupArchive, verifyBackupManifestIdentity } from "./backup-verify.js";

const REQUEST_VERSION = "continuity-managed-publication/v1";
const RESULT_VERSION = "continuity-managed-publication-result/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 4096;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LOBSTER_HOST_PLUGIN_ID = "lobster-host";
const LOBSTER_PROVIDER_ID = "lobster/continuity";

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
    id: typeof LOBSTER_PROVIDER_ID;
    version: typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION;
    generation: string;
    hostBundleIdentity: string;
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

type LoadRegistryParams = ManagedPublicationRuntimeContext & {
  onlyPluginIds: [typeof LOBSTER_HOST_PLUGIN_ID];
  cache: false;
};

export type ManagedPublicationHooks = {
  resolveRuntimeContext?: () => Promise<ManagedPublicationRuntimeContext>;
  loadRegistry?: (params: LoadRegistryParams) => PluginRegistry;
  startServices?: (params: {
    registry: PluginRegistry;
    config: OpenClawConfig;
    workspaceDir: string;
  }) => Promise<PluginServicesHandle>;
  resolveProviderReference?: (
    request: ManagedPublicationRequest,
  ) => ContinuityPublicationProviderReferenceV1;
  publish?: typeof publishContinuityArtifactV1;
  retrieve?: typeof retrieveContinuityArtifactV1;
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
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expectedSet.has(key)) ||
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Continuity publication request is not valid JSON.", { cause: error });
  }
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
  assertExactFields(provider, "Provider", ["id", "version", "generation", "hostBundleIdentity"]);
  if (
    provider.id !== LOBSTER_PROVIDER_ID ||
    provider.version !== CONTINUITY_PUBLICATION_PROVIDER_VERSION
  ) {
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
      id: LOBSTER_PROVIDER_ID,
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: readString(provider, "generation", "Provider", IDENTIFIER_PATTERN),
      hostBundleIdentity: readString(
        provider,
        "hostBundleIdentity",
        "Provider",
        IDENTIFIER_PATTERN,
      ),
    },
  };
}

async function resolveManagedPublicationRuntimeContext(): Promise<ManagedPublicationRuntimeContext> {
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

function loadManagedPublicationRegistry(params: LoadRegistryParams): PluginRegistry {
  return loadOpenClawPlugins({
    config: params.config,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: [...params.onlyPluginIds],
    cache: params.cache,
  });
}

async function startProviderSession(
  context: ManagedPublicationRuntimeContext,
  hooks: Required<Pick<ManagedPublicationHooks, "loadRegistry" | "startServices">>,
): Promise<{ registry: PluginRegistry; services: PluginServicesHandle }> {
  const registry = hooks.loadRegistry({
    ...context,
    onlyPluginIds: [LOBSTER_HOST_PLUGIN_ID],
    cache: false,
  });
  const services = await hooks.startServices({
    registry,
    config: context.config,
    workspaceDir: context.workspaceDir,
  });
  return { registry, services };
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0) {
      throw new Error("Continuity archive staging write made no progress.");
    }
    offset += result.bytesWritten;
  }
}

async function openVerifiedArchive(request: ManagedPublicationRequest): Promise<{
  handle: FileHandle;
  dispose: () => Promise<void>;
}> {
  let sourceHandle: FileHandle;
  try {
    const canonicalPath = await fs.realpath(request.receipt.archivePath);
    sourceHandle = await fs.open(canonicalPath, "r");
  } catch (error) {
    throw new ManagedPublicationError(
      "archive",
      "continuity.publication.archive_unavailable",
      "hold",
      "Continuity archive is unavailable.",
      undefined,
      { cause: error },
    );
  }
  let stagingDirectory: string | undefined;
  let stagedHandle: FileHandle | undefined;
  try {
    stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-source-"));
    const stagedArchivePath = path.join(stagingDirectory, "archive.tar.gz");
    stagedHandle = await fs.open(stagedArchivePath, "wx+", 0o600);
    const stat = await sourceHandle.stat();
    if (!stat.isFile() || stat.size !== request.receipt.archiveSize) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_identity_mismatch",
        "quarantine",
        "Continuity archive shape does not match the capture receipt.",
      );
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false, start: 0 })) {
      size += chunk.byteLength;
      if (!Number.isSafeInteger(size) || size > request.receipt.archiveSize) {
        throw new ManagedPublicationError(
          "archive",
          "continuity.publication.archive_identity_mismatch",
          "quarantine",
          "Continuity archive size changed during verification.",
        );
      }
      await writeAll(stagedHandle, chunk);
      hash.update(chunk);
    }
    await stagedHandle.sync();
    const after = await sourceHandle.stat();
    if (
      size !== request.receipt.archiveSize ||
      after.size !== stat.size ||
      hash.digest("hex") !== request.receipt.archiveSha256
    ) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_identity_mismatch",
        "quarantine",
        "Continuity archive bytes do not match the capture receipt.",
      );
    }
    try {
      await verifyBackupArchive(stagedArchivePath);
      await verifyBackupManifestIdentity(stagedArchivePath, request.receipt.manifestSha256);
    } catch (error) {
      throw new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_identity_mismatch",
        "quarantine",
        "Continuity archive manifest does not match the capture receipt.",
        undefined,
        { cause: error },
      );
    }
    return {
      handle: stagedHandle,
      dispose: async () => {
        await stagedHandle?.close();
        await fs.rm(stagingDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stagedHandle?.close();
    if (stagingDirectory) {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
    if (error instanceof ManagedPublicationError) {
      throw error;
    }
    throw new ManagedPublicationError(
      "archive",
      "continuity.publication.archive_unavailable",
      "hold",
      "Continuity archive verification failed.",
      undefined,
      { cause: error },
    );
  } finally {
    await sourceHandle.close();
  }
}

function resolveSessionProviderReference(
  request: ManagedPublicationRequest,
): ContinuityPublicationProviderReferenceV1 {
  const snapshot = getCurrentHostIntegrationBundleSnapshotV1();
  if (!snapshot) {
    throw new ContinuityPublicationError(
      "host-bundle-unavailable",
      "Continuity publication host bundle is unavailable",
    );
  }
  const identity = `${snapshot.id}@${snapshot.bundleVersion}`;
  if (identity !== request.provider.hostBundleIdentity) {
    throw new ContinuityPublicationError(
      "stale-host-bundle-generation",
      "Continuity publication host bundle identity is stale",
    );
  }
  return {
    id: request.provider.id,
    version: request.provider.version,
    generation: request.provider.generation,
    hostBundleGeneration: snapshot.generation,
  };
}

function providerFailureCode(error: unknown): string | undefined {
  if (error instanceof ContinuityPublicationError) {
    return error.code;
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function classifyProviderError(
  phase: "provider" | "retrieval",
  error: unknown,
): ManagedPublicationError {
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
      causeCode === "stale-host-bundle-generation" ||
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
    causeCode === "stale-host-bundle-generation" ||
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

function appendCleanupFailure(
  error: ManagedPublicationError,
  cleanupError: unknown,
): ManagedPublicationError {
  return new ManagedPublicationError(
    error.phase,
    error.code,
    error.disposition,
    error.message,
    error.causeCode,
    {
      cause: new AggregateError([error, cleanupError], `${error.message} Cleanup also failed.`),
    },
  );
}

async function consumeRetrieval(
  retrieval: ContinuityPublicationRetrievalV1,
  expectedManifestSha256: string,
): Promise<void> {
  const stagingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-continuity-retrieval-"),
  );
  const archivePath = path.join(stagingDirectory, "archive.tar.gz");
  let retrievalFailure: unknown;
  try {
    await pipeline(
      Readable.from(retrieval.content),
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    );
    try {
      await verifyBackupArchive(archivePath);
      await verifyBackupManifestIdentity(archivePath, expectedManifestSha256);
    } catch {
      throw new ContinuityPublicationError(
        "invalid-retrieval",
        "Continuity publication retrieval manifest is invalid",
      );
    }
  } catch (error) {
    retrievalFailure = error;
  }
  try {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!retrievalFailure) {
      throw cleanupError;
    }
    Object.defineProperty(retrievalFailure, "cause", {
      value: cleanupError,
      configurable: true,
    });
  }
  if (retrievalFailure) {
    throw retrievalFailure;
  }
}

export async function executeManagedPublication(
  request: ManagedPublicationRequest,
  hooks: ManagedPublicationHooks = {},
): Promise<ManagedPublicationSuccess> {
  const resolveRuntimeContext =
    hooks.resolveRuntimeContext ?? resolveManagedPublicationRuntimeContext;
  const loadRegistry = hooks.loadRegistry ?? loadManagedPublicationRegistry;
  const startServices = hooks.startServices ?? startPluginServices;
  const resolveProviderReference =
    hooks.resolveProviderReference ?? resolveSessionProviderReference;
  const publish = hooks.publish ?? publishContinuityArtifactV1;
  const retrieve = hooks.retrieve ?? retrieveContinuityArtifactV1;
  let context: ManagedPublicationRuntimeContext;
  try {
    context = await resolveRuntimeContext();
  } catch (error) {
    if (error instanceof ManagedPublicationError) {
      throw error;
    }
    throw classifyProviderError("provider", error);
  }

  const archive = await openVerifiedArchive(request);
  const identity: ContinuityPublicationIdentityV1 = {
    ownerId: request.receipt.ownerId,
    sourceRuntimeGeneration: request.receipt.ownerGeneration,
    handoffId: request.receipt.handoffIdentity,
    captureId: request.receipt.captureIdentity,
    archiveSha256: request.receipt.archiveSha256,
    manifestSha256: request.receipt.manifestSha256,
    archiveSize: request.receipt.archiveSize,
  };
  let acceptance: ContinuityPublicationAcceptanceReceiptV1;
  let archiveCleanupError: unknown;
  let publicationSession: Awaited<ReturnType<typeof startProviderSession>> | undefined;
  let publicationFailure: ManagedPublicationError | undefined;
  try {
    try {
      publicationSession = await startProviderSession(context, { loadRegistry, startServices });
      const providerReference = resolveProviderReference(request);
      acceptance = await publish({
        registry: publicationSession.registry,
        reference: providerReference,
        identity,
        content: archive.handle.createReadStream({ autoClose: false, start: 0 }),
        signal: new AbortController().signal,
      });
    } catch (error) {
      publicationFailure = classifyProviderError("provider", error);
      try {
        await publicationSession?.services.stop();
      } catch (cleanupError) {
        publicationFailure = appendCleanupFailure(publicationFailure, cleanupError);
      }
      publicationSession = undefined;
    }
  } catch (error) {
    publicationFailure =
      error instanceof ManagedPublicationError ? error : classifyProviderError("provider", error);
  }
  try {
    await archive.dispose();
  } catch (cleanupError) {
    if (publicationFailure) {
      publicationFailure = appendCleanupFailure(publicationFailure, cleanupError);
    } else {
      archiveCleanupError = cleanupError;
    }
  }
  if (publicationFailure) {
    throw publicationFailure;
  }

  let retrievalSession: Awaited<ReturnType<typeof startProviderSession>> | undefined;
  let retrievalFailure: ManagedPublicationError | undefined;
  try {
    retrievalSession = await startProviderSession(context, { loadRegistry, startServices });
    await publicationSession.services.stop();
    publicationSession = undefined;
    try {
      const providerReference = resolveProviderReference(request);
      const retrieval = await retrieve({
        registry: retrievalSession.registry,
        reference: providerReference,
        receipt: acceptance,
        signal: new AbortController().signal,
      });
      await consumeRetrieval(retrieval, request.receipt.manifestSha256);
    } catch (error) {
      retrievalFailure = classifyProviderError("retrieval", error);
    }
  } catch (error) {
    retrievalFailure =
      error instanceof ManagedPublicationError ? error : classifyProviderError("retrieval", error);
  }
  for (const session of [retrievalSession, publicationSession]) {
    try {
      await session?.services.stop();
    } catch (cleanupError) {
      const classifiedCleanup = classifyProviderError("retrieval", cleanupError);
      retrievalFailure = retrievalFailure
        ? appendCleanupFailure(retrievalFailure, cleanupError)
        : classifiedCleanup;
    }
  }
  if (archiveCleanupError) {
    try {
      await archive.dispose();
    } catch (retryError) {
      const cleanupFailure = new ManagedPublicationError(
        "archive",
        "continuity.publication.archive_unavailable",
        "hold",
        "Continuity archive cleanup failed.",
        undefined,
        { cause: new AggregateError([archiveCleanupError, retryError]) },
      );
      retrievalFailure = retrievalFailure
        ? appendCleanupFailure(retrievalFailure, cleanupFailure)
        : cleanupFailure;
    }
  }
  if (retrievalFailure) {
    throw retrievalFailure;
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
