#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    "This page is generated from the CLI catalog overlay registry. It describes existing OpenClaw command and tool surfaces that the AI can route toward.",
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
    "## Surfaces",
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
