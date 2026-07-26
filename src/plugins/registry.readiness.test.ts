import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function createRegistry(pluginId = "storage") {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: pluginId,
    name: "Storage",
    source: "/plugins/storage/index.js",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const api = pluginRegistry.createApi(record, {
    config: {} as OpenClawConfig,
    pluginConfig: { endpoint: "https://storage.example" },
  });
  return { pluginRegistry, api };
}

describe("plugin readiness registration", () => {
  it("namespaces criteria and retains plugin config for owner evaluation", () => {
    const { pluginRegistry, api } = createRegistry();
    const criterion = {
      id: "Backend",
      description: " Reports storage backend availability. ",
      check: () => ({ status: "True" as const, reason: "Ready", message: "Ready." }),
    };

    api.registerReadinessCriterion(criterion);

    expect(pluginRegistry.registry.readinessCriteria).toEqual([
      expect.objectContaining({
        id: "plugin.storage.backend",
        pluginId: "storage",
        criterion: expect.objectContaining({
          id: "backend",
          description: "Reports storage backend availability.",
        }),
        pluginConfig: { endpoint: "https://storage.example" },
      }),
    ]);
    expect(Object.isFrozen(pluginRegistry.registry.readinessCriteria[0]?.criterion)).toBe(true);
  });

  it("encodes scoped plugin ids into canonical criterion namespaces", () => {
    const { pluginRegistry, api } = createRegistry("@scope/storage");

    api.registerReadinessCriterion({
      id: "backend",
      description: "Reports storage backend availability.",
      check: () => ({ status: "True", reason: "Ready", message: "Ready." }),
    });

    expect(pluginRegistry.registry.readinessCriteria).toEqual([
      expect.objectContaining({
        id: "plugin.x-4073636f70652f73746f72616765.backend",
        pluginId: "@scope/storage",
      }),
    ]);
  });

  it("rejects duplicate and malformed registration without replacing the first owner", () => {
    const { pluginRegistry, api } = createRegistry();
    const criterion = {
      id: "backend",
      description: "Reports storage backend availability.",
      check: () => ({ status: "True" as const, reason: "Ready", message: "Ready." }),
    };
    api.registerReadinessCriterion(criterion);
    api.registerReadinessCriterion(criterion);
    api.registerReadinessCriterion({ ...criterion, id: "../other" });
    api.registerReadinessCriterion({ ...criterion, id: "empty", description: " " });
    api.registerReadinessCriterion(undefined as never);
    api.registerReadinessCriterion({ description: "missing id" } as never);
    api.registerReadinessCriterion({ id: "backend", description: 42 } as never);

    expect(pluginRegistry.registry.readinessCriteria).toHaveLength(1);
    expect(pluginRegistry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: "readiness criterion already registered: plugin.storage.backend",
        }),
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("readiness criterion id must use"),
        }),
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("requires a bounded description"),
        }),
        expect.objectContaining({
          level: "error",
          message: "readiness criterion requires string id and description fields",
        }),
      ]),
    );
  });
});
