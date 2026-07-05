import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCliCatalogOverlayReport,
  renderCliCatalogOverlayReportMarkdown,
  writeCliCatalogOverlayReport,
} from "../../scripts/cli-catalog-overlay-report.js";

describe("CLI catalog overlay report", () => {
  it("builds an advisory report without gate semantics", () => {
    const report = buildCliCatalogOverlayReport();

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-report",
      advisory: true,
    });
    expect(report.counts.routedOperations).toBe(14);
    expect(report.notes.join("\n")).toContain("do not fail validation");
  });

  it("renders deterministic Markdown", () => {
    const markdown = renderCliCatalogOverlayReportMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Report");
    expect(markdown).toContain("- Blocking gate: no");
    expect(markdown).toContain("catalog-test-matrix.json");
  });

  it("writes summary, test-matrix, and report artifacts", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "openclaw-catalog-report-"));
    try {
      const report = writeCliCatalogOverlayReport(outDir);

      const summary = JSON.parse(readFileSync(path.join(outDir, report.files.summaryJson), "utf8"));
      const matrix = JSON.parse(
        readFileSync(path.join(outDir, report.files.testMatrixJson), "utf8"),
      );
      const markdown = readFileSync(path.join(outDir, report.files.reportMarkdown), "utf8");
      expect(summary.generatedFrom).toBe("cli-catalog-overlay-operator-summary");
      expect(matrix.generatedFrom).toBe("cli-catalog-overlay-test-matrix");
      expect(markdown).toContain("Mode: advisory");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
