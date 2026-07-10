import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCliCatalogOverlayReport,
  renderCliCatalogOverlayReportMarkdown,
  writeCliCatalogOverlayReport,
} from "../../scripts/cli-catalog-overlay-report.js";
import { buildCatalogTestMatrix } from "../../src/cli-catalog-overlay/test-matrix.js";

describe("CLI catalog overlay report", () => {
  it("builds an advisory report without gate semantics", () => {
    const report = buildCliCatalogOverlayReport();

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-report",
      advisory: true,
    });
    expect(report.counts.routedOperations).toBe(14);
    expect(report.counts.confirmationRequiredSurfaces).toBe(3);
    expect(report.auditSignals.confirmationRequiredSurfaceIds).toEqual([
      "config-unset",
      "gateway",
      "skill_workshop",
    ]);
    expect(report.auditSignals.routePolicyKeys).toContain("networkProxy");
    expect(report.counts.evidencedRoutedOperations).toBe(0);
    expect(report.auditSignals.evidencedRouteIds).toEqual([]);
    expect(report.notes.join("\n")).toContain("only when supplied");
  });

  it("renders deterministic Markdown", () => {
    const markdown = renderCliCatalogOverlayReportMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Report");
    expect(markdown).toContain("- Blocking gate: no");
    expect(markdown).toContain("## Audit signals");
    expect(markdown).toContain(
      "- Confirmation required: `config-unset`, `gateway`, `skill_workshop`",
    );
    expect(markdown).toContain("- Routed operations with supplied evidence: 0");
    expect(markdown).toContain("catalog-audit.json");
    expect(markdown).toContain("catalog-test-matrix.json");
  });

  it("reports only explicitly supplied route evidence", () => {
    const testMatrix = buildCatalogTestMatrix({
      coverageEvidence: [
        {
          routeId: "gateway-status",
          testPath: "src/cli/catalog-cli.test.ts",
          testName: "prints catalog list Markdown by default",
        },
      ],
    });
    const report = buildCliCatalogOverlayReport({ testMatrix });

    expect(report.counts.evidencedRoutedOperations).toBe(1);
    expect(report.auditSignals.evidencedRouteIds).toEqual(["gateway-status"]);
  });

  it("writes audit, summary, test-matrix, and report artifacts", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "openclaw-catalog-report-"));
    try {
      const report = writeCliCatalogOverlayReport(outDir);

      const audit = JSON.parse(readFileSync(path.join(outDir, report.files.auditJson), "utf8"));
      const summary = JSON.parse(readFileSync(path.join(outDir, report.files.summaryJson), "utf8"));
      const matrix = JSON.parse(
        readFileSync(path.join(outDir, report.files.testMatrixJson), "utf8"),
      );
      const markdown = readFileSync(path.join(outDir, report.files.reportMarkdown), "utf8");
      expect(audit.generatedFrom).toBe("cli-catalog-overlay-audit");
      expect(summary.generatedFrom).toBe("cli-catalog-overlay-operator-summary");
      expect(matrix.generatedFrom).toBe("cli-catalog-overlay-test-matrix");
      expect(audit.surfaces.confirmationRequiredSurfaceIds).toEqual([
        "config-unset",
        "gateway",
        "skill_workshop",
      ]);
      expect(markdown).toContain("Mode: advisory");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
