/** Verifies credential resolver registration ownership and lifecycle behavior. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  type CredentialSlotResolverV1,
} from "../infra/net/credential-slot.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createRegistryHarness() {
  const pluginRegistry = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const config = {} as OpenClawConfig;
  const apiFor = (id: string) => {
    const record = createPluginRecord({ id, source: `/plugins/${id}/index.ts` });
    pluginRegistry.registry.plugins.push(record);
    return pluginRegistry.createApi(record, { config });
  };
  return { pluginRegistry, apiFor };
}

function credentialResolver(
  overrides: Partial<CredentialSlotResolverV1> = {},
): CredentialSlotResolverV1 {
  return {
    version: CREDENTIAL_SLOT_RESOLVER_VERSION,
    resolverId: "lobster.workspace",
    slotId: "lobster.workspace.token",
    placement: "header",
    headerName: " Authorization ",
    allowedOrigins: ["https://lobster.example.test", "https://lobster.example.test"],
    resolve: vi.fn().mockResolvedValue({ value: "secret-token" }),
    ...overrides,
  };
}

describe("registerCredentialSlotResolver", () => {
  it("stores normalized immutable metadata without acquiring a credential", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    const resolver = credentialResolver({
      resolverId: " lobster.workspace ",
      slotId: " lobster.workspace.token ",
    });

    apiFor("lobster").registerCredentialSlotResolver(resolver);

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(pluginRegistry.registry.credentialSlotResolvers).toHaveLength(1);
    const registered = pluginRegistry.registry.credentialSlotResolvers[0];
    expect(registered).toMatchObject({
      pluginId: "lobster",
      resolver: {
        resolverId: "lobster.workspace",
        slotId: "lobster.workspace.token",
        headerName: "authorization",
        allowedOrigins: ["https://lobster.example.test"],
      },
    });
    expect(Object.isFrozen(registered?.resolver)).toBe(true);
    expect(Object.isFrozen(registered?.resolver.allowedOrigins)).toBe(true);
  });

  it("rejects cross-plugin resolver takeover", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    const firstResolve = vi.fn().mockResolvedValue(null);
    apiFor("plugin-a").registerCredentialSlotResolver(
      credentialResolver({ resolve: firstResolve }),
    );
    apiFor("plugin-b").registerCredentialSlotResolver(
      credentialResolver({ resolve: vi.fn().mockResolvedValue({ value: "hijack" }) }),
    );

    expect(pluginRegistry.registry.credentialSlotResolvers).toHaveLength(1);
    expect(pluginRegistry.registry.credentialSlotResolvers[0]).toMatchObject({
      pluginId: "plugin-a",
      resolver: { resolve: firstResolve },
    });
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "plugin-b",
        message: expect.stringContaining('already registered by plugin "plugin-a"'),
      }),
    );
  });

  it("lets the owning plugin replace its implementation", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    const api = apiFor("lobster");
    const replacement = vi.fn().mockResolvedValue(null);
    api.registerCredentialSlotResolver(credentialResolver());
    api.registerCredentialSlotResolver(credentialResolver({ resolve: replacement }));

    expect(pluginRegistry.registry.credentialSlotResolvers).toHaveLength(1);
    expect(pluginRegistry.registry.credentialSlotResolvers[0]?.resolver.resolve).toBe(replacement);
  });

  it("rolls registration back with the plugin registry transaction", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    const transaction = createPluginRegistrationTransaction({
      registry: pluginRegistry.registry,
    });
    apiFor("lobster").registerCredentialSlotResolver(credentialResolver());

    transaction.rollback();

    expect(pluginRegistry.registry.credentialSlotResolvers).toEqual([]);
  });

  it("reports invalid contracts without echoing untrusted values", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    apiFor("lobster").registerCredentialSlotResolver(
      credentialResolver({ version: "secret-version" as typeof CREDENTIAL_SLOT_RESOLVER_VERSION }),
    );

    expect(pluginRegistry.registry.credentialSlotResolvers).toEqual([]);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "lobster",
        message: "credential slot resolver registration rejected: invalid resolver contract",
      }),
    );
    expect(JSON.stringify(pluginRegistry.registry.diagnostics)).not.toContain("secret-version");
  });
});
