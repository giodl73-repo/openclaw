import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderRequestDispatchersV1,
  resolveProviderRequestDispatcherV1,
} from "../agents/provider-request-dispatcher.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

afterEach(() => {
  clearProviderRequestDispatchersV1();
});

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function record(id: string) {
  return createPluginRecord({
    id,
    name: id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
}

function registration() {
  return {
    version: "provider-request-dispatcher/v1" as const,
    id: "example/egress",
    trafficPolicyId: "example/traffic",
    trafficPolicyGeneration: "generation-7",
    dispatch: vi.fn(async () => new Response("ok")),
  };
}

describe("plugin provider-request dispatcher registration", () => {
  it("publishes a plugin-attributed binding and disposes it", () => {
    const pluginRegistry = createPluginRegistry({ logger, runtime: createPluginRuntime() });
    const api = pluginRegistry.createApi(record("example-host"), {
      config: {} as OpenClawConfig,
    });
    const candidate = registration();

    const unregister = api.registerProviderRequestDispatcher(candidate);
    expect(
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: candidate.trafficPolicyGeneration,
      }),
    ).toMatchObject({ owner: "plugin:example-host" });

    unregister();
    expect(() =>
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: candidate.trafficPolicyGeneration,
      }),
    ).toThrow("unavailable");
  });

  it("suppresses inactive loads and rolls back only the owning plugin", () => {
    const candidate = registration();
    const inactiveRegistry = createPluginRegistry({
      logger,
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    inactiveRegistry
      .createApi(record("inactive-host"), { config: {} as OpenClawConfig })
      .registerProviderRequestDispatcher(candidate);
    expect(() =>
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: candidate.trafficPolicyGeneration,
      }),
    ).toThrow("unavailable");

    const activeRegistry = createPluginRegistry({ logger, runtime: createPluginRuntime() });
    activeRegistry
      .createApi(record("example-host"), { config: {} as OpenClawConfig })
      .registerProviderRequestDispatcher(candidate);
    expect(() =>
      activeRegistry
        .createApi(record("other-host"), { config: {} as OpenClawConfig })
        .registerProviderRequestDispatcher(registration()),
    ).toThrow("already registered");

    activeRegistry.rollbackPluginGlobalSideEffects("other-host");
    expect(
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: candidate.trafficPolicyGeneration,
      }).owner,
    ).toBe("plugin:example-host");
    activeRegistry.rollbackPluginGlobalSideEffects("example-host");
    expect(() =>
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: candidate.trafficPolicyGeneration,
      }),
    ).toThrow("unavailable");
  });
});
