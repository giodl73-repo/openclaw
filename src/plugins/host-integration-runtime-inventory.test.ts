import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSelectedReadinessResolver } from "../readiness/selection.js";
import { parsePluginManifestHostIntegrationBundle } from "./host-integration-bundle.js";
import { buildHostIntegrationRuntimeInventoryV1 } from "./host-integration-runtime-inventory.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function parsedBundle(contributions: unknown[]) {
  const parsed = parsePluginManifestHostIntegrationBundle(
    {
      contractVersion: "host-integration-bundle/v1",
      id: "example/host",
      version: "1.0.0",
      contributions,
    },
    "example-host",
  );
  if (!parsed.ok || !parsed.bundle) {
    throw new Error(parsed.ok ? "missing bundle" : parsed.error);
  }
  return parsed.bundle;
}

function createRegistry(contributions: unknown[]) {
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
    hostIntegrationBundle: parsedBundle(contributions),
  });
  pluginRegistry.registry.plugins.push(record);
  const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
  return { pluginRegistry, api };
}

const trafficPolicy = {
  owner: "provider-request",
  kind: "provider-request-traffic-policy",
  id: "example/egress",
  contractVersion: "provider-request-traffic-policy/v1",
  readinessCriterion: "plugin.example-host.egress-ready",
};

describe("host integration runtime inventory", () => {
  it("projects the canonical owner readiness used by profile selection", async () => {
    const { pluginRegistry, api } = createRegistry([
      trafficPolicy,
      {
        owner: "provider-request",
        kind: "provider-request-dispatcher",
        id: "example/dispatcher",
        contractVersion: "provider-request-dispatcher/v1",
        readinessCriterion: "plugin.example-host.dispatch-ready",
      },
    ]);
    api.registerReadinessCriterion({
      id: "egress-ready",
      description: "Reports egress policy readiness.",
      check: () => ({ status: "True", reason: "PolicyReady", message: "Policy is ready." }),
    });
    api.registerReadinessCriterion({
      id: "dispatch-ready",
      description: "Reports dispatcher readiness.",
      check: () => ({
        status: "False",
        reason: "DispatcherUnavailable",
        message: "Dispatcher is unavailable.",
      }),
    });

    const inventory = await buildHostIntegrationRuntimeInventoryV1({
      registry: pluginRegistry.registry,
      config: {},
    });
    const profileReadiness = await createSelectedReadinessResolver()({
      registry: pluginRegistry.registry,
      config: {
        gateway: {
          readiness: { requiredCriteria: ["plugin.example-host.dispatch-ready"] },
        },
      },
    });

    expect(inventory).toMatchObject({
      version: "host-integration-runtime-inventory/v1",
      status: "False",
      bundles: [
        {
          pluginId: "example-host",
          id: "example/host",
          status: "False",
          contributions: [
            { id: "example/egress", readiness: { status: "True", reason: "PolicyReady" } },
            {
              id: "example/dispatcher",
              readiness: { status: "False", reason: "DispatcherUnavailable" },
            },
          ],
        },
      ],
    });
    expect(profileReadiness.conditions).toEqual([
      expect.objectContaining({
        type: "plugin.example-host.dispatch-ready",
        status: "False",
        requirement: "required",
        reason: "DispatcherUnavailable",
      }),
    ]);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.bundles[0]?.contributions)).toBe(true);
  });

  it("keeps missing declarations and registrations unknown without unrelated checks", async () => {
    const { pluginRegistry, api } = createRegistry([
      trafficPolicy,
      {
        owner: "provider-request",
        kind: "provider-request-carrier",
        id: "example/carrier",
        contractVersion: "reverse-provider-dispatch/v1",
      },
    ]);
    const unrelated = vi.fn(() => ({
      status: "True" as const,
      reason: "UnrelatedReady",
      message: "Unrelated.",
    }));
    api.registerReadinessCriterion({
      id: "unrelated",
      description: "Not referenced by this bundle.",
      check: unrelated,
    });

    const inventory = await buildHostIntegrationRuntimeInventoryV1({
      registry: pluginRegistry.registry,
      config: {},
    });

    expect(inventory.status).toBe("Unknown");
    expect(inventory.bundles[0]?.contributions).toEqual([
      expect.objectContaining({
        id: "example/egress",
        readiness: expect.objectContaining({ reason: "ReadinessCriterionNotRegistered" }),
      }),
      expect.objectContaining({
        id: "example/carrier",
        readiness: expect.objectContaining({ reason: "ReadinessCriterionNotDeclared" }),
      }),
    ]);
    expect(unrelated).not.toHaveBeenCalled();
  });

  it("does not cancel an overlapping inventory for another registry", async () => {
    const first = createRegistry([trafficPolicy]);
    const second = createRegistry([trafficPolicy]);
    const aborted: boolean[] = [];
    for (const { api } of [first, second]) {
      api.registerReadinessCriterion({
        id: "egress-ready",
        description: "Reports egress policy readiness.",
        check: ({ signal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => resolve({ status: "True", reason: "PolicyReady", message: "Ready." }),
              10,
            );
            signal.addEventListener(
              "abort",
              () => {
                aborted.push(true);
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      });
    }

    const [firstInventory, secondInventory] = await Promise.all([
      buildHostIntegrationRuntimeInventoryV1({
        registry: first.pluginRegistry.registry,
        config: {},
      }),
      buildHostIntegrationRuntimeInventoryV1({
        registry: second.pluginRegistry.registry,
        config: {},
      }),
    ]);

    expect(firstInventory.status).toBe("True");
    expect(secondInventory.status).toBe("True");
    expect(aborted).toEqual([]);
  });
});
