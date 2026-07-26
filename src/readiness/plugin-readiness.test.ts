import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";

function registration(
  check: PluginReadinessCriterionRegistration["criterion"]["check"],
): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    criterion: {
      id: "backend",
      description: "Reports storage backend availability.",
      check,
    },
    source: "/plugins/storage/index.js",
  };
}

describe("createPluginReadinessResolver", () => {
  it("evaluates only selected criteria and coalesces cached calls", async () => {
    const check = vi.fn(() => ({
      status: "True" as const,
      reason: "StorageReady",
      message: "Storage is ready.",
    }));
    const ignored = vi.fn(() => ({
      status: "True" as const,
      reason: "IgnoredReady",
      message: "Ignored.",
    }));
    const criterion = registration(check);
    const resolve = createPluginReadinessResolver();
    const registry = {
      readinessCriteria: [criterion, { ...registration(ignored), id: "plugin.storage.ignored" }],
    };
    const config = {};

    const first = await resolve({
      registry,
      config,
      criterionIds: new Set(["plugin.storage.backend"]),
    });
    const second = await resolve({
      registry,
      config,
      criterionIds: new Set(["plugin.storage.backend"]),
    });

    expect(first).toEqual([
      expect.objectContaining({ type: "plugin.storage.backend", status: "True" }),
    ]);
    expect(second).toEqual(first);
    expect(check).toHaveBeenCalledTimes(1);
    expect(ignored).not.toHaveBeenCalled();
  });

  it("turns timeout and thrown errors into stable unknown evidence", async () => {
    const resolveTimeout = createPluginReadinessResolver({ timeoutMs: 5, cacheTtlMs: 0 });
    await expect(
      resolveTimeout({
        registry: { readinessCriteria: [registration(() => new Promise(() => {}))] },
        config: {},
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "Unknown", reason: "CriterionTimedOut" }),
    ]);

    const resolveFailure = createPluginReadinessResolver({ cacheTtlMs: 0 });
    await expect(
      resolveFailure({
        registry: {
          readinessCriteria: [
            registration(() => {
              throw new Error("backend offline");
            }),
          ],
        },
        config: {},
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "Unknown", reason: "CriterionCheckFailed" }),
    ]);
  });

  it("does not overlap a retry while a timed-out criterion is still pending", async () => {
    let release: (() => void) | undefined;
    const first = new Promise<{
      status: "True";
      reason: string;
      message: string;
    }>((resolve) => {
      release = () => resolve({ status: "True", reason: "LateReady", message: "Ready late." });
    });
    const check = vi
      .fn<PluginReadinessCriterionRegistration["criterion"]["check"]>()
      .mockReturnValueOnce(first)
      .mockReturnValue({ status: "True", reason: "Ready", message: "Ready." });
    const resolve = createPluginReadinessResolver({ timeoutMs: 5, cacheTtlMs: 0 });
    const registry = { readinessCriteria: [registration(check)] };
    const config = {};

    const timedOut = await resolve({ registry, config });
    const stillPending = await resolve({ registry, config });

    expect(timedOut[0]).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });
    expect(stillPending).toEqual(timedOut);
    expect(check).toHaveBeenCalledTimes(1);

    release?.();
    await first;
    await new Promise<void>((resolvePending) => {
      queueMicrotask(resolvePending);
    });
    const retried = await resolve({ registry, config });

    expect(retried[0]).toMatchObject({ status: "True", reason: "Ready" });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("allows one bounded recovery probe when a timed-out callback never settles", async () => {
    let now = 0;
    const check = vi
      .fn<PluginReadinessCriterionRegistration["criterion"]["check"]>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValue({ status: "True", reason: "Recovered", message: "Recovered." });
    const resolve = createPluginReadinessResolver({
      timeoutMs: 5,
      cacheTtlMs: 0,
      pendingRetryMs: 10,
      now: () => now,
    });
    const registry = { readinessCriteria: [registration(check)] };
    const config = {};

    const timedOut = await resolve({ registry, config });
    now = 11;
    const recovered = await resolve({ registry, config });

    expect(timedOut[0]).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });
    expect(recovered[0]).toMatchObject({ status: "True", reason: "Recovered" });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("isolates concurrent evaluations for different registry and config snapshots", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstCheck = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{
          status: "True";
          reason: string;
          message: string;
        }>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("unexpected cancellation")));
          releaseFirst = () =>
            resolve({ status: "True", reason: "FirstReady", message: "First ready." });
        }),
    );
    const secondCheck = vi.fn(() => ({
      status: "True" as const,
      reason: "SecondReady",
      message: "Second ready.",
    }));
    const resolve = createPluginReadinessResolver({ timeoutMs: 100 });
    const firstRegistry = { readinessCriteria: [registration(firstCheck)] };
    const secondRegistry = {
      readinessCriteria: [{ ...registration(secondCheck), id: "plugin.storage.second-backend" }],
    };

    const first = resolve({ registry: firstRegistry, config: {} });
    await vi.waitFor(() => expect(firstCheck).toHaveBeenCalledTimes(1));
    const second = await resolve({ registry: secondRegistry, config: { second: true } as never });
    releaseFirst?.();

    await expect(first).resolves.toEqual([
      expect.objectContaining({ status: "True", reason: "FirstReady" }),
    ]);
    expect(second).toEqual([expect.objectContaining({ status: "True", reason: "SecondReady" })]);
  });

  it("redacts valid messages and rejects malformed or oversized output", async () => {
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });
    const [redacted] = await resolve({
      registry: {
        readinessCriteria: [
          registration(() => ({
            status: "False",
            reason: "StorageUnavailable",
            message: "Storage failed with password=super-secret-value-that-must-not-escape",
          })),
        ],
      },
      config: {},
    });
    expect(redacted).toMatchObject({ status: "False", reason: "StorageUnavailable" });
    expect(redacted?.message).not.toContain("super-secret-value-that-must-not-escape");

    const [invalid] = await resolve({
      registry: {
        readinessCriteria: [
          registration(() => ({
            status: "False",
            reason: "Bad\nReason",
            message: "x".repeat(513),
          })),
        ],
      },
      config: { changed: true } as never,
    });
    expect(invalid).toMatchObject({ status: "Unknown", reason: "CriterionInvalidResult" });
  });
});
