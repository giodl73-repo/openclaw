import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createSelectedReadinessResolver, resolveSelectedReadinessCriteria } from "./selection.js";

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

describe("resolveSelectedReadinessCriteria", () => {
  it("lets required selection win over advisory selection defensively", () => {
    expect(
      resolveSelectedReadinessCriteria({
        gateway: {
          readiness: {
            requiredCriteria: ["plugin.storage.backend"],
            advisoryCriteria: ["plugin.storage.backend", "plugin.metrics.exporter"],
          },
        },
      }),
    ).toEqual([
      { id: "plugin.storage.backend", requirement: "required" },
      { id: "plugin.metrics.exporter", requirement: "advisory" },
    ]);
  });
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
          gateway: { readiness: { requiredCriteria: ["plugin.storage.backend"] } },
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
