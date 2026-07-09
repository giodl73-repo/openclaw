#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCatalogAudit, type CliCatalogAudit } from "../src/cli-catalog-overlay/audit.js";
import { buildCatalogList, type CliCatalogList } from "../src/cli-catalog-overlay/list.js";
import { buildCatalogOperatorSummary } from "../src/cli-catalog-overlay/operator-summary.js";
import {
  buildCatalogTestMatrix,
  type CliCatalogTestMatrix,
} from "../src/cli-catalog-overlay/test-matrix.js";

export const DEFAULT_CLI_CATALOG_REPORT_DIR = ".artifacts/cli-catalog-overlay";

export type CliCatalogOverlayReport = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-report";
  readonly advisory: true;
  readonly files: {
    readonly auditJson: string;
    readonly summaryJson: string;
    readonly testMatrixJson: string;
    readonly reportMarkdown: string;
  };
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly agentToolSurfaces: number;
    readonly nodeCommands: number;
    readonly nodeCommandsRequiringApproval: number;
    readonly confirmationRequiredSurfaces: number;
    readonly routePolicyKeys: number;
    readonly routesWithoutPolicyKeys: number;
    readonly coverageGaps: number;
  };
  readonly auditSignals: {
    readonly confirmationRequiredSurfaceIds: readonly string[];
    readonly mediumRiskSurfaceIds: readonly string[];
    readonly mixedEffectSurfaceIds: readonly string[];
    readonly nodeCommandApprovalIds: readonly string[];
    readonly routePolicyKeys: readonly string[];
    readonly routesWithoutPolicyKeys: readonly string[];
    readonly coverageGapRouteIds: readonly string[];
  };
  readonly notes: readonly string[];
};

function markdownList(values: readonly string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}

function inlineCodeList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => "`" + value + "`").join(", ") : "None";
}

function surfaceGroupIds(audit: CliCatalogAudit, groupId: string): readonly string[] {
  return audit.surfaces.byRisk.find((group) => group.id === groupId)?.surfaceIds ?? [];
}

function effectModeGroupIds(audit: CliCatalogAudit, groupId: string): readonly string[] {
  return audit.surfaces.byEffectMode.find((group) => group.id === groupId)?.surfaceIds ?? [];
}

function commandPathLabels(paths: readonly (readonly string[])[]): readonly string[] {
  return paths.map((pathParts) => pathParts.join(" "));
}

export function buildCliCatalogOverlayReport(
  params: {
    readonly list?: CliCatalogList;
    readonly audit?: CliCatalogAudit;
    readonly testMatrix?: CliCatalogTestMatrix;
  } = {},
): CliCatalogOverlayReport {
  const list = params.list ?? buildCatalogList();
  const audit = params.audit ?? buildCatalogAudit(list);
  const testMatrix = params.testMatrix ?? buildCatalogTestMatrix({ list });
  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-report",
    advisory: true,
    files: {
      auditJson: "catalog-audit.json",
      summaryJson: "catalog-summary.json",
      testMatrixJson: "catalog-test-matrix.json",
      reportMarkdown: "catalog-report.md",
    },
    counts: {
      commandDescriptors: list.counts.commandDescriptors,
      commandRoutes: list.counts.commandRoutes,
      routedOperations: list.counts.routedOperations,
      agentToolSurfaces: list.counts.agentToolSurfaces,
      nodeCommands: list.counts.nodeCommands,
      nodeCommandsRequiringApproval: audit.counts.nodeCommandsRequiringApproval,
      confirmationRequiredSurfaces: audit.counts.confirmationRequiredSurfaces,
      routePolicyKeys: audit.counts.routePolicyKeys,
      routesWithoutPolicyKeys: audit.commandRoutes.routesWithoutPolicyKeys.length,
      coverageGaps: testMatrix.counts.coverageGaps,
    },
    auditSignals: {
      confirmationRequiredSurfaceIds: audit.surfaces.confirmationRequiredSurfaceIds,
      mediumRiskSurfaceIds: surfaceGroupIds(audit, "medium"),
      mixedEffectSurfaceIds: effectModeGroupIds(audit, "mixed"),
      nodeCommandApprovalIds: audit.nodeCommands.approvalRequiredCommandIds,
      routePolicyKeys: audit.commandRoutes.byPolicyKey.map((group) => group.policyKey).toSorted(),
      routesWithoutPolicyKeys: commandPathLabels(audit.commandRoutes.routesWithoutPolicyKeys),
      coverageGapRouteIds: testMatrix.coverageGaps.map((gap) => gap.routeId),
    },
    notes: [
      "Catalog reports are advisory artifacts for review and automation consumers.",
      "Coverage gaps are reported but do not fail validation by themselves.",
      "Audit signals identify review targets but do not enforce policy.",
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
    `- Node/operator commands: ${report.counts.nodeCommands}`,
    `- Node/operator commands requiring approval: ${report.counts.nodeCommandsRequiringApproval}`,
    `- Confirmation-required surfaces: ${report.counts.confirmationRequiredSurfaces}`,
    `- Route policy keys: ${report.counts.routePolicyKeys}`,
    `- Routes without policy keys: ${report.counts.routesWithoutPolicyKeys}`,
    `- Test-matrix coverage gaps: ${report.counts.coverageGaps}`,
    "",
    "## Audit signals",
    "",
    `- Confirmation required: ${inlineCodeList(report.auditSignals.confirmationRequiredSurfaceIds)}`,
    `- Medium risk: ${inlineCodeList(report.auditSignals.mediumRiskSurfaceIds)}`,
    `- Mixed effect mode: ${inlineCodeList(report.auditSignals.mixedEffectSurfaceIds)}`,
    `- Node/operator approval: ${inlineCodeList(report.auditSignals.nodeCommandApprovalIds)}`,
    `- Route policy keys: ${inlineCodeList(report.auditSignals.routePolicyKeys)}`,
    `- Routes without policy keys: ${inlineCodeList(report.auditSignals.routesWithoutPolicyKeys)}`,
    `- Coverage gap route IDs: ${inlineCodeList(report.auditSignals.coverageGapRouteIds)}`,
    "",
    "## Output files",
    "",
    `- ${report.files.auditJson}`,
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
  const audit = buildCatalogAudit(list);
  const testMatrix = buildCatalogTestMatrix({ list });
  const summary = buildCatalogOperatorSummary({ list, audit, testMatrix });
  const report = buildCliCatalogOverlayReport({ list, audit, testMatrix });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, report.files.auditJson), `${JSON.stringify(audit, null, 2)}\n`);
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
