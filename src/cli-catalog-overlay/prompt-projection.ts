import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CliCatalogMetadata } from "../cli/catalog-metadata.js";
import { cliCommandCatalog } from "../cli/command-catalog.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";
import type { CliCatalogPluginCommand } from "./plugin-commands.js";
import { listCliCatalogSurfaces } from "./registry.js";

export type CliCatalogPromptSurface = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly dispatchMode: string;
  readonly target: string;
  readonly examples: readonly string[];
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

type PromptRoutedOperation = {
  readonly id: string;
  readonly commandPaths: readonly (readonly string[])[];
  readonly title?: string;
  readonly risk?: string;
  readonly confirmationRequired?: boolean;
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

function listPromptRoutedOperations(): readonly PromptRoutedOperation[] {
  const byId = new Map<string, { commandPaths: string[][]; catalog?: CliCatalogMetadata }>();
  for (const entry of cliCommandCatalog) {
    const id = entry.route?.id;
    if (!id) {
      continue;
    }
    const group = byId.get(id) ?? { commandPaths: [] };
    group.commandPaths.push([...entry.commandPath]);
    group.catalog ??= entry.route?.catalog;
    byId.set(id, group);
  }

  return [...byId.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([id, group]) => ({
      id,
      commandPaths: group.commandPaths,
      title: group.catalog?.title,
      risk: group.catalog?.risk,
      confirmationRequired: group.catalog?.confirmationRequired,
    }));
}

export function listCliCatalogPromptSurfaces(
  params: {
    pluginCommands?: readonly CliCatalogPluginCommand[];
    promptPluginIds?: ReadonlySet<string>;
    nodeCommands?: readonly CliCatalogNodeCommand[];
    scope?: "default" | "node-operator";
  } = {},
): readonly CliCatalogPromptSurface[] {
  const routedOperations = listPromptRoutedOperations().map((operation) => ({
    id: operation.id,
    title: operation.title ?? ROUTED_OPERATION_TITLES[operation.id] ?? operation.id,
    kind: "routed-operation",
    dispatchMode: "direct",
    target: operation.commandPaths[0]
      ? openClawCommand(operation.commandPaths[0])
      : `openclaw ${operation.id}`,
    examples: operation.commandPaths.slice(0, 2).map(openClawCommand),
    commandHints: operation.commandPaths.map(openClawCommand),
    risk: operation.risk ?? "low",
    confirmationRequired: operation.confirmationRequired ?? false,
  }));
  const agentToolSurfaces = listCliCatalogSurfaces()
    .filter((surface) => surface.visibility.includes("prompt"))
    .map((surface) => ({
      id: surface.id,
      title: surface.title,
      kind: surface.kind,
      dispatchMode: surface.dispatchMode,
      target: surface.target,
      examples: surface.examples,
      commandHints:
        surface.id === "gateway"
          ? surface.commandHints.filter((hint) => hint !== "gateway status")
          : surface.commandHints,
      risk: surface.risk,
      confirmationRequired: surface.confirmationRequired,
    }));
  const pluginSurfaces = (params.pluginCommands ?? [])
    .filter(
      (command) =>
        params.promptPluginIds?.has(command.pluginId) && command.visibility.includes("prompt"),
    )
    .map((command) => ({
      id: modelFacingLiteral(command.sourceId),
      title: modelFacingLiteral(command.description || command.name),
      kind: "plugin-command",
      dispatchMode: "metadata-first",
      target: modelFacingLiteral(openClawCommand(command.commandPath), 240),
      examples: [modelFacingLiteral(openClawCommand(command.commandPath), 240)],
      commandHints: command.commandHints.map((hint) =>
        modelFacingLiteral(hint.startsWith("openclaw ") ? hint : `openclaw ${hint}`, 240),
      ),
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
            id: command.id,
            title: command.title,
            kind: "node-command",
            dispatchMode: "metadata-first",
            target: command.command,
            examples: [command.invocationHint],
            commandHints: [command.invocationHint, ...command.argumentHints],
            risk: command.risk,
            confirmationRequired: command.confirmationRequired,
          }))
      : [];
  return [...routedOperations, ...agentToolSurfaces, ...pluginSurfaces, ...nodeSurfaces];
}
