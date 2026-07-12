import { describe, expect, it } from "vitest";
import { subscribeHostIntegrationAuthorityChanges } from "./host-integration-authority-events.js";
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
    id: "example/host",
    bundleVersion: "1.2.3",
    generation: "example/host@1.2.3#1",
    inventory: [
      {
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "example/provider-adapter",
        version: "example-provider-adapter/v1",
        required: status !== "incompatible",
        readinessCriteria: ["ProviderReady"],
        status,
        ...(status === "resolved"
          ? {
              resolvedVersion: "example-provider-adapter/v1",
              provenance: {
                pluginId: "example-host",
                source: "/plugins/example-host",
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
    id: "example/provider-adapter",
    bundleGeneration: "example/host@1.2.3#1",
    state,
    reason: `Owner${state}`,
    message: `Owner reported ${state}.`,
    config: { source: "openclaw.json", path: "plugins.entries.example-host" },
    ownerGeneration: "owner-7",
    carrierGeneration: "carrier-3",
    carrierIncarnation: "process-2",
    reloadDisposition: "reload-required",
    authorityMode: "host",
  } satisfies HostIntegrationOwnerEvidenceV1;
}

describe("host integration status inventory", () => {
  it("notifies authority listeners after owner evidence publication and clear", () => {
    const observed: Array<string | undefined> = [];
    const unsubscribe = subscribeHostIntegrationAuthorityChanges(() => {
      observed.push(getCurrentHostIntegrationOwnerEvidenceV1()[0]?.ownerGeneration);
    });

    try {
      publishHostIntegrationOwnerEvidenceV1([evidence("ready")]);
      clearCurrentHostIntegrationOwnerEvidenceV1();
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual(["owner-7", undefined]);
  });

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
        bundle: { generation: "example/host@1.2.3#1" },
        entries: [
          {
            state,
            config: { source: "openclaw.json", path: "plugins.entries.example-host" },
            generations: {
              bundle: "example/host@1.2.3#1",
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
        ownerEvidence: [{ ...evidence("ready"), bundleGeneration: "example/host@1.2.3#0" }],
      }),
    ).toMatchObject({
      state: "stale",
      entries: [
        {
          state: "stale",
          reason: "OwnerEvidenceBundleGenerationMismatch",
          generations: { bundle: "example/host@1.2.3#1", owner: "owner-7" },
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
