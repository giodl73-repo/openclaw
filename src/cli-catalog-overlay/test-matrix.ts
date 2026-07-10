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
  readonly commandPathLabels: readonly string[];
  readonly recommendedTestName: string;
  readonly coverageEvidence: readonly CliCatalogTestCoverageEvidence[];
};

export type CliCatalogNodeCommandTestCandidate = {
  readonly commandId: string;
  readonly command: string;
  readonly invocationHint: string;
  readonly recommendedTestName: string;
  readonly approvalKind: string;
  readonly availability: string;
};

export type CliCatalogTestMatrix = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-test-matrix";
  readonly counts: {
    readonly routedOperations: number;
    readonly nodeCommands: number;
    readonly testCandidates: number;
    readonly nodeCommandTestCandidates: number;
    readonly evidencedRoutedOperations: number;
  };
  readonly candidates: readonly CliCatalogTestMatrixCandidate[];
  readonly nodeCommandCandidates: readonly CliCatalogNodeCommandTestCandidate[];
};

function commandPathLabel(path: readonly string[]): string {
  return path.join(" ");
}

function markdownTableCell(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").replace(/\|/g, "\\|");
}

function markdownCommand(value: string): string {
  const cell = markdownTableCell(value);
  const longestFence = Math.max(0, ...Array.from(cell.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return longestFence > 0 ? `${fence} ${cell} ${fence}` : `${fence}${cell}${fence}`;
}

function recommendedTestName(operation: CliCatalogListRoutedOperation): string {
  return `catalog routed operation: ${operation.id}`;
}

function recommendedNodeCommandTestName(commandId: string): string {
  return `catalog node command: ${commandId}`;
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
    return {
      routeId: operation.id,
      commandPaths: operation.commandPaths,
      commandPathLabels: operation.commandPaths.map(commandPathLabel),
      recommendedTestName: recommendedTestName(operation),
      coverageEvidence: coverageByRouteId.get(operation.id) ?? [],
    };
  });
  const nodeCommandCandidates = list.cli.nodeCommands.map((command) => ({
    commandId: command.id,
    command: command.command,
    invocationHint: command.invocationHint,
    recommendedTestName: recommendedNodeCommandTestName(command.id),
    approvalKind: command.approvalKind,
    availability: command.availability,
  }));

  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-test-matrix",
    counts: {
      routedOperations: list.cli.routedOperations.length,
      nodeCommands: list.cli.nodeCommands.length,
      testCandidates: candidates.length,
      nodeCommandTestCandidates: nodeCommandCandidates.length,
      evidencedRoutedOperations: candidates.filter(
        (candidate) => candidate.coverageEvidence.length > 0,
      ).length,
    },
    candidates,
    nodeCommandCandidates,
  };
}

export function renderCatalogTestMatrixMarkdown(
  matrix: CliCatalogTestMatrix = buildCatalogTestMatrix(),
): string {
  const lines = [
    "# CLI Catalog Overlay Test Matrix",
    "",
    "Read-only test-plan candidates derived from catalog command paths. Paths identify routes; they are not executable probes.",
    "",
    "## Counts",
    "",
    `- Routed operations: ${matrix.counts.routedOperations}`,
    `- Node/operator commands: ${matrix.counts.nodeCommands}`,
    `- Test candidates: ${matrix.counts.testCandidates}`,
    `- Node/operator test candidates: ${matrix.counts.nodeCommandTestCandidates}`,
    `- Routed operations with supplied evidence: ${matrix.counts.evidencedRoutedOperations}`,
    "",
    "## Candidates",
    "",
    "| Route ID | Command paths | Recommended test name | Supplied evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const candidate of matrix.candidates) {
    const coverage =
      candidate.coverageEvidence.length > 0
        ? candidate.coverageEvidence
            .map((evidence) => `${evidence.testPath} (${evidence.testName})`)
            .join("; ")
        : "Not supplied";
    lines.push(
      `| \`${candidate.routeId}\` | ${candidate.commandPathLabels.map(markdownCommand).join(", ")} | ${candidate.recommendedTestName} | ${markdownTableCell(coverage)} |`,
    );
  }
  if (matrix.nodeCommandCandidates.length > 0) {
    lines.push(
      "",
      "## Node/operator candidates",
      "",
      "| Command ID | Invocation hint | Approval | Availability | Recommended test name |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const candidate of matrix.nodeCommandCandidates) {
      lines.push(
        `| \`${candidate.commandId}\` | ${markdownCommand(candidate.invocationHint)} | \`${candidate.approvalKind}\` | \`${candidate.availability}\` | ${candidate.recommendedTestName} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
