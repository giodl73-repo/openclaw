import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";
import { buildPluginCatalogCommands } from "./plugin-commands.js";

describe("plugin command catalog", () => {
  it("projects plugin CLI descriptors into source-labeled catalog entries", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "example-plugin",
        parentPath: ["nodes"],
        commands: ["camera"],
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

  it("includes plugin CLI command registrations without descriptors", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "voice-plugin",
        parentPath: [],
        commands: ["voicecall"],
        descriptors: [],
      },
    ]);

    expect(pluginCommands).toEqual([
      expect.objectContaining({
        pluginId: "voice-plugin",
        commandPath: ["voicecall"],
        parentPath: [],
        depth: 1,
        descriptorName: "voicecall",
        description: "Plugin CLI command registered without descriptor metadata",
        sourceId: "voice-plugin:voicecall",
      }),
    ]);
    expect(buildCatalogList({ pluginCommands }).counts.pluginCommands).toBe(1);
  });

  it("keeps plugin descriptions inside their Markdown table cells", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "example-plugin",
        parentPath: [],
        commands: ["camera"],
        descriptors: [
          {
            name: "camera",
            description: "Camera | controls\nfor operators",
            hasSubcommands: true,
          },
        ],
      },
    ]);

    expect(renderCatalogListMarkdown({ pluginCommands })).toContain(
      "| `camera` | None | 1 | `example-plugin` | Camera \\| controls for operators |",
    );
  });
});
