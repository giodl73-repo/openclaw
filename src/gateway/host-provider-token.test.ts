import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fingerprintHostProviderPublicKey,
  mintHostProviderToken,
  resetHostProviderTokenStateForTest,
  verifyHostProviderToken,
  type HostProviderDeclaration,
} from "./host-provider-token.js";

const PUBLIC_KEY = Buffer.from("host-provider-public-key").toString("base64url");
const PEER_FINGERPRINT = createHash("sha256").update(PUBLIC_KEY).digest("base64url");
const DECLARATION: HostProviderDeclaration = {
  bindingId: "lobster/egress",
  interfaceVersion: "provider-request-dispatcher/v1",
  carrierVersion: "reverse-provider-dispatch/v1",
  ownerGeneration: "owner-4",
  hostBundleGeneration: "bundle-9",
};

describe("host provider admission tokens", () => {
  beforeEach(() => {
    resetHostProviderTokenStateForTest({
      secret: Buffer.alloc(32, 7),
      audience: "gateway-process-1",
    });
  });

  it("round-trips a token bound to the peer and dispatcher declaration", () => {
    const issuedAtMs = Date.UTC(2026, 0, 2);
    const token = mintHostProviderToken({
      publicKey: PUBLIC_KEY,
      declaration: DECLARATION,
      credentialId: "credential-1",
      nowMs: issuedAtMs,
      lifetimeMs: 60_000,
    });

    expect(
      verifyHostProviderToken({
        token,
        publicKey: PUBLIC_KEY,
        declaration: DECLARATION,
        nowMs: issuedAtMs + 30_000,
      }),
    ).toEqual({
      kind: "host-provider",
      audience: "gateway-process-1",
      peerKeyFingerprint: PEER_FINGERPRINT,
      ...DECLARATION,
      credentialId: "credential-1",
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60_000,
    });
  });

  it("rejects declaration, peer, expiry, and process-audience mismatches", () => {
    const issuedAtMs = Date.UTC(2026, 0, 2);
    const token = mintHostProviderToken({
      publicKey: PUBLIC_KEY,
      declaration: DECLARATION,
      credentialId: "credential-1",
      nowMs: issuedAtMs,
      lifetimeMs: 60_000,
    });

    expect(
      verifyHostProviderToken({
        token,
        publicKey: PUBLIC_KEY,
        declaration: { ...DECLARATION, ownerGeneration: "owner-5" },
        nowMs: issuedAtMs + 1,
      }),
    ).toBeUndefined();
    expect(
      verifyHostProviderToken({
        token,
        publicKey: Buffer.from("different-peer").toString("base64url"),
        declaration: DECLARATION,
        nowMs: issuedAtMs + 1,
      }),
    ).toBeUndefined();
    expect(
      verifyHostProviderToken({
        token,
        publicKey: PUBLIC_KEY,
        declaration: DECLARATION,
        nowMs: issuedAtMs + 60_001,
      }),
    ).toBeUndefined();

    resetHostProviderTokenStateForTest({
      secret: Buffer.alloc(32, 7),
      audience: "gateway-process-2",
    });
    expect(
      verifyHostProviderToken({
        token,
        publicKey: PUBLIC_KEY,
        declaration: DECLARATION,
        nowMs: issuedAtMs + 1,
      }),
    ).toBeUndefined();
  });

  it("rejects invalid lifetimes and malformed or tampered tokens", () => {
    expect(() =>
      mintHostProviderToken({
        publicKey: PUBLIC_KEY,
        declaration: DECLARATION,
        credentialId: "credential-1",
        lifetimeMs: 0,
      }),
    ).toThrow("lifetime is invalid");

    const issuedAtMs = Date.UTC(2026, 0, 2);
    const token = mintHostProviderToken({
      publicKey: PUBLIC_KEY,
      declaration: DECLARATION,
      credentialId: "credential-1",
      nowMs: issuedAtMs,
      lifetimeMs: 60_000,
    });
    const [payload] = token.split(".");

    for (const candidate of ["invalid", `${payload}.invalid`, `${token}.extra`]) {
      expect(
        verifyHostProviderToken({
          token: candidate,
          publicKey: PUBLIC_KEY,
          declaration: DECLARATION,
          nowMs: issuedAtMs + 1,
        }),
      ).toBeUndefined();
    }
  });

  it("normalizes the peer public key before fingerprinting", () => {
    expect(fingerprintHostProviderPublicKey(`  ${PUBLIC_KEY}\n`)).toBe(PEER_FINGERPRINT);
  });
});
