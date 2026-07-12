import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";

const TOKEN_CONTEXT = "openclaw:host-provider-token:v1";
const TOKEN_KIND = "host-provider";
export const HOST_PROVIDER_TOKEN_MAX_LIFETIME_MS = 5 * 60_000;

export type HostProviderDeclaration = NonNullable<ConnectParams["hostProvider"]>;

type HostProviderTokenPayload = HostProviderDeclaration & {
  kind: typeof TOKEN_KIND;
  audience: string;
  peerKeyFingerprint: string;
  issuedAtMs: number;
  expiresAtMs: number;
  credentialId: string;
};

let processSecret: Buffer = randomBytes(32);
let processAudience: string = randomUUID();

function sign(payload: string): string {
  return createHmac("sha256", processSecret)
    .update(TOKEN_CONTEXT)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function signaturesMatch(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return valueBytes.length === expectedBytes.length && timingSafeEqual(valueBytes, expectedBytes);
}

export function fingerprintHostProviderPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey.trim(), "utf8").digest("base64url");
}

export function mintHostProviderToken(params: {
  declaration: HostProviderDeclaration;
  publicKey: string;
  nowMs?: number;
  lifetimeMs?: number;
  credentialId?: string;
}): string {
  const issuedAtMs = params.nowMs ?? Date.now();
  const lifetimeMs = params.lifetimeMs ?? HOST_PROVIDER_TOKEN_MAX_LIFETIME_MS;
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > HOST_PROVIDER_TOKEN_MAX_LIFETIME_MS ||
    !Number.isSafeInteger(issuedAtMs + lifetimeMs)
  ) {
    throw new Error("host provider token lifetime is invalid");
  }
  const payload: HostProviderTokenPayload = {
    kind: TOKEN_KIND,
    audience: processAudience,
    peerKeyFingerprint: fingerprintHostProviderPublicKey(params.publicKey),
    ...params.declaration,
    issuedAtMs,
    expiresAtMs: issuedAtMs + lifetimeMs,
    credentialId: params.credentialId ?? randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function parsePayload(value: string): HostProviderTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    const keys = [
      "kind",
      "audience",
      "peerKeyFingerprint",
      "bindingId",
      "interfaceVersion",
      "carrierVersion",
      "ownerGeneration",
      "hostBundleGeneration",
      "issuedAtMs",
      "expiresAtMs",
      "credentialId",
    ];
    if (
      Object.keys(payload).length !== keys.length ||
      Object.keys(payload).some((key) => !keys.includes(key)) ||
      payload.kind !== TOKEN_KIND ||
      payload.interfaceVersion !== "provider-request-dispatcher/v1" ||
      payload.carrierVersion !== "reverse-provider-dispatch/v1" ||
      keys
        .filter((key) => !["issuedAtMs", "expiresAtMs"].includes(key))
        .some((key) => typeof payload[key] !== "string" || payload[key] === "") ||
      !Number.isSafeInteger(payload.issuedAtMs) ||
      !Number.isSafeInteger(payload.expiresAtMs)
    ) {
      return undefined;
    }
    return payload as HostProviderTokenPayload;
  } catch {
    return undefined;
  }
}

export function verifyHostProviderToken(params: {
  token: string | null | undefined;
  declaration: HostProviderDeclaration;
  publicKey: string;
  nowMs?: number;
}): HostProviderTokenPayload | undefined {
  const token = params.token?.trim();
  if (!token || token.length > 8192) {
    return undefined;
  }
  const [payloadPart, signature, ...extra] = token.split(".");
  if (
    !payloadPart ||
    !signature ||
    extra.length > 0 ||
    !signaturesMatch(signature, sign(payloadPart))
  ) {
    return undefined;
  }
  const payload = parsePayload(payloadPart);
  const nowMs = params.nowMs ?? Date.now();
  if (
    !payload ||
    payload.audience !== processAudience ||
    payload.peerKeyFingerprint !== fingerprintHostProviderPublicKey(params.publicKey) ||
    payload.bindingId !== params.declaration.bindingId ||
    payload.interfaceVersion !== params.declaration.interfaceVersion ||
    payload.carrierVersion !== params.declaration.carrierVersion ||
    payload.ownerGeneration !== params.declaration.ownerGeneration ||
    payload.hostBundleGeneration !== params.declaration.hostBundleGeneration ||
    payload.expiresAtMs <= nowMs ||
    payload.issuedAtMs > nowMs ||
    payload.expiresAtMs - payload.issuedAtMs > HOST_PROVIDER_TOKEN_MAX_LIFETIME_MS
  ) {
    return undefined;
  }
  return payload;
}

export function resetHostProviderTokenStateForTest(params?: {
  secret?: Buffer;
  audience?: string;
}): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  processSecret = params?.secret ?? randomBytes(32);
  processAudience = params?.audience ?? randomUUID();
}
