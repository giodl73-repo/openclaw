import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliCatalogNodeCommand } from "./node-commands.js";

export type LiveNodeCommandObservation = {
  readonly nodeId: string;
  readonly nodeName?: string;
  readonly observedAtMs?: number;
  readonly commands: readonly CliCatalogNodeCommand[];
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(value.map(normalizeOptionalString).filter((item) => item !== undefined)),
  ].toSorted();
}

export function buildLiveNodeCommandObservation(
  value: unknown,
  requestedNodeId: string,
): LiveNodeCommandObservation {
  const record = asRecord(value);
  const nodeId = normalizeOptionalString(record.nodeId);
  if (!nodeId || nodeId !== requestedNodeId) {
    throw new Error(`node.describe returned an unexpected node for ${requestedNodeId}`);
  }
  if (record.connected !== true) {
    throw new Error(`node ${nodeId} is not connected; live command inventory is unavailable`);
  }

  const nodeName = normalizeOptionalString(record.displayName);
  const observedAtMs =
    typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : undefined;
  const commands = stringList(record.commands).map((command): CliCatalogNodeCommand => {
    const entry: CliCatalogNodeCommand = {
      id: `node:${nodeId}:${command}`,
      command,
      title: command,
      nodeId,
      description: `Live command advertised by paired node ${nodeName ?? nodeId}.`,
      argumentHints: [],
      invocationHint: `openclaw nodes invoke --node ${nodeId} --command ${command}`,
      availability: "available",
      approvalKind: "gateway-allowlist",
      // The node handshake supplies identifiers, not semantic effects. Keep the
      // model-facing fallback conservative until command-owned metadata exists.
      risk: "high",
      confirmationRequired: true,
      effectMode: "mixed",
      effects: [],
      trustBoundary: "paired-node",
      sourceKind: "node-runtime",
      sourceId: `${nodeId}:${command}`,
      discoveryMode: "runtime-node-query",
      metadataCompleteness: "identifier-only",
      visibility: ["prompt", "audit", "operator"],
    };
    if (nodeName) {
      Object.assign(entry, { nodeName });
    }
    if (observedAtMs !== undefined) {
      Object.assign(entry, { observedAtMs });
    }
    return entry;
  });

  return {
    nodeId,
    ...(nodeName ? { nodeName } : {}),
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
    commands,
  };
}
