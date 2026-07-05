import type { Command } from "commander";
import type { CliCatalogVisibility } from "./registry.js";

export type CliCatalogRuntimeCommand = {
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly depth: number;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly visibleSubcommandCount: number;
  readonly hidden: false;
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

function visibleChildren(command: Command): readonly Command[] {
  return command.commands.filter((child) => !isHiddenCommand(child));
}

function collectChildren(
  command: Command,
  parentPath: readonly string[],
): CliCatalogRuntimeCommand[] {
  return visibleChildren(command).flatMap((child) => {
    const commandPath = [...parentPath, child.name()];
    const childCommands = visibleChildren(child);
    const entry: CliCatalogRuntimeCommand = {
      commandPath,
      parentPath,
      depth: commandPath.length,
      name: child.name(),
      aliases: child.aliases(),
      description: commandDescription(child),
      hasSubcommands: childCommands.length > 0,
      visibleSubcommandCount: childCommands.length,
      hidden: false,
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
