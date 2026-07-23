import type { CliCatalogList } from "./list.js";

export type CommandPolicyEvidenceRecord = {
  readonly id: string;
  readonly kind: "descriptor" | "route" | "operation" | "runtime" | "plugin" | "node";
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly commandPath?: readonly string[];
  readonly routeId?: string;
  readonly exact?: boolean;
  readonly policyKeys?: readonly string[];
  readonly discoveryMode?: string;
  readonly metadataCompleteness?: "identifier-only" | "enriched";
  readonly effectMode?: string;
  readonly risk?: string;
  readonly confirmationRequired?: boolean;
  readonly exposureTier?: "public" | "internal";
};

export type CommandPolicyEvidence = {
  readonly schemaVersion: 1;
  readonly evidenceKind: "openclaw-command-inventory";
  readonly scope: {
    readonly runtimeCommands: CliCatalogList["cli"]["runtimeCommandScope"];
    readonly nodeCommands: CliCatalogList["cli"]["nodeCommandScope"];
    readonly collection: CliCatalogList["collection"];
    readonly nodeIds: readonly string[];
  };
  readonly observations: readonly { readonly nodeId: string; readonly observedAt: string }[];
  readonly attestation: false;
  readonly records: readonly CommandPolicyEvidenceRecord[];
};

/** Projects catalog facts for policy/compliance consumers without making a policy decision. */
export function buildCommandPolicyEvidence(list: CliCatalogList): CommandPolicyEvidence {
  const records: CommandPolicyEvidenceRecord[] = [
    ...list.cli.descriptors.map((entry) => ({
      id: `descriptor:${entry.sourceKind}:${entry.sourceId}`,
      kind: "descriptor" as const,
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      ...(entry.effectProfile?.effectMode ? { effectMode: entry.effectProfile.effectMode } : {}),
      ...(entry.effectProfile?.risk ? { risk: entry.effectProfile.risk } : {}),
      ...(entry.effectProfile?.confirmationRequired !== undefined
        ? { confirmationRequired: entry.effectProfile.confirmationRequired }
        : {}),
      ...(entry.exposureTier ? { exposureTier: entry.exposureTier } : {}),
    })),
    ...list.cli.commandRoutes.map((entry) => ({
      id: `route:${entry.commandPath.join(" ")}:exact=${entry.exact}:route=${entry.routeId ?? "none"}:policy=${entry.policyKeys.join(",")}`,
      kind: "route" as const,
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      commandPath: entry.commandPath,
      exact: entry.exact,
      policyKeys: entry.policyKeys,
      ...(entry.routeId ? { routeId: entry.routeId } : {}),
    })),
    ...list.cli.routedOperations.map((entry) => ({
      id: `operation:${entry.id}`,
      kind: "operation" as const,
      sourceKind: entry.sourceKind,
      sourceId: entry.id,
      ...(entry.effectMode ? { effectMode: entry.effectMode } : {}),
      ...(entry.risk ? { risk: entry.risk } : {}),
      ...(entry.confirmationRequired !== undefined
        ? { confirmationRequired: entry.confirmationRequired }
        : {}),
    })),
    ...list.cli.runtimeCommands.map((entry) => ({
      id: `runtime:${entry.commandPath.join(" ")}`,
      kind: "runtime" as const,
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      commandPath: entry.commandPath,
      discoveryMode: entry.discoveryMode,
    })),
    ...list.cli.pluginCommands.map((entry) => ({
      id: `plugin:${entry.pluginId}:${entry.commandPath.join(" ")}`,
      kind: "plugin" as const,
      sourceKind: entry.sourceKind,
      sourceId: `${entry.pluginId}:${entry.commandPath.join(" ")}`,
      ...(entry.effectMode ? { effectMode: entry.effectMode } : {}),
      ...(entry.risk ? { risk: entry.risk } : {}),
      ...(entry.confirmationRequired !== undefined
        ? { confirmationRequired: entry.confirmationRequired }
        : {}),
      discoveryMode: entry.discoveryMode,
    })),
    ...list.cli.nodeCommands.map((entry) => ({
      id: `node:${entry.nodeId ?? "any"}:${entry.command}`,
      kind: "node" as const,
      sourceKind: entry.sourceKind,
      sourceId: `${entry.nodeId ?? "any"}:${entry.command}`,
      ...(entry.effectMode ? { effectMode: entry.effectMode } : {}),
      ...(entry.risk ? { risk: entry.risk } : {}),
      ...(entry.confirmationRequired !== undefined
        ? { confirmationRequired: entry.confirmationRequired }
        : {}),
      discoveryMode: entry.discoveryMode,
      ...(entry.metadataCompleteness ? { metadataCompleteness: entry.metadataCompleteness } : {}),
    })),
  ];
  return {
    schemaVersion: 1,
    evidenceKind: "openclaw-command-inventory",
    scope: {
      runtimeCommands: list.cli.runtimeCommandScope,
      nodeCommands: list.cli.nodeCommandScope,
      collection: list.collection,
      nodeIds: [
        ...new Set(list.cli.nodeCommands.flatMap((entry) => (entry.nodeId ? [entry.nodeId] : []))),
      ].toSorted(),
    },
    observations: list.cli.nodeCommands
      .flatMap((entry) =>
        entry.nodeId && entry.observedAtMs !== undefined
          ? [{ nodeId: entry.nodeId, observedAt: new Date(entry.observedAtMs).toISOString() }]
          : [],
      )
      .toSorted((a, b) => a.nodeId.localeCompare(b.nodeId)),
    attestation: false,
    records: records.toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}
