import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";

function registration(
  check: PluginReadinessCriterionRegistration["criterion"]["check"],
): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    criterion: { id: "backend", check },
    source: "/plugins/storage/index.js",
  };
}

describe("createPluginReadinessResolver", () => {
  it("evaluates registered criteria as advisory and coalesces cached calls", async () => {
    const check = vi.fn(() => ({
      status: "True" as const,
      reason: "StorageReady",
      message: "Storage is ready.",
    }));
    const criterion = registration(check);
    const resolve = createPluginReadinessResolver();

    const first = await resolve({ registry: { readinessCriteria: [criterion] }, config: {} });
    const second = await resolve({ registry: { readinessCriteria: [criterion] }, config: {} });

    expect(first).toEqual([
      expect.objectContaining({
        type: "plugin.storage.backend",
        status: "True",
        requirement: "advisory",
      }),
    ]);
    expect(second).toEqual(first);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("turns timeout and thrown errors into stable unknown evidence", async () => {
    const timeoutCriterion = registration(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const resolveTimeout = createPluginReadinessResolver({ timeoutMs: 5, cacheTtlMs: 0 });
    const [timedOut] = await resolveTimeout({
      registry: { readinessCriteria: [timeoutCriterion] },
      config: {},
    });
    expect(timedOut).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });

    const failedCriterion = registration(() => {
      throw new Error("backend offline");
    });
    const resolveFailure = createPluginReadinessResolver({ cacheTtlMs: 0 });
    const [failed] = await resolveFailure({
      registry: { readinessCriteria: [failedCriterion] },
      config: {},
    });
    expect(failed).toMatchObject({ status: "Unknown", reason: "CriterionCheckFailed" });
  });
});
