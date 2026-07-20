import { createHash } from "node:crypto";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
  type ContinuityPublicationAcceptanceReceiptV1,
  type ContinuityPublicationIdentityV1,
  type ContinuityPublicationProviderAcceptanceV1,
  type ContinuityPublicationProviderFailureCode,
  type ContinuityPublicationProviderFailureV1,
  type ContinuityPublicationProviderReferenceV1,
  type ContinuityPublicationProviderV1,
  type ContinuityPublicationRetrievalV1,
} from "./publication-provider-contract.js";

export {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
} from "./publication-provider-contract.js";
export type {
  ContinuityPublicationAcceptanceReceiptV1,
  ContinuityPublicationIdentityV1,
  ContinuityPublicationProviderAcceptanceV1,
  ContinuityPublicationProviderFailureCode,
  ContinuityPublicationProviderFailureV1,
  ContinuityPublicationProviderReferenceV1,
  ContinuityPublicationProviderV1,
  ContinuityPublicationRetrievalV1,
} from "./publication-provider-contract.js";

export type ContinuityPublicationProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: ContinuityPublicationProviderV1;
  source: string;
  rootDir?: string;
};

export type ContinuityPublicationFailureCode =
  | "invalid-request"
  | "provider-not-found"
  | "provider-ambiguous"
  | "provider-incompatible"
  | "provider-provenance-mismatch"
  | "stale-provider-generation"
  | "invalid-acceptance"
  | "invalid-retrieval";

export class ContinuityPublicationError extends Error {
  readonly code: ContinuityPublicationFailureCode;

  constructor(code: ContinuityPublicationFailureCode, message: string) {
    super(message);
    this.name = "ContinuityPublicationError";
    this.code = code;
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,255}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

export function normalizeContinuityPublicationIdentifierV1(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return IDENTIFIER_RE.test(normalized) ? normalized : undefined;
}

export function normalizeContinuityPublicationProviderIdV1(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return PROVIDER_ID_RE.test(normalized) ? normalized : undefined;
}

export function normalizeContinuityPublicationProviderV1(
  value: unknown,
): ContinuityPublicationProviderV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeContinuityPublicationProviderIdV1(value.id);
  const generation = normalizeContinuityPublicationIdentifierV1(value.generation);
  if (
    !id ||
    value.version !== CONTINUITY_PUBLICATION_PROVIDER_VERSION ||
    !generation ||
    typeof value.publish !== "function" ||
    typeof value.retrieve !== "function"
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
    generation,
    publish: value.publish.bind(value),
    retrieve: value.retrieve.bind(value),
  });
}

function requireIdentifier(value: unknown, label: string): string {
  const normalized = normalizeContinuityPublicationIdentifierV1(value);
  if (!normalized) {
    throw new ContinuityPublicationError("invalid-request", `${label} is invalid`);
  }
  return normalized;
}

function requireProviderId(value: unknown): string {
  const normalized = normalizeContinuityPublicationProviderIdV1(value);
  if (!normalized) {
    throw new ContinuityPublicationError("invalid-request", "publicationBindingId is invalid");
  }
  return normalized;
}

function requireProviderVersion(value: unknown): typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION {
  if (value !== CONTINUITY_PUBLICATION_PROVIDER_VERSION) {
    throw new ContinuityPublicationError("invalid-request", "publicationBindingVersion is invalid");
  }
  return CONTINUITY_PUBLICATION_PROVIDER_VERSION;
}

function requireSha256(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_RE.test(normalized)) {
    throw new ContinuityPublicationError("invalid-request", `${label} is invalid`);
  }
  return normalized;
}

export function parseContinuityPublicationIdentityV1(
  identity: unknown,
): ContinuityPublicationIdentityV1 {
  if (!isRecord(identity)) {
    throw new ContinuityPublicationError("invalid-request", "identity is invalid");
  }
  const archiveSize = identity.archiveSize;
  if (typeof archiveSize !== "number" || !Number.isSafeInteger(archiveSize) || archiveSize < 0) {
    throw new ContinuityPublicationError("invalid-request", "archiveSize is invalid");
  }
  return Object.freeze({
    ownerId: requireIdentifier(identity.ownerId, "ownerId"),
    sourceRuntimeGeneration: requireIdentifier(
      identity.sourceRuntimeGeneration,
      "sourceRuntimeGeneration",
    ),
    handoffId: requireIdentifier(identity.handoffId, "handoffId"),
    captureId: requireIdentifier(identity.captureId, "captureId"),
    archiveSha256: requireSha256(identity.archiveSha256, "archiveSha256"),
    manifestSha256: requireSha256(identity.manifestSha256, "manifestSha256"),
    archiveSize,
  });
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

function corruptRetrieval(message: string): Error & ContinuityPublicationProviderFailureV1 {
  return Object.assign(new Error(message), {
    code: "corrupt-retrieval" as const,
  });
}

function validateRetrievedContent(
  content: AsyncIterable<Uint8Array>,
  identity: ContinuityPublicationIdentityV1,
): AsyncIterable<Uint8Array> {
  return (async function* () {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of content) {
      if (!(chunk instanceof Uint8Array)) {
        throw corruptRetrieval("Continuity publication retrieval returned an invalid chunk");
      }
      size += chunk.byteLength;
      if (!Number.isSafeInteger(size) || size > identity.archiveSize) {
        throw corruptRetrieval("Continuity publication retrieval size does not match acceptance");
      }
      hash.update(chunk);
      yield chunk;
    }
    if (size !== identity.archiveSize || hash.digest("hex") !== identity.archiveSha256) {
      throw corruptRetrieval("Continuity publication retrieval digest does not match acceptance");
    }
  })();
}

function validatePublishedContent(
  content: AsyncIterable<Uint8Array>,
  identity: ContinuityPublicationIdentityV1,
): {
  content: AsyncIterable<Uint8Array>;
  assertComplete: () => void;
} {
  let complete = false;
  const validated = (async function* () {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of content) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ContinuityPublicationError(
          "invalid-request",
          "Continuity publication content contains an invalid chunk",
        );
      }
      size += chunk.byteLength;
      if (!Number.isSafeInteger(size) || size > identity.archiveSize) {
        throw new ContinuityPublicationError(
          "invalid-request",
          "Continuity publication content exceeds the declared archive size",
        );
      }
      hash.update(chunk);
      yield chunk;
    }
    if (size !== identity.archiveSize || hash.digest("hex") !== identity.archiveSha256) {
      throw new ContinuityPublicationError(
        "invalid-request",
        "Continuity publication content does not match the declared archive identity",
      );
    }
    complete = true;
  })();
  return {
    content: validated,
    assertComplete: () => {
      if (!complete) {
        throw new ContinuityPublicationError(
          "invalid-acceptance",
          "Continuity publication provider accepted content without consuming the complete archive",
        );
      }
    },
  };
}

function requireAcceptedAt(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new ContinuityPublicationError("invalid-acceptance", "acceptedAt is invalid");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new ContinuityPublicationError("invalid-acceptance", "acceptedAt is invalid");
  }
  return value;
}

function requireImmutableDurabilityClass(value: unknown): "immutable" {
  if (value !== "immutable") {
    throw new ContinuityPublicationError(
      "invalid-acceptance",
      "Continuity publication durability class is invalid",
    );
  }
  return value;
}

function normalizeEvidenceIdentity(
  identity: unknown,
  failureCode: "invalid-acceptance" | "invalid-retrieval",
): ContinuityPublicationIdentityV1 {
  try {
    return parseContinuityPublicationIdentityV1(identity);
  } catch (error) {
    if (error instanceof ContinuityPublicationError) {
      throw new ContinuityPublicationError(failureCode, error.message);
    }
    throw error;
  }
}

function normalizeProviderAcceptance(
  value: unknown,
  expectedIdentity: ContinuityPublicationIdentityV1,
): ContinuityPublicationProviderAcceptanceV1 {
  if (!isRecord(value)) {
    throw new ContinuityPublicationError(
      "invalid-acceptance",
      "Continuity publication acceptance is invalid",
    );
  }
  try {
    const identity = normalizeEvidenceIdentity(value.identity, "invalid-acceptance");
    if (
      value.version !== CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION ||
      !identitiesEqual(expectedIdentity, identity)
    ) {
      throw new ContinuityPublicationError(
        "invalid-acceptance",
        "Continuity publication acceptance does not match the request",
      );
    }
    return Object.freeze({
      version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
      publicationId: requireIdentifier(value.publicationId, "publicationId"),
      identity,
      durabilityClass: requireImmutableDurabilityClass(value.durabilityClass),
      acceptedAt: requireAcceptedAt(value.acceptedAt),
    });
  } catch (error) {
    if (error instanceof ContinuityPublicationError && error.code !== "invalid-acceptance") {
      throw new ContinuityPublicationError("invalid-acceptance", error.message);
    }
    throw error;
  }
}

function normalizeProviderRetrieval(
  value: unknown,
  receipt: ContinuityPublicationAcceptanceReceiptV1,
): ContinuityPublicationRetrievalV1 {
  if (!isRecord(value)) {
    throw new ContinuityPublicationError(
      "invalid-retrieval",
      "Continuity publication retrieval is invalid",
    );
  }
  const identity = normalizeEvidenceIdentity(value.identity, "invalid-retrieval");
  const content = value.content;
  if (
    value.version !== CONTINUITY_PUBLICATION_RETRIEVAL_VERSION ||
    value.publicationId !== receipt.publicationId ||
    !identitiesEqual(identity, receipt.identity) ||
    !isAsyncByteIterable(content)
  ) {
    throw new ContinuityPublicationError(
      "invalid-retrieval",
      "Continuity publication retrieval does not match the acceptance receipt",
    );
  }
  return Object.freeze({
    version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
    publicationId: receipt.publicationId,
    identity,
    content,
  });
}

export function parseContinuityPublicationAcceptanceReceiptV1(
  receipt: unknown,
): ContinuityPublicationAcceptanceReceiptV1 {
  if (!isRecord(receipt)) {
    throw new ContinuityPublicationError(
      "invalid-request",
      "Continuity publication receipt is invalid",
    );
  }
  if (receipt.version !== CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION) {
    throw new ContinuityPublicationError(
      "invalid-request",
      "Continuity publication receipt version is invalid",
    );
  }
  return Object.freeze({
    version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
    publicationId: requireIdentifier(receipt.publicationId, "publicationId"),
    identity: parseContinuityPublicationIdentityV1(receipt.identity),
    durabilityClass: requireImmutableDurabilityClass(receipt.durabilityClass),
    acceptedAt: requireAcceptedAt(receipt.acceptedAt),
    publicationPluginId: requireIdentifier(receipt.publicationPluginId, "publicationPluginId"),
    publicationBindingId: requireIdentifier(receipt.publicationBindingId, "publicationBindingId"),
    publicationBindingVersion: requireProviderVersion(receipt.publicationBindingVersion),
    publicationBindingGeneration: requireIdentifier(
      receipt.publicationBindingGeneration,
      "publicationBindingGeneration",
    ),
  });
}

function normalizeProviderReference(
  reference: ContinuityPublicationProviderReferenceV1,
): ContinuityPublicationProviderReferenceV1 {
  return Object.freeze({
    pluginId: requireIdentifier(reference.pluginId, "publicationPluginId"),
    id: requireProviderId(reference.id),
    version: reference.version,
    generation: requireIdentifier(reference.generation, "publicationBindingGeneration"),
  });
}

export function resolveContinuityPublicationProviderV1(params: {
  registry: PluginRegistry;
  reference: ContinuityPublicationProviderReferenceV1;
}): ContinuityPublicationProviderV1 {
  const reference = normalizeProviderReference(params.reference);
  const registrations = params.registry.continuityPublicationProviders.filter(
    (entry) => entry.provider.id === reference.id,
  );
  if (registrations.length === 0) {
    throw new ContinuityPublicationError(
      "provider-not-found",
      `Continuity publication provider "${reference.id}" is not registered`,
    );
  }
  if (registrations.length !== 1) {
    throw new ContinuityPublicationError(
      "provider-ambiguous",
      `Continuity publication provider "${reference.id}" is ambiguous`,
    );
  }
  const provider = registrations[0]?.provider;
  const registration = registrations[0];
  if (!registration || registration.pluginId !== reference.pluginId) {
    throw new ContinuityPublicationError(
      "provider-provenance-mismatch",
      `Continuity publication provider "${reference.id}" does not match plugin "${reference.pluginId}"`,
    );
  }
  if (!provider || provider.version !== reference.version) {
    throw new ContinuityPublicationError(
      "provider-incompatible",
      `Continuity publication provider "${reference.id}" is incompatible`,
    );
  }
  if (provider.generation !== reference.generation) {
    throw new ContinuityPublicationError(
      "stale-provider-generation",
      `Continuity publication provider "${reference.id}" generation is stale`,
    );
  }
  return provider;
}

export async function publishContinuityArtifactV1(params: {
  registry: PluginRegistry;
  reference: ContinuityPublicationProviderReferenceV1;
  identity: ContinuityPublicationIdentityV1;
  content: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}): Promise<ContinuityPublicationAcceptanceReceiptV1> {
  const reference = normalizeProviderReference(params.reference);
  const identity = parseContinuityPublicationIdentityV1(params.identity);
  const provider = resolveContinuityPublicationProviderV1({
    registry: params.registry,
    reference,
  });
  const validatedContent = validatePublishedContent(params.content, identity);
  const acceptance = await provider.publish({
    identity,
    content: validatedContent.content,
    signal: params.signal,
  });
  validatedContent.assertComplete();
  const normalizedAcceptance = normalizeProviderAcceptance(acceptance, identity);
  return Object.freeze({
    ...normalizedAcceptance,
    identity,
    publicationPluginId: reference.pluginId,
    publicationBindingId: reference.id,
    publicationBindingVersion: reference.version,
    publicationBindingGeneration: reference.generation,
  });
}

export async function retrieveContinuityArtifactV1(params: {
  registry: PluginRegistry;
  reference: ContinuityPublicationProviderReferenceV1;
  receipt: ContinuityPublicationAcceptanceReceiptV1;
  expectedOwnerId: string;
  signal: AbortSignal;
}): Promise<ContinuityPublicationRetrievalV1> {
  const reference = normalizeProviderReference(params.reference);
  const receipt = parseContinuityPublicationAcceptanceReceiptV1(params.receipt);
  const expectedOwnerId = requireIdentifier(params.expectedOwnerId, "expectedOwnerId");
  if (
    receipt.identity.ownerId !== expectedOwnerId ||
    receipt.publicationPluginId !== reference.pluginId ||
    receipt.publicationBindingId !== reference.id ||
    receipt.publicationBindingVersion !== reference.version ||
    receipt.publicationBindingGeneration !== reference.generation
  ) {
    throw new ContinuityPublicationError(
      "invalid-request",
      "Continuity publication receipt does not match the frozen binding",
    );
  }
  const provider = resolveContinuityPublicationProviderV1({
    registry: params.registry,
    reference,
  });
  const retrieval = await provider.retrieve({
    receipt,
    signal: params.signal,
  });
  const normalizedRetrieval = normalizeProviderRetrieval(retrieval, receipt);
  return Object.freeze({
    ...normalizedRetrieval,
    content: validateRetrievedContent(normalizedRetrieval.content, normalizedRetrieval.identity),
  });
}
