import { buildCatalogList } from "./list.js";
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

function routedOperationRisk(id: string): "low" | "medium" {
  return id === "config-unset" ? "medium" : "low";
}

export function listCliCatalogPromptSurfaces(): readonly CliCatalogPromptSurface[] {
  const catalog = buildCatalogList();
  const routedOperations = catalog.cli.routedOperations.map((operation) => ({
    id: operation.id,
    title: ROUTED_OPERATION_TITLES[operation.id] ?? operation.id,
    kind: "routed-operation",
    dispatchMode: "direct",
    target: operation.commandPaths[0]?.join(" ") ?? operation.id,
    examples: operation.commandPaths.slice(0, 2).map((path) => path.join(" ")),
    commandHints: operation.commandPaths.map((path) => path.join(" ")),
    risk: routedOperationRisk(operation.id),
    confirmationRequired: routedOperationRisk(operation.id) !== "low",
  }));
  const agentToolSurfaces = listCliCatalogSurfaces().map((surface) => ({
    id: surface.id,
    title: surface.title,
    kind: surface.kind,
    dispatchMode: surface.dispatchMode,
    target: surface.target,
    examples: surface.examples,
    commandHints: surface.commandHints,
    risk: surface.risk,
    confirmationRequired: surface.confirmationRequired,
  }));
  return [...routedOperations, ...agentToolSurfaces];
}
