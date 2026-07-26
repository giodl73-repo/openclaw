import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderRequestDispatchersV1,
  resolveProviderRequestDispatcherV1,
  type ProviderRequestDispatcherRegistrationV1,
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

  it("materializes registered credential slots and hides their references from the dispatcher", async () => {
    const pluginRegistry = createPluginRegistry({ logger, runtime: createPluginRuntime() });
    const api = pluginRegistry.createApi(record("example-host"), {
      config: {} as OpenClawConfig,
    });
    const resolveCredential = vi.fn(async () => ({ value: "Bearer prepared" }));
    const dispatch = vi.fn(
      async (_request: Parameters<ProviderRequestDispatcherRegistrationV1["dispatch"]>[0]) =>
        new Response("ok"),
    );
    const candidate = {
      ...registration(),
      dispatch,
      credentialSlots: [
        {
          version: "credential-slot/v1" as const,
          slotId: "example/token",
          placement: "header" as const,
          headerName: "authorization",
          allowedOrigins: ["https://api.example.com"],
          required: true,
          resolverId: "example/token-resolver",
        },
      ],
    };
    api.registerProviderRequestDispatcher(candidate);
    api.registerCredentialSlotResolver({
      version: "credential-slot-resolver/v1",
      resolverId: "example/token-resolver",
      slotId: "example/token",
      placement: "header",
      headerName: "authorization",
      allowedOrigins: ["https://api.example.com"],
      resolve: resolveCredential,
    });

    const binding = resolveProviderRequestDispatcherV1({
      bindingId: candidate.id,
      trafficPolicyId: candidate.trafficPolicyId,
      trafficPolicyGeneration: candidate.trafficPolicyGeneration,
    });
    expect(binding.credentialSlotRefs).toEqual(["example/token"]);
    await binding.dispatch({
      url: "https://api.example.com/v1/messages",
      init: { method: "POST", redirect: "manual" },
      networkGuard: {} as never,
      credentialSlotRefs: [...binding.credentialSlotRefs],
    });

    expect(resolveCredential).toHaveBeenCalledOnce();
    const dispatched = dispatch.mock.calls[0]?.[0];
    expect(new Headers(dispatched?.init.headers).get("authorization")).toBe("Bearer prepared");
    expect(dispatched?.credentialSlotRefs).toEqual([]);
  });

  it("does not expose another plugin's credential resolver to a dispatcher", async () => {
    const pluginRegistry = createPluginRegistry({ logger, runtime: createPluginRuntime() });
    const victimApi = pluginRegistry.createApi(record("credential-owner"), {
      config: {} as OpenClawConfig,
    });
    const dispatcherApi = pluginRegistry.createApi(record("dispatch-owner"), {
      config: {} as OpenClawConfig,
    });
    victimApi.registerCredentialSlotResolver({
      version: "credential-slot-resolver/v1",
      resolverId: "example/private-resolver",
      slotId: "example/private-token",
      placement: "header",
      headerName: "x-private-token",
      allowedOrigins: ["https://api.example.com"],
      resolve: vi.fn(async () => ({ value: "must-not-leak" })),
    });
    const dispatch = vi.fn(async () => new Response("must not send"));
    const candidate = {
      ...registration(),
      dispatch,
      credentialSlots: [
        {
          version: "credential-slot/v1" as const,
          slotId: "example/private-token",
          placement: "header" as const,
          headerName: "x-private-token",
          allowedOrigins: ["https://api.example.com"],
          required: true,
          resolverId: "example/private-resolver",
        },
      ],
    };
    dispatcherApi.registerProviderRequestDispatcher(candidate);
    const binding = resolveProviderRequestDispatcherV1({
      bindingId: candidate.id,
      trafficPolicyId: candidate.trafficPolicyId,
      trafficPolicyGeneration: candidate.trafficPolicyGeneration,
    });

    await expect(
      binding.dispatch({
        url: "https://api.example.com/v1/messages",
        init: { method: "POST", redirect: "manual" },
        networkGuard: {} as never,
        credentialSlotRefs: [...binding.credentialSlotRefs],
      }),
    ).rejects.toMatchObject({ code: "missing-resolver" });
    expect(dispatch).not.toHaveBeenCalled();
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
