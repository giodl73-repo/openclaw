import type { CliCatalogEffectMode, CliCatalogRisk, CliCatalogVisibility } from "./registry.js";

export type CliCatalogNodeCommandSourceKind = "node-pairing" | "node-host-command" | "node-runtime";

export type CliCatalogNodeCommandDiscoveryMode =
  | "paired-node-declaration"
  | "node-host-registry"
  | "runtime-node-query";

export type CliCatalogNodeCommandAvailability =
  | "approved"
  | "pending-approval"
  | "available"
  | "unavailable";

export type CliCatalogNodeCommandApprovalKind =
  | "pairing"
  | "gateway-allowlist"
  | "operator-confirmation"
  | "none";

export type CliCatalogNodeCommand = {
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly nodeId?: string;
  readonly nodeName?: string;
  readonly cap?: string;
  readonly description: string;
  readonly argumentHints: readonly string[];
  readonly invocationHint: string;
  readonly availability: CliCatalogNodeCommandAvailability;
  readonly approvalKind: CliCatalogNodeCommandApprovalKind;
  readonly risk: CliCatalogRisk;
  readonly confirmationRequired: boolean;
  readonly effectMode: CliCatalogEffectMode;
  readonly effects: readonly string[];
  readonly trustBoundary: "local-node-host" | "paired-node" | "remote-node";
  readonly sourceKind: CliCatalogNodeCommandSourceKind;
  readonly sourceId: string;
  readonly discoveryMode: CliCatalogNodeCommandDiscoveryMode;
  readonly visibility: readonly CliCatalogVisibility[];
};

export function buildNodeCommandCatalog(
  commands: readonly CliCatalogNodeCommand[] = [],
): readonly CliCatalogNodeCommand[] {
  return commands
    .filter((command) => command.id.trim() && command.command.trim())
    .map((command) => ({
      ...command,
      visibility: command.visibility.length > 0 ? command.visibility : ["audit", "operator"],
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
