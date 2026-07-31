import { describe, expect, it } from "vitest";
import { collectPluginSettingsConstraints } from "./settings-constraints-providers.js";

describe("collectPluginSettingsConstraints", () => {
  it("merges registered plugin settings constraints", async () => {
    const constraints = await collectPluginSettingsConstraints({
      registry: {
        settingsConstraintsProviders: [
          {
            pluginId: "policy",
            pluginName: "Policy",
            source: "bundled:policy",
            provider: {
              id: "active-policy",
              build: ({ config, cwd }) => ({
                settings: {
                  "agents.*.sandbox.mode": {
                    state: "readOnly",
                    policyPath: cwd ? `${cwd}/policy.jsonc` : "policy.jsonc",
                    allowedValues: [config.agents?.defaults?.sandbox?.mode ?? "workspace"],
                  },
                },
              }),
            },
          },
          {
            pluginId: "host",
            pluginName: "Host",
            source: "bundled:host",
            provider: {
              id: "host-lockdown",
              build: () => ({
                settings: {
                  "gateway.controlUi.enabled": {
                    state: "disabled",
                    source: "host-policy",
                    allowedValues: [true],
                  },
                },
              }),
            },
          },
        ],
      },
      config: { agents: { defaults: { sandbox: { mode: "read-only" } } } },
      cwd: "C:/workspace",
    });

    expect(constraints).toEqual({
      version: 1,
      mode: "active-policy-constraints",
      settings: {
        "agents.*.sandbox.mode": {
          state: "readOnly",
          source: "policy",
          policyPath: "C:/workspace/policy.jsonc",
          allowedValues: ["read-only"],
        },
        "gateway.controlUi.enabled": {
          state: "disabled",
          source: "host-policy",
          allowedValues: [true],
        },
      },
    });
  });

  it("omits the bootstrap payload when no provider returns settings", async () => {
    await expect(
      collectPluginSettingsConstraints({
        registry: { settingsConstraintsProviders: [] },
        config: {},
      }),
    ).resolves.toBeUndefined();
  });
});
