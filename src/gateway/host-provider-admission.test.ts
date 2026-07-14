import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
} from "../hosting/host-integration-bundle.js";
import {
  clearCurrentHostIntegrationOwnerEvidenceV1,
  publishHostIntegrationOwnerEvidenceV1,
} from "../hosting/host-integration-status.js";
import { issueHostProviderCredentialV1 } from "../hosting/host-provider-credentials.js";
import { verifyHostProviderAdmission } from "./host-provider-admission.js";
import {
  resetHostProviderTokenStateForTest,
  type HostProviderDeclaration,
} from "./host-provider-token.js";

const PUBLIC_KEY = "host-provider-public-key";
const NOW_MS = Date.UTC(2026, 0, 2);
const DECLARATION: HostProviderDeclaration = {
  bindingId: "lobster/egress",
  interfaceVersion: "provider-request-dispatcher/v1",
  carrierVersion: "reverse-provider-dispatch/v1",
  ownerGeneration: "owner-4",
  hostBundleGeneration: "lobster/host@1.0.0",
};
let bundleGeneration: string;

function registerCurrentBinding() {
  const bundle = registerHostIntegrationBundleV1({
    manifest: {
      version: "host-integration-bundle/v1",
      id: "lobster/host",
      bundleVersion: "1.0.0",
      contributions: [
        {
          owner: "provider-request",
          kind: "provider-request-dispatcher",
          id: DECLARATION.bindingId,
          version: DECLARATION.interfaceVersion,
          required: true,
          readinessCriteria: ["provider.request.dispatch.lobster"],
        },
      ],
    },
    availableContributions: [
      {
        owner: "provider-request",
        kind: "provider-request-dispatcher",
        id: DECLARATION.bindingId,
        version: DECLARATION.interfaceVersion,
        provenance: {
          pluginId: "lobster-host",
          source: "/plugins/lobster-host/openclaw.plugin.json",
          origin: "config",
        },
      },
    ],
  });
  publishHostIntegrationOwnerEvidenceV1([
    {
      owner: "provider-request",
      kind: "provider-request-dispatcher",
      id: DECLARATION.bindingId,
      bundleGeneration: bundle.generation,
      ownerGeneration: DECLARATION.ownerGeneration,
      state: "ready",
      reason: "Ready",
      message: "ready",
    },
  ]);
  bundleGeneration = bundle.generation;
}

function connect(overrides: Partial<ConnectParams> = {}): ConnectParams {
  const credential = issueHostProviderCredentialV1({
    bindingId: DECLARATION.bindingId,
    publicKey: PUBLIC_KEY,
    nowMs: NOW_MS,
    lifetimeMs: 60_000,
  });
  return {
    minProtocol: 5,
    maxProtocol: 5,
    client: {
      id: "host-provider",
      version: "1.0.0",
      platform: "linux",
      mode: "service",
    },
    role: "host-provider",
    scopes: [],
    hostProvider: credential.declaration,
    auth: { hostProviderToken: credential.token },
    ...overrides,
  };
}

describe("host provider admission", () => {
  beforeEach(() => {
    resetHostProviderTokenStateForTest({
      secret: Buffer.alloc(32, 7),
      audience: "gateway-process-1",
    });
    registerCurrentBinding();
  });

  afterEach(() => {
    clearCurrentHostIntegrationBundleSnapshotV1();
    clearCurrentHostIntegrationOwnerEvidenceV1();
  });

  it("admits the least-privilege client against current bundle and owner generations", () => {
    expect(
      verifyHostProviderAdmission({
        connect: connect(),
        publicKey: PUBLIC_KEY,
        nowMs: NOW_MS + 1,
      }),
    ).toEqual({
      ok: true,
      admission: {
        declaration: {
          ...DECLARATION,
          hostBundleGeneration: bundleGeneration,
        },
        credentialId: expect.any(String),
        peerKeyFingerprint: expect.any(String),
      },
    });
  });

  it("rejects stale generations, ambient scopes, and mixed credentials", () => {
    const stale = connect();
    publishHostIntegrationOwnerEvidenceV1([
      {
        owner: "provider-request",
        kind: "provider-request-dispatcher",
        id: DECLARATION.bindingId,
        bundleGeneration,
        ownerGeneration: "owner-5",
        state: "ready",
        reason: "Ready",
        message: "ready",
      },
    ]);
    expect(
      verifyHostProviderAdmission({
        connect: stale,
        publicKey: PUBLIC_KEY,
        nowMs: NOW_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "host provider owner generation is not current" });
    expect(
      verifyHostProviderAdmission({
        connect: connect({ scopes: ["operator.read"] }),
        publicKey: PUBLIC_KEY,
        nowMs: NOW_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "host provider scopes must be empty" });
    const mixed = connect();
    mixed.auth = { ...mixed.auth, token: "gateway-token" };
    expect(
      verifyHostProviderAdmission({
        connect: mixed,
        publicKey: PUBLIC_KEY,
        nowMs: NOW_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "host provider credentials are ambiguous" });
  });
});
