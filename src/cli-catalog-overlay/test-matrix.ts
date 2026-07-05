import {
  buildCatalogList,
  type CliCatalogList,
  type CliCatalogListRoutedOperation,
} from "./list.js";

export type CliCatalogTestCoverageEvidence = {
  readonly routeId: string;
  readonly testPath: string;
  readonly testName: string;
};

export type CliCatalogTestMatrixCandidate = {
  readonly routeId: string;
  readonly commandPaths: readonly (readonly string[])[];
  readonly smokeCommands: readonly string[];
  readonly recommendedTestName: string;
  readonly coverageEvidence: readonly CliCatalogTestCoverageEvidence[];
};

export type CliCatalogTestMatrix = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-test-matrix";
  readonly counts: {
    readonly routedOperations: number;
    readonly smokeCandidates: number;
    readonly coveredRoutedOperations: number;
    readonly coverageGaps: number;
  };
  readonly candidates: readonly CliCatalogTestMatrixCandidate[];
  readonly coverageGaps: readonly CliCatalogTestMatrixCandidate[];
};

function commandPathLabel(path: readonly string[]): string {
  return path.join(" ");
}

function markdownCommand(value: string): string {
  return "`" + value + "`";
}

function recommendedTestName(operation: CliCatalogListRoutedOperation): string {
  return `catalog routed operation: ${operation.id}`;
}

function groupCoverageByRouteId(
  coverageEvidence: readonly CliCatalogTestCoverageEvidence[],
): ReadonlyMap<string, readonly CliCatalogTestCoverageEvidence[]> {
  const byRouteId = new Map<string, CliCatalogTestCoverageEvidence[]>();
  for (const evidence of coverageEvidence) {
    const routeId = evidence.routeId.trim();
    if (!routeId) {
      continue;
    }
    const entries = byRouteId.get(routeId) ?? [];
    entries.push(evidence);
    byRouteId.set(routeId, entries);
  }
  return new Map(
    [...byRouteId.entries()].map(([routeId, entries]) => [
      routeId,
      entries.toSorted((left, right) =>
        `${left.testPath}\0${left.testName}`.localeCompare(`${right.testPath}\0${right.testName}`),
      ),
    ]),
  );
}

export function buildCatalogTestMatrix(
  params: {
    readonly list?: CliCatalogList;
    readonly coverageEvidence?: readonly CliCatalogTestCoverageEvidence[];
  } = {},
): CliCatalogTestMatrix {
  const list = params.list ?? buildCatalogList();
  const coverageByRouteId = groupCoverageByRouteId(params.coverageEvidence ?? []);
  const candidates = list.cli.routedOperations.map((operation) => {
    const smokeCommands = operation.commandPaths.map(commandPathLabel);
    return {
      routeId: operation.id,
      commandPaths: operation.commandPaths,
      smokeCommands,
      recommendedTestName: recommendedTestName(operation),
      coverageEvidence: coverageByRouteId.get(operation.id) ?? [],
    };
  });
  const coverageGaps = candidates.filter((candidate) => candidate.coverageEvidence.length === 0);

  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-test-matrix",
    counts: {
      routedOperations: list.cli.routedOperations.length,
      smokeCandidates: candidates.length,
      coveredRoutedOperations: candidates.length - coverageGaps.length,
      coverageGaps: coverageGaps.length,
    },
    candidates,
    coverageGaps,
  };
}

export function renderCatalogTestMatrixMarkdown(): string {
  const matrix = buildCatalogTestMatrix();
  const lines = [
    "# CLI Catalog Overlay Test Matrix",
    "",
    "Read-only routed-operation smoke-test candidates derived from the catalog. Coverage gaps are explicit until a test supplies coverage evidence for a route ID.",
    "",
    "## Counts",
    "",
    `- Routed operations: ${matrix.counts.routedOperations}`,
    `- Smoke candidates: ${matrix.counts.smokeCandidates}`,
    `- Covered routed operations: ${matrix.counts.coveredRoutedOperations}`,
    `- Coverage gaps: ${matrix.counts.coverageGaps}`,
    "",
    "## Candidates",
    "",
    "| Route ID | Smoke commands | Recommended test name | Coverage |",
    "| --- | --- | --- | --- |",
  ];
  for (const candidate of matrix.candidates) {
    const coverage =
      candidate.coverageEvidence.length > 0
        ? candidate.coverageEvidence
            .map((evidence) => `${evidence.testPath} (${evidence.testName})`)
            .join("; ")
        : "Gap";
    lines.push(
      `| \`${candidate.routeId}\` | ${candidate.smokeCommands.map(markdownCommand).join(", ")} | ${candidate.recommendedTestName} | ${coverage} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
