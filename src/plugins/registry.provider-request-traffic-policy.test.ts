import { afterEach, describe, expect, it } from "vitest";
import {
  clearCurrentProviderRequestTrafficPolicyV1,
  getCurrentProviderRequestTrafficPolicyV1,
} from "../agents/provider-request-traffic-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

afterEach(() => {
  clearCurrentProviderRequestTrafficPolicyV1();
});

describe("plugin provider-request traffic-policy registration", () => {
  it("publishes a compiled generation and returns a snapshot-scoped disposer", () => {
    const pluginRegistry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
    });
    const record = createPluginRecord({
      id: "example-host",
      name: "Example Host",
      source: "/plugins/example-host/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, {
      config: {} as OpenClawConfig,
    });

    const unregister = api.registerProviderRequestTrafficPolicy({
      version: "provider-request-traffic-policy/v1",
      id: "example/enterprise-egress",
      generation: "generation-7",
      required: true,
      provenance: {
        source: "example-managed-policy",
        revision: "revision-4",
      },
      routeProfiles: [
        {
          id: "example/direct",
          dispatcherPolicy: { mode: "direct" },
        },
      ],
      rules: [
        {
          id: "example-llm",
          match: {
            providers: ["example"],
            capabilities: ["llm"],
          },
          outcome: {
            action: "allow",
            routeProfileId: "example/direct",
            allowedOrigins: ["https://provider.example.test"],
            allowPrivateNetwork: false,
          },
        },
      ],
    });

    expect(getCurrentProviderRequestTrafficPolicyV1()).toMatchObject({
      id: "example/enterprise-egress",
      generation: "generation-7",
      readiness: "ready",
    });
    unregister();
    expect(getCurrentProviderRequestTrafficPolicyV1()).toBeUndefined();
  });

  it("does not publish during inactive loads and rolls back failed activation", () => {
    const record = createPluginRecord({
      id: "example-host",
      name: "Example Host",
      source: "/plugins/example-host/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const registration = {
      version: "provider-request-traffic-policy/v1" as const,
      id: "example/enterprise-egress",
      generation: "generation-7",
      required: true,
      provenance: {
        source: "example-managed-policy",
        revision: "revision-4",
      },
      routeProfiles: [
        {
          id: "example/direct",
          dispatcherPolicy: { mode: "direct" as const },
        },
      ],
      rules: [
        {
          id: "example-llm",
          match: { providers: ["example"] },
          outcome: {
            action: "allow" as const,
            routeProfileId: "example/direct",
            allowedOrigins: ["https://provider.example.test"],
            allowPrivateNetwork: false,
          },
        },
      ],
    };
    const inactiveRegistry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    inactiveRegistry
      .createApi(record, { config: {} as OpenClawConfig })
      .registerProviderRequestTrafficPolicy(registration);
    expect(getCurrentProviderRequestTrafficPolicyV1()).toBeUndefined();

    const activeRegistry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
    });
    activeRegistry
      .createApi(record, { config: {} as OpenClawConfig })
      .registerProviderRequestTrafficPolicy(registration);
    expect(getCurrentProviderRequestTrafficPolicyV1()?.generation).toBe("generation-7");

    const otherRecord = createPluginRecord({
      id: "other-host",
      name: "Other Host",
      source: "/plugins/other-host/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    expect(() =>
      activeRegistry
        .createApi(otherRecord, { config: {} as OpenClawConfig })
        .registerProviderRequestTrafficPolicy(registration),
    ).toThrow("another owner");
    expect(getCurrentProviderRequestTrafficPolicyV1()?.generation).toBe("generation-7");

    activeRegistry.rollbackPluginGlobalSideEffects(record.id);
    expect(getCurrentProviderRequestTrafficPolicyV1()).toBeUndefined();
  });
});
