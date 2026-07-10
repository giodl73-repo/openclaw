import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NodeSession } from "../gateway/node-registry.js";
import { listNodePairing } from "../infra/node-pairing.js";
import type { NodeModeReadinessEvidence } from "./readiness.js";

function commandSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  );
}

export async function resolveNodeModeReadinessEvidence(params: {
  config: OpenClawConfig;
  connectedNodes: readonly NodeSession[];
}): Promise<NodeModeReadinessEvidence> {
  try {
    const pairing = await listNodePairing();
    const pairedByNodeId = new Map(pairing.paired.map((entry) => [entry.nodeId, entry]));
    const connectedPairedNodes = params.connectedNodes.filter((entry) =>
      pairedByNodeId.has(entry.nodeId),
    );
    const configuredAllowCommands = commandSet(params.config.gateway?.nodes?.allowCommands);
    const deniedCommands = commandSet(params.config.gateway?.nodes?.denyCommands);
    let executableApprovedCommandCount = 0;
    for (const node of connectedPairedNodes) {
      const approvedCommands = commandSet(pairedByNodeId.get(node.nodeId)?.commands);
      for (const command of configuredAllowCommands) {
        approvedCommands.add(command);
      }
      const liveCommands = commandSet(node.commands);
      executableApprovedCommandCount += [...approvedCommands].filter((command) =>
        liveCommands.has(command) && !deniedCommands.has(command),
      ).length;
    }
    const connectedCount = connectedPairedNodes.length;
    return {
      pairing: {
        pairedCount: pairing.paired.length,
        pendingCount: pairing.pending.length,
      },
      targets: {
        knownCount: pairing.paired.length,
        connectedCount,
      },
      commandApproval: {
        configured: executableApprovedCommandCount > 0,
        approvedCommandCount: executableApprovedCommandCount,
      },
      controlChannel: {
        connectedCount,
      },
    };
  } catch (error) {
    const connectedCount = 0;
    return {
      pairing: {
        pairedCount: 0,
        pendingCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
      targets: {
        knownCount: 0,
        connectedCount,
      },
      commandApproval: {
        configured: false,
        approvedCommandCount: 0,
      },
      controlChannel: {
        connectedCount,
      },
    };
  }
}
