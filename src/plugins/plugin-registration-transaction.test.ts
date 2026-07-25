import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentProviderRequestTrafficPolicyV1,
  registerProviderRequestTrafficPolicyV1,
  type ProviderRequestTrafficPolicyRegistrationV1,
} from "../agents/provider-request-traffic-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginHostRuntimeState } from "./host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "./host-hook-runtime.test-fixtures.js";
import { clearActivatedPluginRuntimeState } from "./loader-shared.js";
import {
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
} from "./memory-state.test-fixtures.js";
import {
  createPluginRegistrationTransaction,
  type PluginProcessGlobalState,
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  getSessionDiscussionProvider,
  registerSessionDiscussionProvider,
  type SessionDiscussionProvider,
} from "./session-discussion-registry.js";
import { createPluginRecord } from "./status.test-helpers.js";

function discussionProvider(id: string): SessionDiscussionProvider {
  return {
    id,
    info: vi.fn().mockResolvedValue({ state: "available" }),
    open: vi.fn().mockResolvedValue({ state: "open" }),
  };
}

function createSchedulerPlugin(pluginId: string) {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
  });
  const api = pluginRegistry.createApi(createPluginRecord({ id: pluginId }), {
    config: {} as OpenClawConfig,
  });
  return { api, pluginRegistry };
}

describe("plugin registration transaction", () => {
  let initialProcessGlobalState: PluginProcessGlobalState;

  beforeEach(() => {
    initialProcessGlobalState = snapshotPluginProcessGlobalState();
  });

  afterEach(() => {
    clearPluginHostRuntimeState();
    restorePluginProcessGlobalState(initialProcessGlobalState);
  });

  it("rolls back registry writes and restores prior process-global capability state", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const failedResolver = () => "failed";
    const rollbackGlobalSideEffects = vi.fn();
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({
      registry,
      rollbackGlobalSideEffects,
    });
    registry.hostedMediaResolvers.push({
      pluginId: "failed-plugin",
      resolver: failedResolver,
      source: "failed-plugin",
    });
    registry.gatewayHandlers.failed = async () => {};
    registerMemoryCapability("failed-memory", { promptBuilder: () => ["failed"] });

    transaction.rollback();

    expect(rollbackGlobalSideEffects).toHaveBeenCalledOnce();
    expect(registry.hostedMediaResolvers).toStrictEqual([]);
    expect(registry.gatewayHandlers).toStrictEqual({});
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("keeps snapshot registry writes while restoring globals for non-activating commits", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const snapshotResolver = () => "snapshot";
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({ registry });
    registry.hostedMediaResolvers.push({
      pluginId: "snapshot-plugin",
      resolver: snapshotResolver,
      source: "snapshot-plugin",
    });
    registerMemoryCapability("snapshot-memory", { promptBuilder: () => ["snapshot"] });

    transaction.commit({ activate: false });

    expect(registry.hostedMediaResolvers).toEqual([
      {
        pluginId: "snapshot-plugin",
        resolver: snapshotResolver,
        source: "snapshot-plugin",
      },
    ]);
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("clears the discussion provider before repeated active plugin activation", () => {
    registerSessionDiscussionProvider(discussionProvider("clickclack"));

    clearActivatedPluginRuntimeState();

    expect(getSessionDiscussionProvider()).toBeUndefined();
  });

  it("restores the prior discussion provider when plugin activation rolls back", () => {
    const activeProvider = discussionProvider("clickclack");
    registerSessionDiscussionProvider(activeProvider);
    const transaction = createPluginRegistrationTransaction({});
    registerSessionDiscussionProvider(discussionProvider("replacement"));

    transaction.rollback();

    expect(getSessionDiscussionProvider()).toBe(activeProvider);
  });

  it("rolls back only scheduler jobs owned by the failed registry", async () => {
    const pluginId = "scheduler-plugin";
    const failedCleanup = vi.fn();
    const activeCleanup = vi.fn();
    const active = createSchedulerPlugin(pluginId);
    const failed = createSchedulerPlugin(pluginId);

    active.api.registerSessionSchedulerJob({
      id: "active-job",
      sessionKey: "agent:main:main",
      kind: "monitor",
      cleanup: activeCleanup,
    });
    const transaction = createPluginRegistrationTransaction({
      registry: failed.pluginRegistry.registry,
      rollbackGlobalSideEffects: () =>
        failed.pluginRegistry.rollbackPluginGlobalSideEffects(pluginId),
    });
    failed.api.registerSessionSchedulerJob({
      id: "failed-job",
      sessionKey: "agent:main:main",
      kind: "monitor",
      cleanup: failedCleanup,
    });

    transaction.rollback();
    await vi.waitFor(() => {
      expect(failedCleanup).toHaveBeenCalledOnce();
    });

    expect(failedCleanup).toHaveBeenCalledWith({
      reason: "disable",
      sessionKey: "agent:main:main",
      jobId: "failed-job",
    });
    expect(activeCleanup).not.toHaveBeenCalled();
    expect(listPluginSessionSchedulerJobs(pluginId)).toStrictEqual([
      {
        id: "active-job",
        pluginId,
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
    expect(failed.pluginRegistry.registry.sessionSchedulerJobs).toStrictEqual([]);
    expect(active.pluginRegistry.registry.sessionSchedulerJobs).toHaveLength(1);
  });
});

function trafficPolicy(generation: string): ProviderRequestTrafficPolicyRegistrationV1 {
  return {
    version: "provider-request-traffic-policy/v1",
    id: "example/enterprise-egress",
    generation,
    required: true,
    provenance: { source: "test", revision: generation },
    routeProfiles: [{ id: "example/direct", dispatcherPolicy: { mode: "direct" } }],
    rules: [
      {
        id: "example-llm",
        match: { providers: ["example"] },
        outcome: {
          action: "allow",
          routeProfileId: "example/direct",
          allowedOrigins: ["https://provider.example.test"],
          allowPrivateNetwork: false,
        },
      },
    ],
  };
}

it("clears traffic policy before repeated active plugin activation", () => {
  registerProviderRequestTrafficPolicyV1(trafficPolicy("active"));

  clearActivatedPluginRuntimeState();

  expect(getCurrentProviderRequestTrafficPolicyV1()).toBeUndefined();
});

it("restores the prior traffic policy when plugin activation rolls back", () => {
  registerProviderRequestTrafficPolicyV1(trafficPolicy("active"));
  const transaction = createPluginRegistrationTransaction({});
  registerProviderRequestTrafficPolicyV1(trafficPolicy("replacement"));

  transaction.rollback();

  expect(getCurrentProviderRequestTrafficPolicyV1()?.generation).toBe("active");
});
