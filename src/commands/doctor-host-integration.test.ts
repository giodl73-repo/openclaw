import { afterEach, describe, expect, it } from "vitest";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
} from "../hosting/host-integration-bundle.js";
import {
  clearCurrentHostIntegrationOwnerEvidenceV1,
  type HostIntegrationBindingStatusEntryV1,
  type HostIntegrationStatusInventoryV1,
} from "../hosting/host-integration-status.js";
import {
  collectHostIntegrationHealthFindings,
  HOST_INTEGRATION_BINDINGS_CHECK_ID,
  hostIntegrationStatusToHealthFindings,
} from "./doctor-host-integration.js";

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
  clearCurrentHostIntegrationOwnerEvidenceV1();
});

type ModelProviderStatusEntry = HostIntegrationBindingStatusEntryV1 & {
  owner: "model-provider";
  kind: "model-provider-adapter";
};

function inventory(
  entry: Partial<ModelProviderStatusEntry> = {},
): HostIntegrationStatusInventoryV1 {
  return {
    version: "host-integration-status/v1",
    bundle: {
      id: "example/host",
      version: "1.0.0",
      generation: "example/host@1.0.0",
    },
    state: entry.state ?? "unresolved",
    entries: [
      {
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "example/provider-adapter",
        version: "example-provider-adapter/v1",
        required: true,
        readinessCriteria: ["ProviderReady"],
        status: "resolved",
        resolvedVersion: "example-provider-adapter/v1",
        state: "unresolved",
        reason: "OwnerEvidenceUnavailable",
        message: "sensitive owner detail must not be copied",
        generations: { bundle: "example/host@1.0.0" },
        ...entry,
      },
    ],
  };
}

describe("host integration Doctor findings", () => {
  it("stays absent when no host integration bundle is registered", () => {
    expect(collectHostIntegrationHealthFindings()).toEqual([]);
  });

  it("reads the published bundle snapshot without probing owners", () => {
    registerHostIntegrationBundleV1({
      manifest: {
        version: "host-integration-bundle/v1",
        id: "example/host",
        bundleVersion: "1.0.0",
        contributions: [
          {
            owner: "model-provider",
            kind: "model-provider-adapter",
            id: "example/provider-adapter",
            version: "example-provider-adapter/v1",
            required: true,
            readinessCriteria: ["ProviderReady"],
          },
        ],
      },
      availableContributions: [
        {
          owner: "model-provider",
          kind: "model-provider-adapter",
          id: "example/provider-adapter",
          version: "example-provider-adapter/v1",
          provenance: {
            pluginId: "example-host",
            source: "/plugins/example-host",
            origin: "workspace",
          },
        },
      ],
    });

    expect(collectHostIntegrationHealthFindings()).toMatchObject([
      {
        checkId: HOST_INTEGRATION_BINDINGS_CHECK_ID,
        severity: "warning",
        target: "example/provider-adapter",
        requirement: "OwnerEvidenceUnavailable",
      },
    ]);
  });

  it("reports a failed required registration without replacing the effective bundle", () => {
    expect(() =>
      registerHostIntegrationBundleV1({
        manifest: {
          version: "host-integration-bundle/v1",
          id: "example/host",
          bundleVersion: "1.0.0",
          contributions: [
            {
              owner: "model-provider",
              kind: "model-provider-adapter",
              id: "example/provider-adapter",
              version: "example-provider-adapter/v1",
              required: true,
              readinessCriteria: ["ProviderReady"],
            },
          ],
        },
        availableContributions: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "missing-required-contribution" }));

    expect(collectHostIntegrationHealthFindings()).toMatchObject([
      {
        severity: "error",
        target: "example/provider-adapter",
        requirement: "ContributionMissing",
      },
    ]);
  });

  it("emits no success finding for a ready binding", () => {
    expect(
      hostIntegrationStatusToHealthFindings(
        inventory({ state: "ready", reason: "ProviderReady", message: "ready" }),
      ),
    ).toEqual([]);
  });

  it("reports unresolved owner evidence without copying owner messages", () => {
    expect(hostIntegrationStatusToHealthFindings(inventory())).toEqual([
      {
        checkId: HOST_INTEGRATION_BINDINGS_CHECK_ID,
        severity: "warning",
        message:
          "Host integration example/provider-adapter is unresolved for model-provider/model-provider-adapter in bundle example/host@1.0.0 (OwnerEvidenceUnavailable).",
        target: "example/provider-adapter",
        requirement: "OwnerEvidenceUnavailable",
        fixHint:
          "Reload owner model-provider and verify it publishes status for bundle example/host@1.0.0.",
      },
    ]);
  });

  it("reports required missing contributions as errors", () => {
    expect(
      hostIntegrationStatusToHealthFindings(
        inventory({
          status: "missing",
          state: "unavailable",
          reason: "ContributionMissing",
          message: "required contribution is missing",
        }),
      ),
    ).toMatchObject([
      {
        severity: "error",
        requirement: "ContributionMissing",
        fixHint:
          "Enable a host package that registers example/provider-adapter with contract example-provider-adapter/v1, then restart OpenClaw.",
      },
    ]);
  });

  it("keeps optional incompatibility and stale carrier evidence actionable warnings", () => {
    expect(
      hostIntegrationStatusToHealthFindings(
        inventory({
          required: false,
          status: "incompatible",
          state: "degraded",
          reason: "ContributionIncompatible",
          message: "optional contribution is incompatible",
        }),
      ),
    ).toMatchObject([{ severity: "warning", requirement: "ContributionIncompatible" }]);

    expect(
      hostIntegrationStatusToHealthFindings(
        inventory({
          state: "stale",
          reason: "OwnerEvidenceBundleGenerationMismatch",
          message: "old generation carried a bearer token",
          config: { source: "openclaw.json", path: "plugins.entries.example-host" },
          generations: {
            bundle: "example/host@1.0.0",
            owner: "owner-2",
            carrier: "carrier-1",
            carrierIncarnation: "process-9",
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        severity: "warning",
        source: "openclaw.json",
        path: "plugins.entries.example-host",
        requirement: "OwnerEvidenceBundleGenerationMismatch",
        fixHint:
          "Reload owner model-provider and its carrier so they publish status for bundle example/host@1.0.0.",
      }),
    ]);
  });

  it("uses owner reload disposition for owner-specific failures", () => {
    expect(
      hostIntegrationStatusToHealthFindings(
        inventory({
          state: "unavailable",
          reason: "CredentialSlotUnavailable",
          message: "secret value should remain hidden",
          config: { source: "openclaw.json", path: "plugins.entries.example-host" },
          reloadDisposition: "restart-required",
        }),
      ),
    ).toMatchObject([
      {
        severity: "error",
        requirement: "CredentialSlotUnavailable",
        path: "plugins.entries.example-host",
        fixHint: "Correct plugins.entries.example-host, then restart OpenClaw.",
      },
    ]);
  });

  it("does not expose unrecognized owner reason text", () => {
    expect(
      hostIntegrationStatusToHealthFindings(
        inventory({
          state: "degraded",
          reason: "Bearer abc123 should never appear",
          message: "another sensitive field",
        }),
      ),
    ).toMatchObject([
      {
        message:
          "Host integration example/provider-adapter is degraded for model-provider/model-provider-adapter in bundle example/host@1.0.0 (OwnerReportedDegraded).",
        requirement: "OwnerReportedDegraded",
      },
    ]);
  });
});
