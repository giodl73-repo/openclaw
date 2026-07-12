import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveCurrentHostProviderDeclarationV1 } from "../hosting/host-provider-credentials.js";
import { verifyHostProviderToken, type HostProviderDeclaration } from "./host-provider-token.js";

export type HostProviderAdmission = {
  declaration: HostProviderDeclaration;
  credentialId: string;
  peerKeyFingerprint: string;
};

export type HostProviderAdmissionResult =
  | { ok: true; admission: HostProviderAdmission }
  | { ok: false; reason: string };

function reject(reason: string): HostProviderAdmissionResult {
  return { ok: false, reason };
}

export function verifyHostProviderAdmission(params: {
  connect: ConnectParams;
  publicKey: string;
  nowMs?: number;
}): HostProviderAdmissionResult {
  if (
    params.connect.role !== "host-provider" ||
    params.connect.client.id !== GATEWAY_CLIENT_IDS.HOST_PROVIDER ||
    params.connect.client.mode !== GATEWAY_CLIENT_MODES.SERVICE
  ) {
    return reject("host provider client identity is invalid");
  }
  if ((params.connect.scopes?.length ?? 0) !== 0) {
    return reject("host provider scopes must be empty");
  }
  const declaration = params.connect.hostProvider;
  const token = params.connect.auth?.hostProviderToken;
  if (!declaration || !token) {
    return reject("host provider declaration and token are required");
  }
  if (
    params.connect.auth?.token ||
    params.connect.auth?.password ||
    params.connect.auth?.bootstrapToken ||
    params.connect.auth?.deviceToken
  ) {
    return reject("host provider credentials are ambiguous");
  }
  const tokenPayload = verifyHostProviderToken({
    token,
    declaration,
    publicKey: params.publicKey,
    nowMs: params.nowMs,
  });
  if (!tokenPayload) {
    return reject("host provider token is invalid");
  }

  const currentDeclaration = resolveCurrentHostProviderDeclarationV1(declaration.bindingId);
  if (!currentDeclaration) {
    return reject("host provider dispatcher contribution is unavailable");
  }
  if (
    currentDeclaration.interfaceVersion !== declaration.interfaceVersion ||
    currentDeclaration.carrierVersion !== declaration.carrierVersion ||
    currentDeclaration.hostBundleGeneration !== declaration.hostBundleGeneration ||
    currentDeclaration.ownerGeneration !== declaration.ownerGeneration
  ) {
    return reject("host provider owner generation is not current");
  }
  return {
    ok: true,
    admission: {
      declaration,
      credentialId: tokenPayload.credentialId,
      peerKeyFingerprint: tokenPayload.peerKeyFingerprint,
    },
  };
}
