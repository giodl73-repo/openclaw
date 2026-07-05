#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCatalogAudit } from "../src/cli-catalog-overlay/audit.js";
import { buildCliCatalogConsumerContract } from "../src/cli-catalog-overlay/consumer-contract.js";
import { buildCatalogList, type CliCatalogList } from "../src/cli-catalog-overlay/list.js";
import { buildCatalogOperatorSummary } from "../src/cli-catalog-overlay/operator-summary.js";
import { listCliCatalogPromptSurfaces } from "../src/cli-catalog-overlay/prompt-projection.js";
import { buildCatalogTestMatrix } from "../src/cli-catalog-overlay/test-matrix.js";

export const CATALOG_REFERENCE_DOC_PATH = "docs/cli/catalog.md";

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function code(value: string): string {
  return "`" + value + "`";
}

function codeList(values: readonly string[]): string {
  return values.length > 0 ? values.map(code).join(", ") : "None";
}

function commandPathLabel(path: readonly string[]): string {
  return path.join(" ");
}

function commandPathList(paths: readonly (readonly string[])[]): string {
  return paths.length > 0 ? paths.map((path) => code(commandPathLabel(path))).join(", ") : "None";
}

function paddedRow(cells: readonly string[], widths: readonly number[]): string {
  return `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const escapedHeaders = headers.map(escapeCell);
  const escapedRows = rows.map((row) => row.map(escapeCell));
  const widths = escapedHeaders.map((header, index) =>
    Math.max(header.length, "---".length, ...escapedRows.map((row) => row[index]?.length ?? 0)),
  );
  return [
    paddedRow(escapedHeaders, widths),
    paddedRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
    ...escapedRows.map((row) => paddedRow(row, widths)),
  ];
}

function descriptorRows(list: CliCatalogList): readonly (readonly string[])[] {
  return list.cli.descriptors.map((descriptor) => [
    code(descriptor.name),
    descriptor.description || "None",
    code(descriptor.sourceKind),
    code(descriptor.discoveryMode),
    descriptor.hasSubcommands ? "yes" : "no",
  ]);
}

function withPublicCliCatalogEnvironment<T>(callback: () => T): T {
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  try {
    return callback();
  } finally {
    if (originalPrivateQaCli === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
    }
  }
}

export function buildCliCatalogReferenceMarkdown(): string {
  return withPublicCliCatalogEnvironment(() => {
    const list = buildCatalogList();
    const audit = buildCatalogAudit(list);
    const testMatrix = buildCatalogTestMatrix({ list });
    const summary = buildCatalogOperatorSummary({ list, audit, testMatrix });
    const promptSurfaces = listCliCatalogPromptSurfaces();
    const consumerContract = buildCliCatalogConsumerContract();
    const lines = [
      "---",
      'summary: "Generated CLI catalog reference for command metadata, lenses, and machine-readable contracts"',
      "read_when:",
      "  - Inspecting the `openclaw catalog` metadata surfaces",
      "  - Reviewing prompt, audit, test, or operator catalog lenses",
      'title: "CLI catalog reference"',
      "---",
      "",
      "# CLI catalog reference",
      "",
      "This page is generated from the CLI catalog APIs. Regenerate it with:",
      "",
      "```bash",
      "node --import tsx scripts/generate-cli-catalog-doc.ts --write",
      "```",
      "",
      "Use `--check` in validation to verify the checked-in page is current.",
      "",
      "## Commands",
      "",
      ...markdownTable(
        ["Command", "Purpose", "Machine output"],
        [
          [
            code("openclaw catalog list"),
            "List command descriptors, command routes, routed operations, runtime commands, plugin descriptor commands, agent/tool surfaces, and prompt projection IDs.",
            code("--json"),
          ],
          [
            code("openclaw catalog audit"),
            "Group catalog surfaces and command routes for audit and policy review.",
            code("--json"),
          ],
          [
            code("openclaw catalog test-matrix"),
            "List routed-operation smoke-test candidates and explicit coverage gaps.",
            code("--json"),
          ],
          [
            code("openclaw catalog summary"),
            "Summarize catalog inventory for operator and admin handoffs.",
            code("--json"),
          ],
        ],
      ),
      "",
      "## Lens counts",
      "",
      ...markdownTable(
        ["Lens", "Generated from", "Key counts"],
        [
          [
            "List",
            code(list.generatedFrom),
            `descriptors ${list.counts.commandDescriptors}; routes ${list.counts.commandRoutes}; routed operations ${list.counts.routedOperations}; agent/tool surfaces ${list.counts.agentToolSurfaces}; runtime commands dynamic; plugin commands opt-in`,
          ],
          [
            "Audit",
            code(audit.generatedFrom),
            `confirmation-required surfaces ${audit.counts.confirmationRequiredSurfaces}; route policy keys ${audit.counts.routePolicyKeys}`,
          ],
          [
            "Test matrix",
            code(testMatrix.generatedFrom),
            `smoke candidates ${testMatrix.counts.smokeCandidates}; coverage gaps ${testMatrix.counts.coverageGaps}`,
          ],
          [
            "Summary",
            code(summary.generatedFrom),
            `coverage gaps ${summary.counts.coverageGaps}; policy keys ${summary.attention.policyKeyIds.length}`,
          ],
          [
            "Prompt projection",
            code("cli-catalog-overlay-prompt"),
            `prompt surfaces ${promptSurfaces.length}`,
          ],
        ],
      ),
      "",
      "## JSON contracts",
      "",
      ...markdownTable(
        ["Output", "Schema version", "Stable fields"],
        [
          [
            code("catalog list --json"),
            String(list.schemaVersion),
            codeList(Object.keys(list).toSorted()),
          ],
          [
            code("catalog audit --json"),
            String(audit.schemaVersion),
            codeList(Object.keys(audit).toSorted()),
          ],
          [
            code("catalog test-matrix --json"),
            String(testMatrix.schemaVersion),
            codeList(Object.keys(testMatrix).toSorted()),
          ],
          [
            code("catalog summary --json"),
            String(summary.schemaVersion),
            codeList(Object.keys(summary).toSorted()),
          ],
        ],
      ),
      "",
      "Checked schema fixtures live under `test/fixtures/cli-catalog-overlay/` and intentionally treat inventory counts as reviewable snapshots, not eternal compatibility promises.",
      "",
      "## Dynamic command inventory",
      "",
      "The generated reference intentionally snapshots static descriptors, command routes, routed operations, agent/tool surfaces, and prompt projection metadata. `openclaw catalog list` also fills `cli.runtimeCommands` from the current Commander tree at command execution time, and `cli.pluginCommands` when `--plugin-descriptors` is requested. Inspect those dynamic arrays with `openclaw catalog list --json` instead of treating this generated page as a complete runtime/plugin inventory dump.",
      "",
      ...markdownTable(
        ["Field", "Scope", "How to inspect"],
        [
          [
            "`cli.runtimeCommands`",
            "Current invocation Commander tree",
            "`openclaw catalog list --json`",
          ],
          [
            "`cli.pluginCommands`",
            "Metadata-only plugin descriptor entries requested on demand",
            "`openclaw catalog list --json --plugin-descriptors`",
          ],
        ],
      ),
      "",
      "## CLI descriptors",
      "",
      ...markdownTable(
        ["Descriptor", "Description", "Source", "Discovery", "Subcommands"],
        descriptorRows(list),
      ),
      "",
      "## Routed operations",
      "",
      ...markdownTable(
        ["Operation", "Command paths"],
        list.cli.routedOperations.map((operation) => [
          code(operation.id),
          commandPathList(operation.commandPaths),
        ]),
      ),
      "",
      "## Agent and tool surfaces",
      "",
      ...markdownTable(
        ["Surface", "Owner", "Risk", "Effect mode", "Confirmation", "Target", "Discovery"],
        list.agentToolSurfaces.map((surface) => [
          code(surface.id),
          code(surface.owner),
          code(surface.risk),
          code(surface.effectMode),
          surface.confirmationRequired ? "yes" : "no",
          code(surface.target),
          code(surface.discoveryMode),
        ]),
      ),
      "",
      "## Prompt projection",
      "",
      ...markdownTable(
        ["Surface", "Kind", "Target", "Risk", "Command hints"],
        promptSurfaces.map((surface) => [
          code(surface.id),
          code(surface.kind),
          code(surface.target),
          code(surface.risk),
          codeList(surface.commandHints),
        ]),
      ),
      "",
      "## Consumer contract",
      "",
      "The catalog contract is read-only. External consumers should use the JSON commands instead of scraping help text. Builder modules remain repo-internal until package exports are added deliberately.",
      "",
      ...markdownTable(
        ["Area", "Values"],
        [
          ["Consumers", codeList([...consumerContract.consumers])],
          ["Stable external commands", codeList(consumerContract.stableExternalCommands)],
          ["Repo-internal builders", codeList(consumerContract.repoInternalBuilderModules)],
          ["Non-goals", consumerContract.nonGoals.join("; ")],
        ],
      ),
      "",
      ...markdownTable(
        ["JSON output", "Stable fields", "Snapshot fields"],
        consumerContract.jsonOutputs.map((output) => [
          code(output.command),
          codeList(output.stableFields),
          codeList(output.snapshotFields),
        ]),
      ),
      "",
      "## Audit and operator attention",
      "",
      ...markdownTable(
        ["Area", "Values"],
        [
          ["Confirmation required", codeList(summary.attention.confirmationRequiredSurfaceIds)],
          ["Medium risk", codeList(summary.attention.mediumRiskSurfaceIds)],
          ["Mixed effect mode", codeList(summary.attention.mixedEffectSurfaceIds)],
          ["Route policy keys", codeList(summary.attention.policyKeyIds)],
        ],
      ),
    ];
    return `${lines.join("\n")}\n`;
  });
}

export function runCliCatalogDocGenerator(argv = process.argv.slice(2)): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: node --import tsx scripts/generate-cli-catalog-doc.ts --write|--check");
    return 1;
  }

  const outputPath = path.join(process.cwd(), CATALOG_REFERENCE_DOC_PATH);
  const content = buildCliCatalogReferenceMarkdown();
  if (write) {
    writeFileSync(outputPath, content);
    return 0;
  }

  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== content) {
    console.error(
      `${CATALOG_REFERENCE_DOC_PATH} is stale; run node --import tsx scripts/generate-cli-catalog-doc.ts --write`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCliCatalogDocGenerator();
}
