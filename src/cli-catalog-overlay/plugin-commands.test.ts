import { describe, expect, it } from "vitest";
import { buildCatalogList } from "./list.js";
import { buildPluginCatalogCommands } from "./plugin-commands.js";

describe("plugin command catalog", () => {
  it("projects plugin CLI descriptors into source-labeled catalog entries", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "example-plugin",
        parentPath: ["nodes"],
        descriptors: [
          { name: "camera", description: "Camera controls", hasSubcommands: true },
          {
            name: "private-camera",
            description: "Private camera controls",
            hasSubcommands: false,
            hidden: true,
          },
        ],
      },
    ]);

    expect(pluginCommands).toEqual([
      expect.objectContaining({
        pluginId: "example-plugin",
        commandPath: ["nodes", "camera"],
        parentPath: ["nodes"],
        depth: 2,
        descriptorName: "camera",
        hidden: false,
        sourceKind: "plugin",
        sourceId: "example-plugin:nodes camera",
        discoveryMode: "plugin-descriptor",
      }),
    ]);
    expect(pluginCommands.map((command) => command.name)).not.toContain("private-camera");
    expect(buildCatalogList({ pluginCommands }).counts.pluginCommands).toBe(1);
  });
});
