import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parsePluginManifestHostIntegrationBundle } from "../../plugins/host-integration-bundle.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { hostIntegrationStatusHandlers } from "./host-integration-status.js";

function createRegistry() {
  const parsed = parsePluginManifestHostIntegrationBundle(
    {
      contractVersion: "host-integration-bundle/v1",
      id: "example/host",
      version: "1.0.0",
      contributions: [
        {
          owner: "provider-request",
          kind: "provider-request-dispatcher",
          id: "example/dispatcher",
          contractVersion: "provider-request-dispatcher/v1",
          readinessCriterion: "plugin.example-host.dispatch-ready",
        },
      ],
    },
    "example-host",
  );
  if (!parsed.ok || !parsed.bundle) {
    throw new Error(parsed.ok ? "missing bundle" : parsed.error);
  }
  const loaded = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "example-host",
    name: "Example Host",
    source: "/plugins/example-host/index.js",
    origin: "global",
    enabled: true,
    configSchema: false,
    hostIntegrationBundle: parsed.bundle,
  });
  loaded.registry.plugins.push(record);
  const api = loaded.createApi(record, { config: {} as OpenClawConfig });
  api.registerReadinessCriterion({
    id: "dispatch-ready",
    description: "Reports dispatcher readiness.",
    check: () => ({
      status: "True",
      reason: "DispatcherReady",
      message: "Dispatcher is ready.",
    }),
  });
  return loaded.registry;
}

async function callStatus(params: Record<string, unknown>, includeRegistry = true) {
  const respond = vi.fn();
  const handler = hostIntegrationStatusHandlers["hostIntegration.status"];
  if (!handler) {
    throw new Error("hostIntegration.status handler is missing");
  }
  await handler({
    req: { type: "req", id: "req-1", method: "hostIntegration.status", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => ({}),
      ...(includeRegistry ? { getPluginRegistry: () => createRegistry() } : {}),
    } as never,
  });
  return respond;
}

describe("hostIntegration.status", () => {
  it("projects the current registry readiness without activating another runtime", async () => {
    const respond = await callStatus({});

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        version: "host-integration-runtime-inventory/v1",
        status: "True",
        bundles: [
          {
            pluginId: "example-host",
            id: "example/host",
            version: "1.0.0",
            status: "True",
            contributions: [
              {
                owner: "provider-request",
                kind: "provider-request-dispatcher",
                id: "example/dispatcher",
                contractVersion: "provider-request-dispatcher/v1",
                readiness: {
                  type: "plugin.example-host.dispatch-ready",
                  status: "True",
                  reason: "DispatcherReady",
                  message: "Dispatcher is ready.",
                },
              },
            ],
          },
        ],
      },
      undefined,
    );
  });

  it("rejects params instead of growing an implicit probe surface", async () => {
    const respond = await callStatus({ probe: true });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("fails explicitly when no lifecycle-owned registry is available", async () => {
    const respond = await callStatus({}, false);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
});
