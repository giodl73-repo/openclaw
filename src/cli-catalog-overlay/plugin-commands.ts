import type { PluginCliDescriptorEntry } from "../plugins/cli-registry-loader.js";
import type { OpenClawPluginCliCommandDescriptor } from "../plugins/types.js";
import type { CliCatalogVisibility } from "./registry.js";

export type CliCatalogPluginCommand = {
  readonly pluginId: string;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly depth: number;
  readonly name: string;
  readonly descriptorName: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly hidden: false;
  readonly risk: string;
  readonly confirmationRequired: boolean;
  readonly effectMode: string;
  readonly commandHints: readonly string[];
  readonly sourceKind: "plugin";
  readonly sourceId: string;
  readonly discoveryMode: "plugin-descriptor";
  readonly visibility: readonly CliCatalogVisibility[];
};

function isHiddenDescriptor(descriptor: OpenClawPluginCliCommandDescriptor): boolean {
  return (descriptor as OpenClawPluginCliCommandDescriptor & { hidden?: boolean }).hidden === true;
}

export function buildPluginCatalogCommands(
  entries: readonly PluginCliDescriptorEntry[],
): readonly CliCatalogPluginCommand[] {
  return entries.flatMap((entry) =>
    entry.descriptors
      .filter((descriptor) => !isHiddenDescriptor(descriptor))
      .map((descriptor) => {
        const commandPath = [...entry.parentPath, descriptor.name];
        return {
          pluginId: entry.pluginId,
          commandPath,
          parentPath: entry.parentPath,
          depth: commandPath.length,
          name: descriptor.name,
          descriptorName: descriptor.name,
          description: descriptor.description,
          hasSubcommands: descriptor.hasSubcommands,
          hidden: false,
          risk: descriptor.catalog?.risk ?? "medium",
          confirmationRequired: descriptor.catalog?.confirmationRequired ?? true,
          effectMode: descriptor.catalog?.effectMode ?? "mixed",
          commandHints: descriptor.catalog?.commandHints ?? [commandPath.join(" ")],
          sourceKind: "plugin" as const,
          sourceId: `${entry.pluginId}:${commandPath.join(" ")}`,
          discoveryMode: "plugin-descriptor" as const,
          visibility:
            descriptor.catalog?.visibility ?? (["docs", "audit", "operator", "policy"] as const),
        };
      }),
  );
}
