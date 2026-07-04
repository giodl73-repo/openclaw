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

export type CliCatalogList = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay";
  readonly surfaceCount: number;
  readonly surfaces: readonly CliCatalogListSurface[];
};

export function buildCatalogList(): CliCatalogList {
  const surfaces = listCliCatalogSurfaces().map((surface) => ({
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
  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay",
    surfaceCount: surfaces.length,
    surfaces,
  };
}

export function renderCatalogListMarkdown(): string {
  const list = buildCatalogList();
  const lines = [
    "# CLI Catalog Overlay List",
    "",
    "Read-only list of AI-routable OpenClaw command/tool surfaces described by the CLI catalog overlay.",
    "",
    "| Surface | Owner | Risk | Effect mode | Confirmation | Target | Source |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const surface of list.surfaces) {
    lines.push(
      `| \`${surface.id}\` | \`${surface.owner}\` | \`${surface.risk}\` | \`${surface.effectMode}\` | ${surface.confirmationRequired ? "yes" : "no"} | \`${surface.target}\` | ${surface.source} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
