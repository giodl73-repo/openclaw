import { randomUUID } from "node:crypto";
import {
  HOST_PROVIDER_TOKEN_MAX_LIFETIME_MS,
  mintHostProviderToken,
  type HostProviderDeclaration,
} from "../gateway/host-provider-token.js";
import { getCurrentHostIntegrationBundleSnapshotV1 } from "./host-integration-bundle.js";
import { getCurrentHostIntegrationOwnerEvidenceV1 } from "./host-integration-status.js";

export const HOST_PROVIDER_CREDENTIAL_VERSION = "host-provider-credential/v1" as const;

export type HostProviderCredentialV1 = {
  version: typeof HOST_PROVIDER_CREDENTIAL_VERSION;
  token: string;
  declaration: HostProviderDeclaration;
  credentialId: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export function resolveCurrentHostProviderDeclarationV1(
  bindingId: string,
): HostProviderDeclaration | undefined {
  const bundle = getCurrentHostIntegrationBundleSnapshotV1();
  if (!bundle) {
    return undefined;
  }
  const contribution = bundle.inventory.find(
    (entry) =>
      entry.owner === "provider-request" &&
      entry.kind === "provider-request-dispatcher" &&
      entry.id === bindingId &&
      entry.status === "resolved" &&
      entry.version === "provider-request-dispatcher/v1" &&
      entry.resolvedVersion === "provider-request-dispatcher/v1",
  );
  if (!contribution) {
    return undefined;
  }
  const hostBundleGeneration = bundle.generation;
  const evidence = getCurrentHostIntegrationOwnerEvidenceV1().find(
    (entry) =>
      entry.owner === contribution.owner &&
      entry.kind === contribution.kind &&
      entry.id === contribution.id &&
      entry.state === "ready" &&
      entry.bundleGeneration === hostBundleGeneration &&
      typeof entry.ownerGeneration === "string" &&
      entry.ownerGeneration.length > 0,
  );
  if (!evidence?.ownerGeneration) {
    return undefined;
  }
  return {
    bindingId,
    interfaceVersion: "provider-request-dispatcher/v1",
    carrierVersion: "reverse-provider-dispatch/v1",
    ownerGeneration: evidence.ownerGeneration,
    hostBundleGeneration,
  };
}

/**
 * Issues a process-scoped credential for the trusted owner that launches a host-provider peer.
 * The owner supplies only the peer key and binding; current generations come from registered
 * OpenClaw state so stale or host-authored authority claims cannot be minted.
 */
export function issueHostProviderCredentialV1(params: {
  bindingId: string;
  publicKey: string;
  nowMs?: number;
  lifetimeMs?: number;
}): HostProviderCredentialV1 {
  const declaration = resolveCurrentHostProviderDeclarationV1(params.bindingId);
  if (!declaration) {
    throw new Error(`host provider binding is not ready: ${params.bindingId}`);
  }
  const issuedAtMs = params.nowMs ?? Date.now();
  const lifetimeMs = params.lifetimeMs ?? HOST_PROVIDER_TOKEN_MAX_LIFETIME_MS;
  const credentialId = randomUUID();
  const token = mintHostProviderToken({
    declaration,
    publicKey: params.publicKey,
    nowMs: issuedAtMs,
    lifetimeMs,
    credentialId,
  });
  return Object.freeze({
    version: HOST_PROVIDER_CREDENTIAL_VERSION,
    token,
    declaration: Object.freeze({ ...declaration }),
    credentialId,
    issuedAtMs,
    expiresAtMs: issuedAtMs + lifetimeMs,
  });
}
