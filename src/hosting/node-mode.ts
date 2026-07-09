import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listNodePairing } from "../infra/node-pairing.js";
import { loadNodeHostConfig } from "../node-host/config.js";
import type { NodeModeReadinessEvidence } from "./readiness.js";

type GatewayReadinessStatus = "responding" | "not-checked" | "unavailable";

function commandListLength(value: unknown): number {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").length : 0;
}

function formatGatewayTarget(gateway?: { host?: string; port?: number }): string | undefined {
  if (!gateway?.host) {
    return undefined;
  }
  return `${gateway.host}:${gateway.port ?? DEFAULT_GATEWAY_PORT}`;
}

function controlChannelStatusFromGateway(
  gateway: GatewayReadinessStatus,
): NonNullable<NodeModeReadinessEvidence["controlChannel"]>["status"] {
  if (gateway === "responding") {
    return "ready";
  }
  return gateway;
}

export async function resolveNodeModeReadinessEvidence(params: {
  config: OpenClawConfig;
  gateway: GatewayReadinessStatus;
  workspaceUsable: boolean;
}): Promise<NodeModeReadinessEvidence> {
  const nodeHostConfig = await loadNodeHostConfig();
  const gatewayTarget = formatGatewayTarget(nodeHostConfig?.gateway);
  const evidence: NodeModeReadinessEvidence = {
    controlChannel: {
      status: controlChannelStatusFromGateway(params.gateway),
      ...(gatewayTarget ? { target: gatewayTarget } : {}),
    },
    state: {
      workspaceUsable: params.workspaceUsable,
    },
  };

  try {
    const pairing = await listNodePairing();
    const approvedCommandCount = pairing.paired.reduce(
      (total, entry) => total + commandListLength(entry.commands),
      0,
    );
    const configuredCommandCount =
      commandListLength(params.config.gateway?.nodes?.allowCommands) +
      commandListLength(params.config.gateway?.nodes?.denyCommands);
    return {
      ...evidence,
      pairing: {
        pairedCount: pairing.paired.length,
        pendingCount: pairing.pending.length,
      },
      targets: {
        count: pairing.paired.length,
      },
      commandApproval: {
        configured: configuredCommandCount > 0 || approvedCommandCount > 0,
        approvedCommandCount,
      },
    };
  } catch (error) {
    return {
      ...evidence,
      pairing: {
        pairedCount: 0,
        pendingCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
      targets: {
        count: 0,
      },
      commandApproval: {
        configured: false,
        approvedCommandCount: 0,
      },
    };
  }
}
