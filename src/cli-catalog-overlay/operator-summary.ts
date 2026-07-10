import { buildCatalogAudit, type CliCatalogAudit } from "./audit.js";
import { buildCatalogList, type CliCatalogList } from "./list.js";

export type CliCatalogOperatorSummary = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-operator-summary";
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly agentToolSurfaces: number;
    readonly nodeCommands: number;
    readonly nodeCommandsRequiringApproval: number;
    readonly confirmationRequiredSurfaces: number;
    readonly routePolicyKeys: number;
  };
  readonly attention: {
    readonly confirmationRequiredSurfaceIds: readonly string[];
    readonly highRiskSurfaceIds: readonly string[];
    readonly mediumRiskSurfaceIds: readonly string[];
    readonly mixedEffectSurfaceIds: readonly string[];
    readonly nodeCommandApprovalIds: readonly string[];
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
  } = {},
): CliCatalogOperatorSummary {
  const list = params.list ?? buildCatalogList();
  const audit = params.audit ?? buildCatalogAudit(list);
  const policyKeyIds = audit.commandRoutes.byPolicyKey.map((group) => group.policyKey).toSorted();
  const confirmationRequiredSurfaceIds = audit.surfaces.confirmationRequiredSurfaceIds;
  const highRiskSurfaceIds = groupIds(audit.surfaces.byRisk, "high");

  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-operator-summary",
    counts: {
      commandDescriptors: list.counts.commandDescriptors,
      commandRoutes: list.counts.commandRoutes,
      routedOperations: list.counts.routedOperations,
      agentToolSurfaces: list.counts.agentToolSurfaces,
      nodeCommands: list.counts.nodeCommands,
      nodeCommandsRequiringApproval: audit.counts.nodeCommandsRequiringApproval,
      confirmationRequiredSurfaces: audit.counts.confirmationRequiredSurfaces,
      routePolicyKeys: audit.counts.routePolicyKeys,
    },
    attention: {
      confirmationRequiredSurfaceIds,
      highRiskSurfaceIds,
      mediumRiskSurfaceIds: groupIds(audit.surfaces.byRisk, "medium"),
      mixedEffectSurfaceIds: groupIds(audit.surfaces.byEffectMode, "mixed"),
      nodeCommandApprovalIds: audit.nodeCommands.approvalRequiredCommandIds,
      policyKeyIds,
    },
    nextChecks: [
      confirmationRequiredSurfaceIds.length > 0
        ? "Review confirmation-required catalog surfaces before widening automation."
        : "",
      highRiskSurfaceIds.length > 0
        ? "Review high-risk catalog surfaces before widening automation."
        : "",
      policyKeyIds.includes("networkProxy")
        ? "Review command routes with networkProxy policy before changing proxy startup behavior."
        : "",
      audit.nodeCommands.approvalRequiredCommandIds.length > 0
        ? "Review node/operator command approval state before exposing node-scoped prompt projections."
        : "",
    ].filter(Boolean),
  };
}

function inlineCodeList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => "`" + value + "`").join(", ") : "None";
}

export function renderCatalogOperatorSummaryMarkdown(
  params: {
    readonly list?: CliCatalogList;
    readonly audit?: CliCatalogAudit;
  } = {},
): string {
  const summary = buildCatalogOperatorSummary(params);
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
    `- Node/operator commands: ${summary.counts.nodeCommands}`,
    `- Node/operator commands requiring approval: ${summary.counts.nodeCommandsRequiringApproval}`,
    `- Confirmation-required surfaces: ${summary.counts.confirmationRequiredSurfaces}`,
    `- Route policy keys: ${summary.counts.routePolicyKeys}`,
    "",
    "## Attention",
    "",
    `- Confirmation required: ${inlineCodeList(summary.attention.confirmationRequiredSurfaceIds)}`,
    `- High risk: ${inlineCodeList(summary.attention.highRiskSurfaceIds)}`,
    `- Medium risk: ${inlineCodeList(summary.attention.mediumRiskSurfaceIds)}`,
    `- Mixed effect mode: ${inlineCodeList(summary.attention.mixedEffectSurfaceIds)}`,
    `- Node/operator approval: ${inlineCodeList(summary.attention.nodeCommandApprovalIds)}`,
    `- Route policy keys: ${inlineCodeList(summary.attention.policyKeyIds)}`,
    "",
    "## Next checks",
    "",
    ...summary.nextChecks.map((check) => `- ${check}`),
    "",
  ].join("\n");
}
