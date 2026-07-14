import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
} from "../../hosting/host-integration-bundle.js";
import {
  clearCurrentHostIntegrationOwnerEvidenceV1,
  publishHostIntegrationOwnerEvidenceV1,
} from "../../hosting/host-integration-status.js";
import { issueHostProviderCredentialV1 } from "../../hosting/host-provider-credentials.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../infra/device-identity.js";
import { buildDeviceAuthPayloadV3 } from "../device-auth.js";
import { resetHostProviderTokenStateForTest } from "../host-provider-token.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

const tempPaths: string[] = [];

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
      bundleGeneration: bundle.generation,
      ownerGeneration: "owner-4",
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
  registerCurrentBinding();
});

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
  clearCurrentHostIntegrationOwnerEvidenceV1();
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("host provider websocket admission", () => {
  it("admits a signed host token without gateway auth or device pairing", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket = createGatewayWsTestSocket({
      onSend: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    });
    const hostProviderRegistry = {
      register: vi.fn(() => {
        expect(sent.some((frame) => frame.id === "connect-1" && frame.ok === true)).toBe(true);
      }),
      unregister: vi.fn(),
      receiveFrame: vi.fn(),
    };
    const context = createGatewayWsTestRequestContext({ hostProviderRegistry });
    attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      socket,
      options: {
        gatewayMethods: ["host.provider.frame"],
        buildRequestContext: () => context as never,
      },
    });
    const challenge = sent.find((frame) => frame.event === "connect.challenge");
    const nonce = (challenge?.payload as { nonce?: unknown } | undefined)?.nonce;
    expect(nonce).toBeTypeOf("string");

    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-provider-"));
    tempPaths.push(tempPath);
    const identity = loadOrCreateDeviceIdentity(path.join(tempPath, "device.json"));
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const credential = issueHostProviderCredentialV1({
      bindingId: "lobster/egress",
      publicKey,
      lifetimeMs: 60_000,
    });
    const declaration = credential.declaration;
    const hostProviderToken = credential.token;
    const signedAt = Date.now();
    const signature = signDevicePayload(
      identity.privateKeyPem,
      buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: "host-provider",
        clientMode: "service",
        role: "host-provider",
        scopes: [],
        signedAtMs: signedAt,
        token: hostProviderToken,
        nonce: nonce as string,
        platform: "linux",
      }),
    );

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "host-provider",
              version: "1.0.0",
              platform: "linux",
              mode: "service",
            },
            role: "host-provider",
            scopes: [],
            hostProvider: declaration,
            auth: { hostProviderToken },
            device: {
              id: identity.deviceId,
              publicKey,
              signature,
              signedAt,
              nonce,
            },
          },
        }),
      ),
    );

    await vi.waitFor(() => {
      expect(hostProviderRegistry.register).toHaveBeenCalledTimes(1);
    });
    const response = sent.find((frame) => frame.id === "connect-1");
    expect(response).toMatchObject({
      type: "res",
      ok: true,
      payload: {
        features: {
          methods: ["host.provider.frame"],
          events: [],
          capabilities: [],
        },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
        },
        auth: { role: "host-provider", scopes: [] },
      },
    });

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "req",
          id: "health-1",
          method: "health",
          params: {},
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "req",
          id: "frame-1",
          method: "host.provider.frame",
          params: { type: "dispatch-started" },
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(sent.some((frame) => frame.id === "health-1")).toBe(true);
      expect(sent.some((frame) => frame.id === "frame-1")).toBe(true);
    });
    expect(sent.find((frame) => frame.id === "health-1")).toMatchObject({
      ok: false,
      error: { message: "unauthorized role: host-provider" },
    });
    expect(sent.find((frame) => frame.id === "frame-1")).toMatchObject({
      ok: true,
      payload: { accepted: true },
    });
  });
});
