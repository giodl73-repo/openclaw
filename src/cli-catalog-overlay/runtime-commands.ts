import type { Command } from "commander";
import type { CliCatalogVisibility } from "./registry.js";

export type CliCatalogRuntimeCommand = {
  readonly commandPath: readonly string[];
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly sourceKind: "runtime";
  readonly sourceId: string;
  readonly discoveryMode: "runtime-registered";
  readonly visibility: readonly CliCatalogVisibility[];
};

function commandDescription(command: Command): string {
  return command.description().trim();
}

function isHiddenCommand(command: Command): boolean {
  return (command as Command & { _hidden?: boolean })._hidden === true;
}

function collectChildren(
  command: Command,
  parentPath: readonly string[],
): CliCatalogRuntimeCommand[] {
  return command.commands.flatMap((child) => {
    if (isHiddenCommand(child)) {
      return [];
    }
    const commandPath = [...parentPath, child.name()];
    const entry: CliCatalogRuntimeCommand = {
      commandPath,
      name: child.name(),
      aliases: child.aliases(),
      description: commandDescription(child),
      hasSubcommands: child.commands.length > 0,
      sourceKind: "runtime",
      sourceId: commandPath.join(" "),
      discoveryMode: "runtime-registered",
      visibility: ["audit", "operator", "policy"],
    };
    return [entry, ...collectChildren(child, commandPath)];
  });
}

export function collectRuntimeCommandTree(program: Command): readonly CliCatalogRuntimeCommand[] {
  return collectChildren(program, []);
}
