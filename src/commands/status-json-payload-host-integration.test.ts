import { afterEach, describe, expect, it } from "vitest";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
} from "../hosting/host-integration-bundle.js";
import {
  clearCurrentHostIntegrationOwnerEvidenceV1,
  publishHostIntegrationOwnerEvidenceV1,
} from "../hosting/host-integration-status.js";
import { buildStatusJsonPayload } from "./status-json-payload.js";

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
  clearCurrentHostIntegrationOwnerEvidenceV1();
});

describe("status json host integration inventory", () => {
  it("projects a registered bundle without probing its owners", () => {
    const bundle = registerHostIntegrationBundleV1({
      manifest: {
        version: "host-integration-bundle/v1",
        id: "lobster/capi",
        bundleVersion: "1.0.0",
        contributions: [
          {
            owner: "model-provider",
            kind: "model-provider-adapter",
            id: "lobster/capi",
            version: "capi-model-adapter/v1",
            required: true,
            readinessCriteria: ["CapiReady"],
          },
        ],
      },
      availableContributions: [
        {
          owner: "model-provider",
          kind: "model-provider-adapter",
          id: "lobster/capi",
          version: "capi-model-adapter/v1",
          provenance: {
            pluginId: "lobster",
            source: "/plugins/lobster",
            origin: "workspace",
          },
        },
      ],
    });
    publishHostIntegrationOwnerEvidenceV1([
      {
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "lobster/capi",
        bundleGeneration: bundle.generation,
        state: "ready",
        reason: "CapiReady",
        message: "CAPI binding is ready.",
        ownerGeneration: "owner-1",
      },
    ]);

    const payload = buildStatusJsonPayload({
      summary: { ok: true },
      surface: {
        cfg: { gateway: {} },
        update: { root: "/tmp/openclaw", installKind: "package", packageManager: "npm" } as never,
        tailscaleMode: "off",
        gatewayMode: "local",
        remoteUrlMissing: false,
        gatewayConnection: { url: "ws://127.0.0.1:18789" },
        gatewayReachable: false,
        gatewayProbe: null,
        gatewayProbeAuth: null,
        gatewaySelf: null,
        gatewayProbeAuthWarning: null,
        gatewayService: { label: "gateway", installed: false, loadedText: "not installed" },
        nodeService: { label: "node", installed: false, loadedText: "not installed" },
      },
      osSummary: { platform: "linux" },
      memory: null,
      memoryPlugin: null,
      agents: [],
      secretDiagnostics: [],
    });

    expect(payload.hostIntegration).toMatchObject({
      state: "ready",
      entries: [
        {
          id: "lobster/capi",
          reason: "CapiReady",
          generations: { bundle: bundle.generation, owner: "owner-1" },
        },
      ],
    });
  });
});
