import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { cliCommandCatalog } from "../cli/command-catalog.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";
import type { CliCatalogPluginCommand } from "./plugin-commands.js";

export type CommandPromptSurface = {
  readonly id: string;
  readonly title: string;
  readonly kind: "routed-operation" | "plugin-command" | "node-command";
  readonly target: string;
  readonly commandHints: readonly string[];
  readonly risk: string;
  readonly confirmationRequired: boolean;
};

const ROUTED_OPERATION_TITLES: Readonly<Record<string, string>> = {
  "agents-list": "List agents",
  "channels-list": "List channels",
  "channels-status": "Channel status",
  "config-get": "Read config",
  "config-unset": "Unset config",
  "gateway-status": "Gateway status",
  health: "Health check",
  "models-list": "List models",
  "models-status": "Model status",
  "plugins-list": "List plugins",
  sessions: "List sessions",
  status: "Status summary",
  "tasks-audit": "Audit tasks",
  "tasks-list": "List tasks",
};

function openClawCommand(path: readonly string[]): string {
  return `openclaw ${path.join(" ")}`;
}

function modelFacingLiteral(value: string, maxChars = 160): string {
  const singleLine = value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(singleLine, maxChars);
}

function listRoutedCommandSurfaces(): readonly CommandPromptSurface[] {
  const operations = new Map<
    string,
    {
      commandPaths: string[][];
      risk: string;
      confirmationRequired: boolean;
    }
  >();
  for (const entry of cliCommandCatalog) {
    const route = entry.route;
    if (!route) {
      continue;
    }
    const current = operations.get(route.id) ?? {
      commandPaths: [],
      risk: route.effectProfile?.risk ?? "low",
      confirmationRequired: route.effectProfile?.confirmationRequired ?? false,
    };
    current.commandPaths.push([...entry.commandPath]);
    operations.set(route.id, current);
  }
  return [...operations.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([id, operation]) => ({
      id,
      title: ROUTED_OPERATION_TITLES[id] ?? id,
      kind: "routed-operation" as const,
      target: operation.commandPaths[0]
        ? openClawCommand(operation.commandPaths[0])
        : `openclaw ${id}`,
      commandHints: operation.commandPaths.map(openClawCommand),
      risk: operation.risk,
      confirmationRequired: operation.confirmationRequired,
    }));
}

export function listCommandPromptSurfaces(
  params: {
    pluginCommands?: readonly CliCatalogPluginCommand[];
    promptPluginIds?: ReadonlySet<string>;
    nodeCommands?: readonly CliCatalogNodeCommand[];
    scope?: "default" | "node-operator";
  } = {},
): readonly CommandPromptSurface[] {
  const pluginSurfaces = (params.pluginCommands ?? [])
    .filter((command) => params.promptPluginIds?.has(command.pluginId))
    .map((command) => ({
      id: modelFacingLiteral(command.sourceId),
      title: modelFacingLiteral(command.description || command.name),
      kind: "plugin-command" as const,
      target: modelFacingLiteral(openClawCommand(command.commandPath), 240),
      commandHints: [modelFacingLiteral(openClawCommand(command.commandPath), 240)],
      risk: command.risk,
      confirmationRequired: command.confirmationRequired,
    }));
  const nodeSurfaces =
    params.scope === "node-operator"
      ? (params.nodeCommands ?? [])
          .filter(
            (command) =>
              command.visibility.includes("prompt") &&
              (command.availability === "approved" || command.availability === "available"),
          )
          .map((command) => ({
            id: modelFacingLiteral(command.id),
            title: modelFacingLiteral(command.title),
            kind: "node-command" as const,
            target: modelFacingLiteral(command.command, 240),
            commandHints: [command.invocationHint, ...command.argumentHints].map((hint) =>
              modelFacingLiteral(hint, 240),
            ),
            risk: command.risk,
            confirmationRequired: command.confirmationRequired,
          }))
      : [];
  return [...listRoutedCommandSurfaces(), ...pluginSurfaces, ...nodeSurfaces];
}
