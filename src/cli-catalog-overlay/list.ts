import { cliCommandCatalog } from "../cli/command-catalog.js";
import { getCoreCliCommandDescriptors } from "../cli/program/core-command-descriptors.js";
import { getSubCliEntries } from "../cli/program/subcli-descriptors.js";
import { buildNodeCommandCatalog, type CliCatalogNodeCommand } from "./node-commands.js";
import type { CliCatalogPluginCommand } from "./plugin-commands.js";
import {
  listCliCatalogSurfaces,
  type CliCatalogDiscoveryMode,
  type CliCatalogSourceKind,
  type CliCatalogVisibility,
} from "./registry.js";
import type { CliCatalogRuntimeCommand } from "./runtime-commands.js";

export type CliCatalogListSurface = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly dispatchMode: string;
  readonly target: string;
  readonly source: string;
  readonly sourceKind: CliCatalogSourceKind;
  readonly sourceId: string;
  readonly discoveryMode: CliCatalogDiscoveryMode;
  readonly visibility: readonly CliCatalogVisibility[];
  readonly owner: string;
  readonly status: string;
  readonly risk: string;
  readonly confirmationRequired: boolean;
  readonly effectMode: string;
  readonly effects: readonly string[];
  readonly commandHints: readonly string[];
  readonly descriptor?: {
    readonly name: string;
    readonly hasSubcommands: boolean;
  };
};

export type CliCatalogListDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly parentDefaultHelp: boolean;
  readonly source: "core" | "subcli";
  readonly sourceKind: "core" | "subcli";
  readonly sourceId: string;
  readonly discoveryMode: "static-descriptor";
  readonly visibility: readonly CliCatalogVisibility[];
};

export type CliCatalogListCommandRoute = {
  readonly commandPath: readonly string[];
  readonly exact: boolean;
  readonly routeId?: string;
  readonly policyKeys: readonly string[];
  readonly sourceKind: "route-policy";
  readonly sourceId: string;
  readonly discoveryMode: "route-policy";
  readonly visibility: readonly CliCatalogVisibility[];
};

export type CliCatalogListRoutedOperation = {
  readonly id: string;
  readonly commandPaths: readonly (readonly string[])[];
  readonly sourceKind: "route-policy";
  readonly discoveryMode: "route-policy";
  readonly visibility: readonly CliCatalogVisibility[];
};

export type CliCatalogRuntimeCommandScope = "current-invocation-registered-tree";

const RUNTIME_COMMAND_SCOPE: CliCatalogRuntimeCommandScope = "current-invocation-registered-tree";

export type CliCatalogList = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay";
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly agentToolSurfaces: number;
    readonly promptProjection: number;
    readonly runtimeCommands: number;
    readonly pluginCommands: number;
    readonly nodeCommands: number;
  };
  readonly cli: {
    readonly descriptors: readonly CliCatalogListDescriptor[];
    readonly commandRoutes: readonly CliCatalogListCommandRoute[];
    readonly routedOperations: readonly CliCatalogListRoutedOperation[];
    readonly runtimeCommandScope: CliCatalogRuntimeCommandScope;
    readonly runtimeCommands: readonly CliCatalogRuntimeCommand[];
    readonly pluginCommands: readonly CliCatalogPluginCommand[];
    readonly nodeCommands: readonly CliCatalogNodeCommand[];
  };
  readonly agentToolSurfaces: readonly CliCatalogListSurface[];
  readonly promptProjection: {
    readonly routedOperationIds: readonly string[];
    readonly agentToolSurfaceIds: readonly string[];
  };
};

function mapSurfaces(): readonly CliCatalogListSurface[] {
  return listCliCatalogSurfaces().map((surface) => ({
    id: surface.id,
    title: surface.title,
    kind: surface.kind,
    dispatchMode: surface.dispatchMode,
    target: surface.target,
    source: surface.source,
    owner: surface.owner,
    sourceKind: surface.sourceKind,
    sourceId: surface.sourceId,
    discoveryMode: surface.discoveryMode,
    visibility: surface.visibility,
    status: surface.status,
    risk: surface.risk,
    confirmationRequired: surface.confirmationRequired,
    effectMode: surface.effectMode,
    effects: surface.effects,
    commandHints: surface.commandHints,
    ...(surface.cliDescriptor
      ? {
          descriptor: {
            name: surface.cliDescriptor.name,
            hasSubcommands: surface.cliDescriptor.hasSubcommands,
          },
        }
      : {}),
  }));
}

function buildDescriptors(): readonly CliCatalogListDescriptor[] {
  const core = getCoreCliCommandDescriptors().map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    hasSubcommands: descriptor.hasSubcommands,
    parentDefaultHelp: Boolean(descriptor.parentDefaultHelp),
    source: "core" as const,
    sourceKind: "core" as const,
    sourceId: descriptor.name,
    discoveryMode: "static-descriptor" as const,
    visibility: ["docs", "audit", "operator", "policy"] as const,
  }));
  const subcli = getSubCliEntries().map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    hasSubcommands: descriptor.hasSubcommands,
    parentDefaultHelp: Boolean(descriptor.parentDefaultHelp),
    source: "subcli" as const,
    sourceKind: "subcli" as const,
    sourceId: descriptor.name,
    discoveryMode: "static-descriptor" as const,
    visibility: ["docs", "audit", "operator", "policy"] as const,
  }));
  return [...core, ...subcli];
}

function buildCommandRoutes(): readonly CliCatalogListCommandRoute[] {
  return cliCommandCatalog.map((entry) => ({
    commandPath: entry.commandPath,
    exact: Boolean(entry.exact),
    ...(entry.route ? { routeId: entry.route.id } : {}),
    policyKeys: entry.policy ? Object.keys(entry.policy).toSorted() : [],
    sourceKind: "route-policy" as const,
    sourceId: entry.commandPath.join(" "),
    discoveryMode: "route-policy" as const,
    visibility: ["audit", "operator", "policy"] as const,
  }));
}

function buildRoutedOperations(
  routes = buildCommandRoutes(),
): readonly CliCatalogListRoutedOperation[] {
  return [...new Set(routes.flatMap((route) => (route.routeId ? [route.routeId] : [])))]
    .toSorted()
    .map((id) => ({
      id,
      sourceKind: "route-policy" as const,
      discoveryMode: "route-policy" as const,
      visibility: ["prompt", "audit", "operator", "policy"] as const,
      commandPaths: routes
        .filter((route) => route.routeId === id)
        .map((route) => route.commandPath),
    }));
}

export function buildCatalogList(
  params: {
    runtimeCommands?: readonly CliCatalogRuntimeCommand[];
    pluginCommands?: readonly CliCatalogPluginCommand[];
    nodeCommands?: readonly CliCatalogNodeCommand[];
  } = {},
): CliCatalogList {
  const descriptors = buildDescriptors();
  const commandRoutes = buildCommandRoutes();
  const routedOperations = buildRoutedOperations(commandRoutes);
  const agentToolSurfaces = mapSurfaces();
  const runtimeCommands = params.runtimeCommands ?? [];
  const pluginCommands = params.pluginCommands ?? [];
  const nodeCommands = buildNodeCommandCatalog(params.nodeCommands);
  const promptProjection = {
    routedOperationIds: routedOperations.map((operation) => operation.id),
    agentToolSurfaceIds: agentToolSurfaces.map((surface) => surface.id),
  };
  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay",
    counts: {
      commandDescriptors: descriptors.length,
      commandRoutes: commandRoutes.length,
      routedOperations: routedOperations.length,
      agentToolSurfaces: agentToolSurfaces.length,
      promptProjection:
        promptProjection.routedOperationIds.length + promptProjection.agentToolSurfaceIds.length,
      runtimeCommands: runtimeCommands.length,
      pluginCommands: pluginCommands.length,
      nodeCommands: nodeCommands.length,
    },
    cli: {
      descriptors,
      commandRoutes,
      routedOperations,
      runtimeCommandScope: RUNTIME_COMMAND_SCOPE,
      runtimeCommands,
      pluginCommands,
      nodeCommands,
    },
    agentToolSurfaces,
    promptProjection,
  };
}

export function renderCatalogListMarkdown(
  params: {
    runtimeCommands?: readonly CliCatalogRuntimeCommand[];
    pluginCommands?: readonly CliCatalogPluginCommand[];
    nodeCommands?: readonly CliCatalogNodeCommand[];
  } = {},
): string {
  const list = buildCatalogList(params);
  const lines = [
    "# CLI Catalog Overlay List",
    "",
    "Read-only catalog of existing OpenClaw command metadata, command-routing metadata, routed operations, and agent tool surfaces.",
    "",
    "## Counts",
    "",
    `- CLI descriptors: ${list.counts.commandDescriptors}`,
    `- Command routes: ${list.counts.commandRoutes}`,
    `- Routed operations: ${list.counts.routedOperations}`,
    `- Agent/tool surfaces: ${list.counts.agentToolSurfaces}`,
    `- Prompt projection items: ${list.counts.promptProjection}`,
    `- Runtime commands: ${list.counts.runtimeCommands}`,
    `- Runtime command scope: ${list.cli.runtimeCommandScope}`,
    `- Plugin descriptor commands: ${list.counts.pluginCommands}`,
    `- Node/operator commands: ${list.counts.nodeCommands}`,
    "",
    "## Routed operations",
    "",
    "| Operation | Command paths |",
    "| --- | --- |",
  ];
  for (const operation of list.cli.routedOperations) {
    const paths = operation.commandPaths.map((path) => "`" + path.join(" ") + "`").join(", ");
    lines.push(`| \`${operation.id}\` | ${paths || "None"} |`);
  }
  if (list.cli.pluginCommands.length > 0) {
    lines.push(
      "",
      "## Plugin descriptor commands",
      "",
      "| Command path | Parent | Depth | Plugin | Description |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const command of list.cli.pluginCommands) {
      lines.push(
        `| \`${command.commandPath.join(" ")}\` | ${command.parentPath.length > 0 ? "`" + command.parentPath.join(" ") + "`" : "None"} | ${command.depth} | \`${command.pluginId}\` | ${command.description || "None"} |`,
      );
    }
  }

  if (list.cli.runtimeCommands.length > 0) {
    lines.push(
      "",
      "## Runtime registered commands",
      "",
      "| Command path | Parent | Depth | Visible subcommands | Description |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const command of list.cli.runtimeCommands) {
      lines.push(
        `| \`${command.commandPath.join(" ")}\` | ${command.parentPath.length > 0 ? "`" + command.parentPath.join(" ") + "`" : "None"} | ${command.depth} | ${command.visibleSubcommandCount} | ${command.description || "None"} |`,
      );
    }
  }

  if (list.cli.nodeCommands.length > 0) {
    lines.push(
      "",
      "## Node/operator commands",
      "",
      "| Command | Node | Availability | Approval | Risk | Effect mode | Invocation |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const command of list.cli.nodeCommands) {
      lines.push(
        `| \`${command.command}\` | ${command.nodeName ?? command.nodeId ?? "Any"} | \`${command.availability}\` | \`${command.approvalKind}\` | \`${command.risk}\` | \`${command.effectMode}\` | \`${command.invocationHint}\` |`,
      );
    }
  }

  lines.push(
    "",
    "## Agent/tool surfaces",
    "",
    "| Surface | Owner | Risk | Effect mode | Confirmation | Target | Source | Discovery |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const surface of list.agentToolSurfaces) {
    lines.push(
      `| \`${surface.id}\` | \`${surface.owner}\` | \`${surface.risk}\` | \`${surface.effectMode}\` | ${surface.confirmationRequired ? "yes" : "no"} | \`${surface.target}\` | ${surface.source} | \`${surface.discoveryMode}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
