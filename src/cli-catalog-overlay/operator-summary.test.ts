import { describe, expect, it } from "vitest";
import {
  buildCatalogOperatorSummary,
  renderCatalogOperatorSummaryMarkdown,
} from "./operator-summary.js";

describe("cli catalog operator summary", () => {
  it("combines catalog list, audit, and test-matrix counts", () => {
    const summary = buildCatalogOperatorSummary();

    expect(summary).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-operator-summary",
      counts: {
        commandDescriptors: 58,
        commandRoutes: 94,
        routedOperations: 14,
        agentToolSurfaces: 5,
        confirmationRequiredSurfaces: 2,
        routePolicyKeys: 7,
        coverageGaps: 14,
      },
    });
    expect(summary.attention.confirmationRequiredSurfaceIds).toEqual(["gateway", "skill_workshop"]);
    expect(summary.attention.mediumRiskSurfaceIds).toEqual(["gateway", "skill_workshop"]);
    expect(summary.attention.policyKeyIds).toContain("networkProxy");
    expect(summary.nextChecks).toContain(
      "Use catalog test-matrix output to prioritize routed-operation smoke coverage.",
    );
  });

  it("renders Markdown for diagnostics and operator handoffs", () => {
    const markdown = renderCatalogOperatorSummaryMarkdown();

    expect(markdown).toContain("# CLI Catalog Operator Summary");
    expect(markdown).toContain("- Command routes: 94");
    expect(markdown).toContain("- Test-matrix coverage gaps: 14");
    expect(markdown).toContain("- Confirmation required: `gateway`, `skill_workshop`");
    expect(markdown).toContain("- Route policy keys:");
  });
});
