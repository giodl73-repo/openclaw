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
  it("builds routed-operation test-plan candidates from the catalog list", () => {
    const matrix = buildCatalogTestMatrix({
      coverageEvidence: [
        {
          routeId: "gateway-status",
          testPath: "src/cli/catalog-cli.test.ts",
          testName: "prints catalog | list\nMarkdown by default",
        },
      ],
    });

    expect(matrix).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-test-matrix",
      counts: {
        routedOperations: 14,
        testCandidates: 14,
        evidencedRoutedOperations: 1,
      },
    });
    expect(
      matrix.candidates.find((candidate) => candidate.routeId === "gateway-status"),
    ).toMatchObject({
      commandPathLabels: ["gateway status"],
      recommendedTestName: "catalog routed operation: gateway-status",
      coverageEvidence: [
        {
          testPath: "src/cli/catalog-cli.test.ts",
        },
      ],
    });
    expect(matrix.candidates.find((candidate) => candidate.routeId === "config-get")).toMatchObject(
      {
        commandPathLabels: ["config get"],
        coverageEvidence: [],
      },
    );
  });

  it("adds node/operator test candidates from supplied node commands", () => {
    const matrix = buildCatalogTestMatrix({
      list: buildCatalogList({ nodeCommands: sampleNodeCommands }),
    });

    expect(matrix.counts.nodeCommands).toBe(1);
    expect(matrix.counts.nodeCommandTestCandidates).toBe(1);
    expect(matrix.nodeCommandCandidates[0]).toMatchObject({
      commandId: "node:demo-browser:browser.open",
      invocationHint:
        'openclaw nodes invoke --node demo-browser --command browser.open --params {"url":"..."}',
      recommendedTestName: "catalog node command: node:demo-browser:browser.open",
    });
  });

  it("renders Markdown for operator-facing test-matrix output", () => {
    const markdown = renderCatalogTestMatrixMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Test Matrix");
    expect(markdown).toContain("- Routed operations: 14");
    expect(markdown).toContain("- Node/operator commands: 0");
    expect(markdown).toContain("- Routed operations with supplied evidence: 0");
    expect(markdown).toContain("| `gateway-status` | `gateway status` |");
    expect(markdown).toContain("Not supplied");
    expect(markdown).toContain("catalog routed operation: gateway-status");
  });

  it("renders supplied coverage evidence from a prebuilt matrix", () => {
    const matrix = buildCatalogTestMatrix({
      coverageEvidence: [
        {
          routeId: "gateway-status",
          testPath: "src/cli/catalog-cli.test.ts",
          testName: "prints catalog | list\nMarkdown by default",
        },
      ],
    });
    const markdown = renderCatalogTestMatrixMarkdown(matrix);

    expect(markdown).toContain("- Routed operations with supplied evidence: 1");
    expect(markdown).toContain(
      "src/cli/catalog-cli.test.ts (prints catalog \\| list Markdown by default)",
    );
  });

  it("keeps supplied node invocation hints inside Markdown table cells", () => {
    const matrix = buildCatalogTestMatrix({
      list: buildCatalogList({
        nodeCommands: [
          {
            ...sampleNodeCommands[0]!,
            invocationHint: "openclaw nodes invoke | demo\n--params `value`",
          },
        ],
      }),
    });

    expect(renderCatalogTestMatrixMarkdown(matrix)).toContain(
      "`` openclaw nodes invoke \\| demo --params `value` ``",
    );
  });
});
