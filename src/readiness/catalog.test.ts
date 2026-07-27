import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { buildReadinessCriterionCatalog } from "./catalog.js";

function pluginCriterion(check = vi.fn()): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    pluginName: "Storage",
    source: "/private/plugin/path",
    criterion: {
      id: "backend",
      description: "Checks the configured storage backend.",
      check,
    },
  };
}

describe("buildReadinessCriterionCatalog", () => {
  it("lists core and plugin descriptors with their current selection", () => {
    const criterion = pluginCriterion();
    const catalog = buildReadinessCriterionCatalog({
      config: {
        gateway: {
          readiness: {
            requiredCriteria: ["plugin.storage.backend"],
            advisoryCriteria: ["openclaw.workspace-writable"],
          },
        },
      },
      registry: { readinessCriteria: [criterion] },
    });

    expect(catalog).toEqual({
      catalogVersion: 1,
      criteria: [
        expect.objectContaining({
          id: "openclaw.workspace-writable",
          owner: { kind: "core" },
          registered: true,
          selection: "advisory",
        }),
        {
          id: "plugin.storage.backend",
          description: "Checks the configured storage backend.",
          owner: { kind: "plugin", pluginId: "storage", pluginName: "Storage" },
          registered: true,
          selection: "required",
        },
      ],
    });
  });

  it("reports selected missing criteria without guessing ownership", () => {
    const catalog = buildReadinessCriterionCatalog({
      config: {
        gateway: { readiness: { requiredCriteria: ["plugin.missing.check"] } },
      },
      registry: { readinessCriteria: [] },
    });

    expect(catalog.criteria).toContainEqual({
      id: "plugin.missing.check",
      owner: { kind: "unresolved" },
      registered: false,
      selection: "required",
    });
  });

  it("does not invoke provider callbacks or expose registration source paths", () => {
    const check = vi.fn();
    const catalog = buildReadinessCriterionCatalog({
      config: {},
      registry: { readinessCriteria: [pluginCriterion(check)] },
    });

    expect(check).not.toHaveBeenCalled();
    expect(JSON.stringify(catalog)).not.toContain("/private/plugin/path");
  });
});
