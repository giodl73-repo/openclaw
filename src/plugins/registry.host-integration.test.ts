import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  getCurrentHostIntegrationBundleSnapshotV1,
} from "../hosting/host-integration-bundle.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
});

describe("plugin host-integration registration", () => {
  it("derives package provenance and returns a snapshot-scoped disposer", () => {
    const pluginRegistry = createPluginRegistry({
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
    });
    const api = pluginRegistry.createApi(record, {
      config: {} as OpenClawConfig,
    });

    const unregister = api.registerHostIntegrationBundle({
      version: "host-integration-bundle/v1",
      id: "example/host",
      bundleVersion: "1.0.0",
      contributions: [
        {
          owner: "provider-request",
          kind: "provider-request-carrier",
          id: "example/reverse-provider",
          version: "reverse-provider-dispatch/v1",
          required: true,
          readinessCriteria: ["provider.request.carrier.example"],
        },
      ],
    });

    expect(getCurrentHostIntegrationBundleSnapshotV1()?.inventory[0]?.provenance).toEqual({
      pluginId: "example-host",
      source: "/plugins/example-host/index.js",
      origin: "global",
    });
    unregister();
    expect(getCurrentHostIntegrationBundleSnapshotV1()).toBeUndefined();
  });
});
