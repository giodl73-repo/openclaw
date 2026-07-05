import { describe, expect, it } from "vitest";
import { buildCatalogTestMatrix, renderCatalogTestMatrixMarkdown } from "./test-matrix.js";

describe("cli catalog overlay test matrix", () => {
  it("builds routed-operation smoke candidates from the catalog list", () => {
    const matrix = buildCatalogTestMatrix({
      coverageEvidence: [
        {
          routeId: "gateway-status",
          testPath: "src/cli/catalog-cli.test.ts",
          testName: "prints catalog list Markdown by default",
        },
      ],
    });

    expect(matrix).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-test-matrix",
      counts: {
        routedOperations: 14,
        smokeCandidates: 14,
        coveredRoutedOperations: 1,
        coverageGaps: 13,
      },
    });
    expect(
      matrix.candidates.find((candidate) => candidate.routeId === "gateway-status"),
    ).toMatchObject({
      smokeCommands: ["gateway status"],
      recommendedTestName: "catalog routed operation: gateway-status",
      coverageEvidence: [
        {
          testPath: "src/cli/catalog-cli.test.ts",
        },
      ],
    });
    expect(matrix.coverageGaps.map((candidate) => candidate.routeId)).not.toContain(
      "gateway-status",
    );
  });

  it("renders Markdown for operator-facing test-matrix output", () => {
    const markdown = renderCatalogTestMatrixMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Test Matrix");
    expect(markdown).toContain("- Routed operations: 14");
    expect(markdown).toContain("- Coverage gaps: 14");
    expect(markdown).toContain("| `gateway-status` | `gateway status` |");
    expect(markdown).toContain("catalog routed operation: gateway-status");
  });
});
