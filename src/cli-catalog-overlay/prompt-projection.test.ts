import { describe, expect, it } from "vitest";
import { buildPluginCatalogCommands } from "./plugin-commands.js";
import { listCliCatalogPromptSurfaces } from "./prompt-projection.js";

describe("CLI catalog overlay prompt projection", () => {
  it("returns only lean model-facing routing fields", () => {
    const surfaces = listCliCatalogPromptSurfaces();
    const gatewayStatus = surfaces.find((surface) => surface.id === "gateway-status");
    const gateway = surfaces.find((surface) => surface.id === "gateway");

    expect(surfaces).toHaveLength(19);
    expect(gatewayStatus).toEqual({
      id: "gateway-status",
      title: "Gateway status",
      kind: "routed-operation",
      dispatchMode: "direct",
      target: "gateway status",
      examples: ["gateway status"],
      commandHints: ["gateway status"],
      risk: "low",
      confirmationRequired: false,
    });

    expect(gateway).toEqual({
      id: "gateway",
      title: "Gateway control",
      kind: "command",
      dispatchMode: "hybrid",
      target: "gateway",
      examples: ["restart the gateway", "inspect gateway config"],
      commandHints: [
        "gateway status",
        "gateway restart",
        "gateway config.schema.lookup",
        "gateway config.apply",
      ],
      risk: "medium",
      confirmationRequired: true,
    });
    expect(Object.keys(gateway ?? {}).toSorted()).toEqual([
      "commandHints",
      "confirmationRequired",
      "dispatchMode",
      "examples",
      "id",
      "kind",
      "risk",
      "target",
      "title",
    ]);
  });

  it("includes plugin descriptor commands only when a plugin is prompt-enabled", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "demo-plugin",
        parentPath: [],
        descriptors: [{ name: "demo", description: "Demo plugin command", hasSubcommands: false }],
      },
    ]);

    expect(
      listCliCatalogPromptSurfaces({ pluginCommands }).map((surface) => surface.id),
    ).not.toContain("demo-plugin:demo");
    expect(
      listCliCatalogPromptSurfaces({
        pluginCommands,
        promptPluginIds: new Set(["demo-plugin"]),
      }).find((surface) => surface.id === "demo-plugin:demo"),
    ).toMatchObject({
      kind: "plugin-command",
      target: "demo",
      risk: "medium",
      confirmationRequired: true,
    });
  });
});
