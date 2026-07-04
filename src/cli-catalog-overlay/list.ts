import { cliCommandCatalog } from "../cli/command-catalog.js";
import { getCoreCliCommandDescriptors } from "../cli/program/core-command-descriptors.js";
import { routedCommandDefinitions } from "../cli/program/routed-command-definitions.js";
import { getSubCliEntries } from "../cli/program/subcli-descriptors.js";
import { listCliCatalogSurfaces } from "./registry.js";

export type CliCatalogListSurface = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly dispatchMode: string;
  readonly target: string;
  readonly source: string;
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
};

export type CliCatalogListCommandRoute = {
  readonly commandPath: readonly string[];
  readonly exact: boolean;
  readonly routeId?: string;
  readonly policyKeys: readonly string[];
};

export type CliCatalogListRoutedOperation = {
  readonly id: string;
  readonly commandPaths: readonly (readonly string[])[];
};

export type CliCatalogList = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay";
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly agentToolSurfaces: number;
    readonly promptProjection: number;
  };
  readonly cli: {
    readonly descriptors: readonly CliCatalogListDescriptor[];
    readonly commandRoutes: readonly CliCatalogListCommandRoute[];
    readonly routedOperations: readonly CliCatalogListRoutedOperation[];
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
  }));
  const subcli = getSubCliEntries().map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    hasSubcommands: descriptor.hasSubcommands,
    parentDefaultHelp: Boolean(descriptor.parentDefaultHelp),
    source: "subcli" as const,
  }));
  return [...core, ...subcli];
}

function buildCommandRoutes(): readonly CliCatalogListCommandRoute[] {
  return cliCommandCatalog.map((entry) => ({
    commandPath: entry.commandPath,
    exact: Boolean(entry.exact),
    ...(entry.route ? { routeId: entry.route.id } : {}),
    policyKeys: entry.policy ? Object.keys(entry.policy).toSorted() : [],
  }));
}

function buildRoutedOperations(
  routes = buildCommandRoutes(),
): readonly CliCatalogListRoutedOperation[] {
  return Object.keys(routedCommandDefinitions)
    .toSorted()
    .map((id) => ({
      id,
      commandPaths: routes
        .filter((route) => route.routeId === id)
        .map((route) => route.commandPath),
    }));
}

export function buildCatalogList(): CliCatalogList {
  const descriptors = buildDescriptors();
  const commandRoutes = buildCommandRoutes();
  const routedOperations = buildRoutedOperations(commandRoutes);
  const agentToolSurfaces = mapSurfaces();
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
    },
    cli: {
      descriptors,
      commandRoutes,
      routedOperations,
    },
    agentToolSurfaces,
    promptProjection,
  };
}

export function renderCatalogListMarkdown(): string {
  const list = buildCatalogList();
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
  lines.push(
    "",
    "## Agent/tool surfaces",
    "",
    "| Surface | Owner | Risk | Effect mode | Confirmation | Target | Source |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const surface of list.agentToolSurfaces) {
    lines.push(
      `| \`${surface.id}\` | \`${surface.owner}\` | \`${surface.risk}\` | \`${surface.effectMode}\` | ${surface.confirmationRequired ? "yes" : "no"} | \`${surface.target}\` | ${surface.source} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
