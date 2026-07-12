import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHostProviderTokenStateForTest } from "../gateway/host-provider-token.js";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
} from "./host-integration-bundle.js";
import {
  clearCurrentHostIntegrationOwnerEvidenceV1,
  publishHostIntegrationOwnerEvidenceV1,
} from "./host-integration-status.js";
import {
  HOST_PROVIDER_CREDENTIAL_VERSION,
  issueHostProviderCredentialV1,
} from "./host-provider-credentials.js";

function registerBinding(ownerGeneration = "owner-4") {
  registerHostIntegrationBundleV1({
    manifest: {
      version: "host-integration-bundle/v1",
      id: "lobster/host",
      bundleVersion: "1.0.0",
      contributions: [
        {
          owner: "provider-request",
          kind: "provider-request-dispatcher",
          id: "lobster/egress",
          version: "provider-request-dispatcher/v1",
          required: true,
          readinessCriteria: ["provider.request.dispatch.lobster"],
        },
      ],
    },
    availableContributions: [
      {
        owner: "provider-request",
        kind: "provider-request-dispatcher",
        id: "lobster/egress",
        version: "provider-request-dispatcher/v1",
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
      id: "lobster/egress",
      bundleGeneration: "lobster/host@1.0.0",
      ownerGeneration,
      state: "ready",
      reason: "Ready",
      message: "ready",
    },
  ]);
}

beforeEach(() => {
  resetHostProviderTokenStateForTest({
    secret: Buffer.alloc(32, 7),
    audience: "gateway-process-1",
  });
  registerBinding();
});

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
  clearCurrentHostIntegrationOwnerEvidenceV1();
});

describe("host provider credential issuer", () => {
  it("derives authority generations from the current trusted owner state", () => {
    const credential = issueHostProviderCredentialV1({
      bindingId: "lobster/egress",
      publicKey: "peer-public-key",
      nowMs: 1_000,
      lifetimeMs: 60_000,
    });

    expect(credential).toEqual({
      version: HOST_PROVIDER_CREDENTIAL_VERSION,
      token: expect.any(String),
      declaration: {
        bindingId: "lobster/egress",
        interfaceVersion: "provider-request-dispatcher/v1",
        carrierVersion: "reverse-provider-dispatch/v1",
        ownerGeneration: "owner-4",
        hostBundleGeneration: "lobster/host@1.0.0",
      },
      credentialId: expect.any(String),
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
    });
    expect(Object.isFrozen(credential)).toBe(true);
    expect(Object.isFrozen(credential.declaration)).toBe(true);
  });

  it("refuses issuance when the dispatcher owner is not currently ready", () => {
    clearCurrentHostIntegrationOwnerEvidenceV1();

    expect(() =>
      issueHostProviderCredentialV1({
        bindingId: "lobster/egress",
        publicKey: "peer-public-key",
      }),
    ).toThrow("binding is not ready");
  });
});
