import { describe, expect, it } from "vitest";
import type { HostIntegrationBundleSnapshotV1 } from "../hosting/host-integration-bundle.js";
import type { HostIntegrationOwnerEvidenceV1 } from "../hosting/host-integration-status.js";
import { buildHostBindingsReadinessCondition } from "./host-bindings.js";

function bundle(): HostIntegrationBundleSnapshotV1 {
  return {
    version: "host-integration-bundle/v1",
    id: "example/host",
    bundleVersion: "1.0.0",
    generation: "bundle-1",
    inventory: [
      {
        owner: "provider-request",
        kind: "credential-slot-resolver",
        id: "example/credentials",
        version: "v1",
        required: true,
        readinessCriteria: ["plugin.example-host.provider-credentials"],
        status: "resolved",
        resolvedVersion: "v1",
        provenance: { pluginId: "example", source: "test", origin: "bundled" },
      },
      {
        owner: "provider-request",
        kind: "provider-request-dispatcher",
        id: "example/dispatcher",
        version: "v1",
        required: false,
        readinessCriteria: ["plugin.example-host.provider-dispatch"],
        status: "resolved",
        resolvedVersion: "v1",
        provenance: { pluginId: "example", source: "test", origin: "bundled" },
      },
    ],
  };
}

function evidence(params: {
  id: string;
  kind: "credential-slot-resolver" | "provider-request-dispatcher";
  state: HostIntegrationOwnerEvidenceV1["state"];
  generation?: string;
}): HostIntegrationOwnerEvidenceV1 {
  return {
    owner: "provider-request",
    kind: params.kind,
    id: params.id,
    bundleGeneration: params.generation ?? "bundle-1",
    state: params.state,
    reason: "OwnerReported",
    message: "Owner status is available.",
  };
}

describe("host binding readiness", () => {
  it("reports Unknown when no bundle has published status", () => {
    expect(buildHostBindingsReadinessCondition({ bundle: null })).toMatchObject({
      type: "HostBindingsReady",
      status: "Unknown",
      reason: "HostIntegrationBundleUnavailable",
    });
  });

  it("reports True when every required binding is ready", () => {
    expect(
      buildHostBindingsReadinessCondition({
        bundle: bundle(),
        ownerEvidence: [
          evidence({
            id: "example/credentials",
            kind: "credential-slot-resolver",
            state: "ready",
          }),
        ],
      }),
    ).toMatchObject({ status: "True", reason: "HostBindingsReady" });
  });

  it("does not block on an optional degraded binding", () => {
    expect(
      buildHostBindingsReadinessCondition({
        bundle: bundle(),
        ownerEvidence: [
          evidence({
            id: "example/credentials",
            kind: "credential-slot-resolver",
            state: "ready",
          }),
          evidence({
            id: "example/dispatcher",
            kind: "provider-request-dispatcher",
            state: "degraded",
          }),
        ],
      }),
    ).toMatchObject({ status: "True", reason: "HostBindingsReady" });
  });

  it("fails closed for stale required owner evidence", () => {
    expect(
      buildHostBindingsReadinessCondition({
        bundle: bundle(),
        ownerEvidence: [
          evidence({
            id: "example/credentials",
            kind: "credential-slot-resolver",
            state: "ready",
            generation: "bundle-0",
          }),
        ],
      }),
    ).toMatchObject({ status: "False", reason: "HostBindingsNotReady" });
  });

  it("rejects oversized status inventories without iterating them", () => {
    const oversized = bundle();
    oversized.inventory = Array.from({ length: 257 }, () => oversized.inventory[0]!);
    expect(
      buildHostBindingsReadinessCondition({ bundle: oversized, ownerEvidence: [] }),
    ).toMatchObject({ status: "False", reason: "HostBindingsInventoryTooLarge" });
  });
});
