import { buildCatalogList, type CliCatalogList, type CliCatalogListSurface } from "./list.js";

export type CliCatalogAuditSurfaceGroup = {
  readonly id: string;
  readonly count: number;
  readonly surfaceIds: readonly string[];
};

export type CliCatalogAuditRoutePolicyGroup = {
  readonly policyKey: string;
  readonly count: number;
  readonly commandPaths: readonly (readonly string[])[];
};

export type CliCatalogAudit = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-audit";
  readonly counts: {
    readonly agentToolSurfaces: number;
    readonly confirmationRequiredSurfaces: number;
    readonly commandRoutes: number;
    readonly commandRoutesWithPolicyKeys: number;
    readonly routePolicyKeys: number;
  };
  readonly surfaces: {
    readonly byRisk: readonly CliCatalogAuditSurfaceGroup[];
    readonly byEffectMode: readonly CliCatalogAuditSurfaceGroup[];
    readonly byOwner: readonly CliCatalogAuditSurfaceGroup[];
    readonly confirmationRequiredSurfaceIds: readonly string[];
  };
  readonly commandRoutes: {
    readonly byPolicyKey: readonly CliCatalogAuditRoutePolicyGroup[];
    readonly routesWithoutPolicyKeys: readonly (readonly string[])[];
  };
};

function commandPathLabel(path: readonly string[]): string {
  return path.join(" ");
}

function markdownCommandPath(path: readonly string[]): string {
  return "`" + commandPathLabel(path) + "`";
}

function groupSurfacesBy(
  surfaces: readonly CliCatalogListSurface[],
  getKey: (surface: CliCatalogListSurface) => string,
): readonly CliCatalogAuditSurfaceGroup[] {
  const groups = new Map<string, string[]>();
  for (const surface of surfaces) {
    const key = getKey(surface);
    const surfaceIds = groups.get(key) ?? [];
    surfaceIds.push(surface.id);
    groups.set(key, surfaceIds);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([id, surfaceIds]) => ({
      id,
      count: surfaceIds.length,
      surfaceIds: surfaceIds.toSorted(),
    }));
}

function groupRoutesByPolicyKey(
  routes: CliCatalogList["cli"]["commandRoutes"],
): readonly CliCatalogAuditRoutePolicyGroup[] {
  const groups = new Map<string, string[][]>();
  for (const route of routes) {
    for (const policyKey of route.policyKeys) {
      const commandPaths = groups.get(policyKey) ?? [];
      commandPaths.push([...route.commandPath]);
      groups.set(policyKey, commandPaths);
    }
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([policyKey, commandPaths]) => ({
      policyKey,
      count: commandPaths.length,
      commandPaths: commandPaths.toSorted((left, right) =>
        commandPathLabel(left).localeCompare(commandPathLabel(right)),
      ),
    }));
}

export function buildCatalogAudit(list = buildCatalogList()): CliCatalogAudit {
  const confirmationRequiredSurfaceIds = list.agentToolSurfaces
    .filter((surface) => surface.confirmationRequired)
    .map((surface) => surface.id)
    .toSorted();
  const byPolicyKey = groupRoutesByPolicyKey(list.cli.commandRoutes);
  const routesWithoutPolicyKeys = list.cli.commandRoutes
    .filter((route) => route.policyKeys.length === 0)
    .map((route) => route.commandPath)
    .toSorted((left, right) => commandPathLabel(left).localeCompare(commandPathLabel(right)));

  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-audit",
    counts: {
      agentToolSurfaces: list.agentToolSurfaces.length,
      confirmationRequiredSurfaces: confirmationRequiredSurfaceIds.length,
      commandRoutes: list.cli.commandRoutes.length,
      commandRoutesWithPolicyKeys: list.cli.commandRoutes.length - routesWithoutPolicyKeys.length,
      routePolicyKeys: byPolicyKey.length,
    },
    surfaces: {
      byRisk: groupSurfacesBy(list.agentToolSurfaces, (surface) => surface.risk),
      byEffectMode: groupSurfacesBy(list.agentToolSurfaces, (surface) => surface.effectMode),
      byOwner: groupSurfacesBy(list.agentToolSurfaces, (surface) => surface.owner),
      confirmationRequiredSurfaceIds,
    },
    commandRoutes: {
      byPolicyKey,
      routesWithoutPolicyKeys,
    },
  };
}

export function renderCatalogAuditMarkdown(): string {
  const audit = buildCatalogAudit();
  const lines = [
    "# CLI Catalog Overlay Audit",
    "",
    "Read-only inventory grouped by risk, confirmation requirement, effect mode, owner, and command-route policy keys.",
    "",
    "## Counts",
    "",
    `- Agent/tool surfaces: ${audit.counts.agentToolSurfaces}`,
    `- Confirmation-required surfaces: ${audit.counts.confirmationRequiredSurfaces}`,
    `- Command routes: ${audit.counts.commandRoutes}`,
    `- Command routes with policy keys: ${audit.counts.commandRoutesWithPolicyKeys}`,
    `- Route policy keys: ${audit.counts.routePolicyKeys}`,
    "",
    "## Surface groups",
    "",
    "| Group | Values |",
    "| --- | --- |",
    `| Risk | ${audit.surfaces.byRisk.map((group) => `\`${group.id}\` (${group.count})`).join(", ")} |`,
    `| Effect mode | ${audit.surfaces.byEffectMode.map((group) => `\`${group.id}\` (${group.count})`).join(", ")} |`,
    `| Owner | ${audit.surfaces.byOwner.map((group) => `\`${group.id}\` (${group.count})`).join(", ")} |`,
    `| Confirmation required | ${audit.surfaces.confirmationRequiredSurfaceIds.map((id) => "`" + id + "`").join(", ") || "None"} |`,
    "",
    "## Command route policy keys",
    "",
    "| Policy key | Routes |",
    "| --- | --- |",
  ];
  for (const group of audit.commandRoutes.byPolicyKey) {
    lines.push(
      `| \`${group.policyKey}\` | ${group.commandPaths.map(markdownCommandPath).join(", ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
