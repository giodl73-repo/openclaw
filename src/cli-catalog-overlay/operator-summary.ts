import { buildCatalogAudit, type CliCatalogAudit } from "./audit.js";
import { buildCatalogList, type CliCatalogList } from "./list.js";
import { buildCatalogTestMatrix, type CliCatalogTestMatrix } from "./test-matrix.js";

export type CliCatalogOperatorSummary = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-operator-summary";
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly agentToolSurfaces: number;
    readonly confirmationRequiredSurfaces: number;
    readonly routePolicyKeys: number;
    readonly coverageGaps: number;
  };
  readonly attention: {
    readonly confirmationRequiredSurfaceIds: readonly string[];
    readonly mediumRiskSurfaceIds: readonly string[];
    readonly mixedEffectSurfaceIds: readonly string[];
    readonly policyKeyIds: readonly string[];
  };
  readonly nextChecks: readonly string[];
};

function groupIds(
  groups: readonly {
    readonly id: string;
    readonly surfaceIds: readonly string[];
  }[],
  id: string,
): readonly string[] {
  return groups.find((group) => group.id === id)?.surfaceIds ?? [];
}

export function buildCatalogOperatorSummary(
  params: {
    readonly list?: CliCatalogList;
    readonly audit?: CliCatalogAudit;
    readonly testMatrix?: CliCatalogTestMatrix;
  } = {},
): CliCatalogOperatorSummary {
  const list = params.list ?? buildCatalogList();
  const audit = params.audit ?? buildCatalogAudit(list);
  const testMatrix = params.testMatrix ?? buildCatalogTestMatrix({ list });
  const policyKeyIds = audit.commandRoutes.byPolicyKey.map((group) => group.policyKey).toSorted();
  const confirmationRequiredSurfaceIds = audit.surfaces.confirmationRequiredSurfaceIds;
  const coverageGaps = testMatrix.counts.coverageGaps;

  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-operator-summary",
    counts: {
      commandDescriptors: list.counts.commandDescriptors,
      commandRoutes: list.counts.commandRoutes,
      routedOperations: list.counts.routedOperations,
      agentToolSurfaces: list.counts.agentToolSurfaces,
      confirmationRequiredSurfaces: audit.counts.confirmationRequiredSurfaces,
      routePolicyKeys: audit.counts.routePolicyKeys,
      coverageGaps,
    },
    attention: {
      confirmationRequiredSurfaceIds,
      mediumRiskSurfaceIds: groupIds(audit.surfaces.byRisk, "medium"),
      mixedEffectSurfaceIds: groupIds(audit.surfaces.byEffectMode, "mixed"),
      policyKeyIds,
    },
    nextChecks: [
      confirmationRequiredSurfaceIds.length > 0
        ? "Review confirmation-required catalog surfaces before widening automation."
        : "",
      policyKeyIds.includes("networkProxy")
        ? "Review command routes with networkProxy policy before changing proxy startup behavior."
        : "",
      coverageGaps > 0
        ? "Use catalog test-matrix output to prioritize routed-operation smoke coverage."
        : "",
    ].filter(Boolean),
  };
}

function inlineCodeList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => "`" + value + "`").join(", ") : "None";
}

export function renderCatalogOperatorSummaryMarkdown(): string {
  const summary = buildCatalogOperatorSummary();
  return [
    "# CLI Catalog Operator Summary",
    "",
    "Compact read-only summary for diagnostics, operator review, and admin handoffs.",
    "",
    "## Counts",
    "",
    `- CLI descriptors: ${summary.counts.commandDescriptors}`,
    `- Command routes: ${summary.counts.commandRoutes}`,
    `- Routed operations: ${summary.counts.routedOperations}`,
    `- Agent/tool surfaces: ${summary.counts.agentToolSurfaces}`,
    `- Confirmation-required surfaces: ${summary.counts.confirmationRequiredSurfaces}`,
    `- Route policy keys: ${summary.counts.routePolicyKeys}`,
    `- Test-matrix coverage gaps: ${summary.counts.coverageGaps}`,
    "",
    "## Attention",
    "",
    `- Confirmation required: ${inlineCodeList(summary.attention.confirmationRequiredSurfaceIds)}`,
    `- Medium risk: ${inlineCodeList(summary.attention.mediumRiskSurfaceIds)}`,
    `- Mixed effect mode: ${inlineCodeList(summary.attention.mixedEffectSurfaceIds)}`,
    `- Route policy keys: ${inlineCodeList(summary.attention.policyKeyIds)}`,
    "",
    "## Next checks",
    "",
    ...summary.nextChecks.map((check) => `- ${check}`),
    "",
  ].join("\n");
}
