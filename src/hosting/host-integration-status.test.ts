import { describe, expect, it } from "vitest";
import type { HostIntegrationBundleSnapshotV1 } from "./host-integration-bundle.js";
import {
  buildHostIntegrationStatusInventoryV1,
  clearCurrentHostIntegrationOwnerEvidenceV1,
  getCurrentHostIntegrationOwnerEvidenceV1,
  publishHostIntegrationOwnerEvidenceV1,
  type HostIntegrationBindingStateV1,
  type HostIntegrationOwnerEvidenceV1,
} from "./host-integration-status.js";

function bundle(status: "resolved" | "missing" | "incompatible" = "resolved") {
  return {
    version: "host-integration-bundle/v1",
    id: "lobster/capi",
    bundleVersion: "1.2.3",
    inventory: [
      {
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "lobster/capi",
        version: "capi-model-adapter/v1",
        required: status !== "incompatible",
        readinessCriteria: ["CapiReady"],
        status,
        ...(status === "resolved"
          ? {
              resolvedVersion: "capi-model-adapter/v1",
              provenance: {
                pluginId: "lobster",
                source: "/plugins/lobster",
                origin: "workspace",
              },
            }
          : {}),
      },
    ],
  } satisfies HostIntegrationBundleSnapshotV1;
}

function evidence(state: Exclude<HostIntegrationBindingStateV1, "unresolved">) {
  return {
    owner: "model-provider",
    kind: "model-provider-adapter",
    id: "lobster/capi",
    bundleGeneration: "lobster/capi@1.2.3",
    state,
    reason: `Owner${state}`,
    message: `Owner reported ${state}.`,
    config: { source: "openclaw.json", path: "models.providers.capi" },
    ownerGeneration: "owner-7",
    carrierGeneration: "carrier-3",
    carrierIncarnation: "process-2",
    reloadDisposition: "reload-required",
    authorityMode: "host",
  } satisfies HostIntegrationOwnerEvidenceV1;
}

describe("host integration status inventory", () => {
  it("publishes immutable owner evidence atomically", () => {
    const published = publishHostIntegrationOwnerEvidenceV1([evidence("ready")]);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published[0])).toBe(true);
    expect(Object.isFrozen(published[0]?.config)).toBe(true);
    expect(() =>
      publishHostIntegrationOwnerEvidenceV1([evidence("ready"), evidence("stale")]),
    ).toThrow("Duplicate host integration owner evidence");
    expect(getCurrentHostIntegrationOwnerEvidenceV1()).toBe(published);
    clearCurrentHostIntegrationOwnerEvidenceV1();
  });

  it.each(["ready", "degraded", "unavailable", "stale"] as const)(
    "projects owner-reported %s state with separate generations",
    (state) => {
      expect(
        buildHostIntegrationStatusInventoryV1({
          bundle: bundle(),
          ownerEvidence: [evidence(state)],
        }),
      ).toMatchObject({
        state,
        bundle: { generation: "lobster/capi@1.2.3" },
        entries: [
          {
            state,
            config: { source: "openclaw.json", path: "models.providers.capi" },
            generations: {
              bundle: "lobster/capi@1.2.3",
              owner: "owner-7",
              carrier: "carrier-3",
              carrierIncarnation: "process-2",
            },
            reloadDisposition: "reload-required",
            authorityMode: "host",
          },
        ],
      });
    },
  );

  it("reports unresolved when owner evidence is absent", () => {
    expect(buildHostIntegrationStatusInventoryV1({ bundle: bundle() })).toMatchObject({
      state: "unresolved",
      entries: [{ state: "unresolved", reason: "OwnerEvidenceUnavailable" }],
    });
  });

  it("reports evidence from a previous bundle generation as stale", () => {
    expect(
      buildHostIntegrationStatusInventoryV1({
        bundle: bundle(),
        ownerEvidence: [{ ...evidence("ready"), bundleGeneration: "lobster/capi@1.2.2" }],
      }),
    ).toMatchObject({
      state: "stale",
      entries: [
        {
          state: "stale",
          reason: "OwnerEvidenceBundleGenerationMismatch",
          generations: { bundle: "lobster/capi@1.2.3", owner: "owner-7" },
        },
      ],
    });
  });

  it("derives required and optional failures from bundle inventory", () => {
    expect(buildHostIntegrationStatusInventoryV1({ bundle: bundle("missing") })).toMatchObject({
      state: "unavailable",
      entries: [{ state: "unavailable", reason: "ContributionMissing" }],
    });
    expect(buildHostIntegrationStatusInventoryV1({ bundle: bundle("incompatible") })).toMatchObject(
      {
        state: "degraded",
        entries: [{ state: "degraded", reason: "ContributionIncompatible" }],
      },
    );
  });
});
