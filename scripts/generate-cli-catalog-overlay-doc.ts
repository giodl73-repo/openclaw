#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCatalogList, type CliCatalogList } from "../src/cli-catalog-overlay/list.js";
import {
  listCliCatalogSurfaces,
  type CliCatalogSurfaceDefinition,
} from "../src/cli-catalog-overlay/registry.js";

export const CLI_CATALOG_OVERLAY_DOC_PATH = "docs/cli/ai-surface-catalog.md";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function boolLabel(value: boolean): string {
  return value ? "yes" : "no";
}

function inlineCodeList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => "`" + value + "`").join(", ") : "None";
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function paddedTableRow(values: readonly string[], widths: readonly number[]): string {
  return `| ${values.map((value, index) => markdownTableCell(value).padEnd(widths[index])).join(" | ")} |`;
}

function renderMarkdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const escapedRows = rows.map((row) => row.map(markdownTableCell));
  const escapedHeaders = headers.map(markdownTableCell);
  const widths = escapedHeaders.map((header, index) =>
    Math.max(header.length, ...escapedRows.map((row) => row[index].length)),
  );
  return [
    paddedTableRow(escapedHeaders, widths),
    paddedTableRow(
      widths.map((width) => "-".repeat(Math.max(3, width))),
      widths,
    ),
    ...escapedRows.map((row) => paddedTableRow(row, widths)),
  ];
}

function commandPathLabel(path: readonly string[]): string {
  return "`" + path.join(" ") + "`";
}

function renderCliDescriptorTable(descriptors: CliCatalogList["cli"]["descriptors"]): string[] {
  return renderMarkdownTable(
    ["Name", "Description", "Source", "Subcommands", "Parent default help"],
    descriptors.map((descriptor) => [
      "`" + descriptor.name + "`",
      descriptor.description,
      "`" + descriptor.source + "`",
      boolLabel(descriptor.hasSubcommands),
      boolLabel(descriptor.parentDefaultHelp),
    ]),
  );
}

function renderCommandRouteTable(routes: CliCatalogList["cli"]["commandRoutes"]): string[] {
  return renderMarkdownTable(
    ["Command path", "Exact", "Route ID", "Policy keys"],
    routes.map((route) => [
      commandPathLabel(route.commandPath),
      boolLabel(route.exact),
      route.routeId ? "`" + route.routeId + "`" : "None",
      inlineCodeList(route.policyKeys),
    ]),
  );
}

function renderRoutedOperationTable(
  operations: CliCatalogList["cli"]["routedOperations"],
): string[] {
  return renderMarkdownTable(
    ["Operation", "Command paths"],
    operations.map((operation) => [
      `\`${operation.id}\``,
      operation.commandPaths.map(commandPathLabel).join(", "),
    ]),
  );
}

function renderSurface(surface: CliCatalogSurfaceDefinition): string[] {
  const descriptorSource = surface.cliDescriptor
    ? `\n- CLI descriptor: \`${surface.cliDescriptor.name}\``
    : "";
  return [
    `### \`${surface.id}\`: ${surface.title}`,
    "",
    surface.intent,
    "",
    `- Kind: \`${surface.kind}\``,
    `- Dispatch mode: \`${surface.dispatchMode}\``,
    `- Target: \`${surface.target}\``,
    `- Owner: \`${surface.owner}\``,
    `- Status: \`${surface.status}\``,
    `- Risk: \`${surface.risk}\``,
    `- Confirmation required: ${boolLabel(surface.confirmationRequired)}`,
    `- Effect mode: \`${surface.effectMode}\``,
    `- Source: ${surface.source}${descriptorSource}`,
    `- Effects: ${inlineCodeList(surface.effects)}`,
    `- Examples: ${surface.examples.join("; ")}`,
    `- Command hints: ${inlineCodeList(surface.commandHints)}`,
    "",
  ];
}

export function renderCliCatalogOverlayReferenceDoc(): string {
  const catalog = buildCatalogList();
  const surfaces = listCliCatalogSurfaces();
  return [
    "---",
    'summary: "AI-operable OpenClaw surfaces described by the CLI catalog overlay"',
    'title: "AI Surface Catalog"',
    'sidebarTitle: "AI Surface Catalog"',
    "---",
    "",
    "# AI Surface Catalog",
    "",
    "This page is generated from the CLI catalog overlay registry and existing OpenClaw CLI registries. It describes the command metadata, command-routing metadata, routed operations, and agent tool surfaces that the AI can route toward.",
    "",
    "The catalog is metadata only. It does not add a new execution dispatcher, runtime hook, gateway plugin, or policy engine. Each listed surface keeps owning its current validation, permissions, and execution behavior.",
    "",
    "## CLI access",
    "",
    "Use `openclaw catalog list` to inspect this read-only surface list from the CLI. Pass `--json` for automation or `--markdown` for Markdown output.",
    "",
    "```bash",
    "openclaw catalog list",
    "openclaw catalog list --json",
    "openclaw catalog list --markdown",
    "```",
    "",
    "## Catalog shape",
    "",
    `- CLI descriptors: ${catalog.counts.commandDescriptors}`,
    `- Command routes: ${catalog.counts.commandRoutes}`,
    `- Routed operations: ${catalog.counts.routedOperations}`,
    `- Agent/tool surfaces: ${catalog.counts.agentToolSurfaces}`,
    `- Prompt projection items: ${catalog.counts.promptProjection}`,
    "",
    "The full JSON output is hierarchical. `cli.descriptors` is the command inventory, `cli.commandRoutes` is the startup/routing policy inventory, `cli.routedOperations` is the mechanical fast-path operation inventory, and `agentToolSurfaces` describes non-CLI or tool-backed model surfaces.",
    "",
    "## Integration uses",
    "",
    "The catalog is designed for more than prompt routing. Use `buildCatalogList()` or `openclaw catalog list --json` when a consumer needs structured command metadata instead of hardcoded command lists or scraped help output.",
    "",
    "Good first consumers are:",
    "",
    "- Reference docs generated from descriptors, command routes, routed operations, and agent/tool surfaces.",
    "- Audit and policy inventory reports for risk, confirmation, effect mode, and route-policy keys.",
    "- Routed-operation smoke-test matrices and coverage gap reports.",
    "- Operator, diagnostics, admin, and debug views that need to explain mechanical OpenClaw surfaces.",
    "- Future automation adapters that select an existing command or tool from catalog metadata while leaving execution with that surface.",
    "",
    "## CLI descriptors",
    "",
    ...renderCliDescriptorTable(catalog.cli.descriptors),
    "",
    "## Command routes",
    "",
    ...renderCommandRouteTable(catalog.cli.commandRoutes),
    "",
    "## Routed operations",
    "",
    ...renderRoutedOperationTable(catalog.cli.routedOperations),
    "",
    "## Agent/tool surfaces",
    "",
    ...surfaces.flatMap(renderSurface),
  ].join("\n");
}

async function readCommittedDoc(): Promise<string | null> {
  try {
    return await fs.readFile(path.resolve(repoRoot, CLI_CATALOG_OVERLAY_DOC_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function runCliCatalogOverlayDocGenerator(
  argv = process.argv.slice(2),
): Promise<void> {
  const expected = renderCliCatalogOverlayReferenceDoc();
  const docPath = path.resolve(repoRoot, CLI_CATALOG_OVERLAY_DOC_PATH);
  if (argv.includes("--write")) {
    await fs.mkdir(path.dirname(docPath), { recursive: true });
    await fs.writeFile(docPath, expected);
    console.log(`Wrote ${CLI_CATALOG_OVERLAY_DOC_PATH}`);
    return;
  }
  if (argv.includes("--check")) {
    const actual = await readCommittedDoc();
    if (actual !== expected) {
      console.error(
        `CLI catalog overlay docs are stale. Run: node --import tsx scripts/generate-cli-catalog-overlay-doc.ts --write`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${CLI_CATALOG_OVERLAY_DOC_PATH} is current.`);
    return;
  }
  console.log(expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCliCatalogOverlayDocGenerator();
}
