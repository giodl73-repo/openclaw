import { describe, expect, it } from "vitest";
import { buildCatalogList } from "./list.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";
import { buildCatalogTestMatrix, renderCatalogTestMatrixMarkdown } from "./test-matrix.js";

const sampleNodeCommands: readonly CliCatalogNodeCommand[] = [
  {
    id: "node:demo-browser:browser.open",
    command: "browser.open",
    title: "Open URL through node browser",
    description: "Open a URL on a paired browser-capable node.",
    argumentHints: ["url"],
    invocationHint:
      'openclaw nodes invoke --node demo-browser --command browser.open --params {"url":"..."}',
    availability: "approved",
    approvalKind: "pairing",
    risk: "medium",
    confirmationRequired: true,
    effectMode: "mutating",
    effects: ["browser.open"],
    trustBoundary: "paired-node",
    sourceKind: "node-pairing",
    sourceId: "demo-browser:browser.open",
    discoveryMode: "paired-node-declaration",
    visibility: ["audit", "operator"],
  },
];

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

  it("adds node/operator smoke candidates from supplied node commands", () => {
    const matrix = buildCatalogTestMatrix({
      list: buildCatalogList({ nodeCommands: sampleNodeCommands }),
    });

    expect(matrix.counts.nodeCommands).toBe(1);
    expect(matrix.counts.nodeCommandSmokeCandidates).toBe(1);
    expect(matrix.nodeCommandCandidates[0]).toMatchObject({
      commandId: "node:demo-browser:browser.open",
      smokeCommand:
        'openclaw nodes invoke --node demo-browser --command browser.open --params {"url":"..."}',
      recommendedTestName: "catalog node command: node:demo-browser:browser.open",
    });
  });

  it("renders Markdown for operator-facing test-matrix output", () => {
    const markdown = renderCatalogTestMatrixMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Test Matrix");
    expect(markdown).toContain("- Routed operations: 14");
    expect(markdown).toContain("- Node/operator commands: 0");
    expect(markdown).toContain("- Coverage gaps: 14");
    expect(markdown).toContain("| `gateway-status` | `gateway status` |");
    expect(markdown).toContain("catalog routed operation: gateway-status");
  });
});
