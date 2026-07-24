import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
} from "../hosting/host-integration-bundle.js";
import {
  clearCurrentHostIntegrationOwnerEvidenceV1,
  publishHostIntegrationOwnerEvidenceV1,
} from "../hosting/host-integration-status.js";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createSelectedReadinessResolver } from "./selection.js";

function pluginCriterion(): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    source: "/plugins/storage/index.js",
    criterion: {
      id: "backend",
      description: "Reports storage backend availability.",
      check: vi.fn(() => ({
        status: "False" as const,
        reason: "StorageUnavailable",
        message: "Storage is unavailable.",
      })),
    },
  };
}

function registerReadyHostBundle(): void {
  const bundle = registerHostIntegrationBundleV1({
    manifest: {
      version: "host-integration-bundle/v1",
      id: "example/host",
      bundleVersion: "1.0.0",
      contributions: [
        {
          owner: "provider-request",
          kind: "credential-slot-resolver",
          id: "example/credentials",
          version: "v1",
          required: true,
          readinessCriteria: ["plugin.example-host.provider-ready"],
        },
      ],
    },
    availableContributions: [
      {
        owner: "provider-request",
        kind: "credential-slot-resolver",
        id: "example/credentials",
        version: "v1",
        provenance: { pluginId: "example-host", source: "test", origin: "bundled" },
      },
    ],
  });
  publishHostIntegrationOwnerEvidenceV1([
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "example/credentials",
      bundleGeneration: bundle.generation,
      state: "ready",
      reason: "OwnerReady",
      message: "Owner binding is ready.",
    },
  ]);
}

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
  clearCurrentHostIntegrationOwnerEvidenceV1();
});

describe("createSelectedReadinessResolver", () => {
  it("does no provider work when no criteria are selected", async () => {
    const criterion = pluginCriterion();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({ config: {}, registry: { readinessCriteria: [criterion] } }),
    ).resolves.toEqual([]);
    expect(criterion.criterion.check).not.toHaveBeenCalled();
  });

  it("promotes only operator-selected plugin criteria to required", async () => {
    const criterion = pluginCriterion();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: {
            readiness: {
              requiredCriteria: ["plugin.storage.backend"],
              advisoryCriteria: ["plugin.storage.backend"],
            },
          },
        },
        registry: { readinessCriteria: [criterion] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "plugin.storage.backend",
        status: "False",
        requirement: "required",
        reason: "StorageUnavailable",
      }),
    ]);
  });

  it("maps the core selector id to its canonical condition type", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-selected-readiness-"));
    const resolve = createSelectedReadinessResolver();

    try {
      await expect(
        resolve({
          config: {
            agents: { defaults: { workspace } },
            gateway: { readiness: { requiredCriteria: ["openclaw.workspace-writable"] } },
          },
          registry: { readinessCriteria: [] },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          type: "WorkspaceWritable",
          status: "True",
          requirement: "required",
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when required host bindings have not published status", async () => {
    clearCurrentHostIntegrationBundleSnapshotV1();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.host-bindings-ready"] } },
        },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "HostBindingsReady",
        status: "Unknown",
        requirement: "required",
        reason: "HostIntegrationBundleUnavailable",
      }),
    ]);
  });

  it("adds bundle criteria as advisory and fails the aggregate when one is unavailable", async () => {
    registerReadyHostBundle();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.host-bindings-ready"] } },
        },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "HostBindingsReady",
        status: "False",
        requirement: "required",
        reason: "HostBindingsNotReady",
      }),
      expect.objectContaining({
        type: "plugin.example-host.provider-ready",
        status: "Unknown",
        requirement: "advisory",
        reason: "CriterionNotRegistered",
      }),
    ]);
  });

  it("evaluates registered bundle criteria as advisory without promoting them", async () => {
    registerReadyHostBundle();
    const resolve = createSelectedReadinessResolver();
    const detail: PluginReadinessCriterionRegistration = {
      id: "plugin.example-host.provider-ready",
      pluginId: "example-host",
      source: "test",
      criterion: {
        id: "provider-ready",
        description: "Reports provider binding readiness.",
        check: vi.fn(() => ({
          status: "True" as const,
          reason: "ProviderReady",
          message: "Provider binding is ready.",
        })),
      },
    };

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.host-bindings-ready"] } },
        },
        registry: { readinessCriteria: [detail] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "HostBindingsReady",
        status: "True",
        requirement: "required",
      }),
      expect.objectContaining({
        type: "plugin.example-host.provider-ready",
        status: "True",
        requirement: "advisory",
      }),
    ]);
    expect(detail.criterion.check).toHaveBeenCalledTimes(1);
  });

  it("fails the aggregate when a required binding criterion is not ready", async () => {
    registerReadyHostBundle();
    const resolve = createSelectedReadinessResolver();
    const detail: PluginReadinessCriterionRegistration = {
      id: "plugin.example-host.provider-ready",
      pluginId: "example-host",
      source: "test",
      criterion: {
        id: "provider-ready",
        description: "Reports provider binding readiness.",
        check: () => ({
          status: "False",
          reason: "ProviderUnavailable",
          message: "Provider binding is unavailable.",
        }),
      },
    };

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.host-bindings-ready"] } },
        },
        registry: { readinessCriteria: [detail] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "HostBindingsReady",
        status: "False",
        requirement: "required",
        reason: "HostBindingCriteriaNotReady",
      }),
      expect.objectContaining({
        type: "plugin.example-host.provider-ready",
        status: "False",
        requirement: "advisory",
        reason: "ProviderUnavailable",
      }),
    ]);
  });

  it("fails closed for an unregistered required criterion", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: { gateway: { readiness: { requiredCriteria: ["plugin.missing.backend"] } } },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "plugin.missing.backend",
        status: "Unknown",
        requirement: "required",
        reason: "CriterionNotRegistered",
      }),
    ]);
  });
});
