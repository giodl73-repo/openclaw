#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCatalogList } from "../src/cli-catalog-overlay/list.js";
import { buildCatalogOperatorSummary } from "../src/cli-catalog-overlay/operator-summary.js";
import { buildCatalogTestMatrix } from "../src/cli-catalog-overlay/test-matrix.js";

export const DEFAULT_CLI_CATALOG_REPORT_DIR = ".artifacts/cli-catalog-overlay";

export type CliCatalogOverlayReport = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-report";
  readonly advisory: true;
  readonly files: {
    readonly summaryJson: string;
    readonly testMatrixJson: string;
    readonly reportMarkdown: string;
  };
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly agentToolSurfaces: number;
    readonly coverageGaps: number;
  };
  readonly notes: readonly string[];
};

function markdownList(values: readonly string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}

export function buildCliCatalogOverlayReport(): CliCatalogOverlayReport {
  const list = buildCatalogList();
  const testMatrix = buildCatalogTestMatrix({ list });
  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-report",
    advisory: true,
    files: {
      summaryJson: "catalog-summary.json",
      testMatrixJson: "catalog-test-matrix.json",
      reportMarkdown: "catalog-report.md",
    },
    counts: {
      commandDescriptors: list.counts.commandDescriptors,
      commandRoutes: list.counts.commandRoutes,
      routedOperations: list.counts.routedOperations,
      agentToolSurfaces: list.counts.agentToolSurfaces,
      coverageGaps: testMatrix.counts.coverageGaps,
    },
    notes: [
      "Catalog reports are advisory artifacts for review and automation consumers.",
      "Coverage gaps are reported but do not fail validation by themselves.",
      "Use schema fixtures to review intentional JSON contract drift.",
    ],
  };
}

export function renderCliCatalogOverlayReportMarkdown(
  report = buildCliCatalogOverlayReport(),
): string {
  return [
    "# CLI Catalog Overlay Report",
    "",
    "Advisory report for command catalog drift, routed-operation coverage, and operator handoff review.",
    "",
    "## Status",
    "",
    "- Mode: advisory",
    "- Blocking gate: no",
    "",
    "## Counts",
    "",
    `- CLI descriptors: ${report.counts.commandDescriptors}`,
    `- Command routes: ${report.counts.commandRoutes}`,
    `- Routed operations: ${report.counts.routedOperations}`,
    `- Agent/tool surfaces: ${report.counts.agentToolSurfaces}`,
    `- Test-matrix coverage gaps: ${report.counts.coverageGaps}`,
    "",
    "## Output files",
    "",
    `- ${report.files.summaryJson}`,
    `- ${report.files.testMatrixJson}`,
    `- ${report.files.reportMarkdown}`,
    "",
    "## Notes",
    "",
    ...markdownList(report.notes),
    "",
  ].join("\n");
}

export function writeCliCatalogOverlayReport(
  outDir = DEFAULT_CLI_CATALOG_REPORT_DIR,
): CliCatalogOverlayReport {
  const list = buildCatalogList();
  const testMatrix = buildCatalogTestMatrix({ list });
  const summary = buildCatalogOperatorSummary({ list, testMatrix });
  const report = buildCliCatalogOverlayReport();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, report.files.summaryJson),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(
    path.join(outDir, report.files.testMatrixJson),
    `${JSON.stringify(testMatrix, null, 2)}\n`,
  );
  writeFileSync(
    path.join(outDir, report.files.reportMarkdown),
    renderCliCatalogOverlayReportMarkdown(report),
  );
  return report;
}

function parseOutDir(argv: readonly string[]): string {
  const index = argv.indexOf("--out-dir");
  if (index === -1) {
    return DEFAULT_CLI_CATALOG_REPORT_DIR;
  }
  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error("--out-dir requires a path");
  }
  return value;
}

export function runCliCatalogOverlayReport(argv = process.argv.slice(2)): number {
  try {
    const report = writeCliCatalogOverlayReport(parseOutDir(argv));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCliCatalogOverlayReport();
}
