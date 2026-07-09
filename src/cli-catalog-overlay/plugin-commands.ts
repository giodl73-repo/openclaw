import type { PluginCliDescriptorEntry } from "../plugins/cli-registry-loader.js";
import type { CliCatalogVisibility } from "./registry.js";

export type CliCatalogPluginCommand = {
  readonly pluginId: string;
  readonly commandPath: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly sourceKind: "plugin";
  readonly sourceId: string;
  readonly discoveryMode: "plugin-descriptor";
  readonly visibility: readonly CliCatalogVisibility[];
};

export function buildPluginCatalogCommands(
  entries: readonly PluginCliDescriptorEntry[],
): readonly CliCatalogPluginCommand[] {
  return entries.flatMap((entry) => {
    const descriptorNames = new Set(entry.descriptors.map((descriptor) => descriptor.name));
    const descriptorCommands = entry.descriptors.map((descriptor) => {
      const commandPath = [...entry.parentPath, descriptor.name];
      return {
        pluginId: entry.pluginId,
        commandPath,
        name: descriptor.name,
        description: descriptor.description,
        hasSubcommands: descriptor.hasSubcommands,
        sourceKind: "plugin" as const,
        sourceId: `${entry.pluginId}:${commandPath.join(" ")}`,
        discoveryMode: "plugin-descriptor" as const,
        visibility: ["docs", "audit", "operator", "policy"] as const,
      };
    });
    const commandOnly = (entry.commands ?? [])
      .filter((command) => !descriptorNames.has(command))
      .map((command) => {
        const commandPath = [...entry.parentPath, command];
        return {
          pluginId: entry.pluginId,
          commandPath,
          name: command,
          description: "Plugin CLI command registered without descriptor metadata",
          hasSubcommands: false,
          sourceKind: "plugin" as const,
          sourceId: `${entry.pluginId}:${commandPath.join(" ")}`,
          discoveryMode: "plugin-descriptor" as const,
          visibility: ["audit", "operator", "policy"] as const,
        };
      });
    return [...descriptorCommands, ...commandOnly];
  });
}
