// Builds the stable JSON payload for `openclaw status --json`.
// Optional deep fields are included only when their upstream probes actually ran.

import { getCurrentHostIntegrationBundleStatusSnapshotV1 } from "../hosting/host-integration-bundle.js";
import {
  buildHostIntegrationStatusInventoryV1,
  getCurrentHostIntegrationOwnerEvidenceV1,
} from "../hosting/host-integration-status.js";
import { resolveStatusUpdateChannelInfo } from "./status-all/format.js";
import {
  buildStatusGatewayJsonPayloadFromSurface,
  type StatusOverviewSurface,
} from "./status-overview-surface.ts";

/** Combines scan summary, overview surface, services, agents, diagnostics, and optional deep probes. */
export function buildStatusJsonPayload(params: {
  summary: Record<string, unknown>;
  surface: StatusOverviewSurface;
  osSummary: unknown;
  memory: unknown;
  memoryPlugin: unknown;
  agents: unknown;
  secretDiagnostics: string[];
  securityAudit?: unknown;
  health?: unknown;
  usage?: unknown;
  lastHeartbeat?: unknown;
  pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
}) {
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: params.surface.cfg.update?.channel ?? undefined,
    update: params.surface.update,
  });
  const hostIntegrationBundle = getCurrentHostIntegrationBundleStatusSnapshotV1();
  return {
    ...params.summary,
    os: params.osSummary,
    update: params.surface.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    gateway: buildStatusGatewayJsonPayloadFromSurface({ surface: params.surface }),
    gatewayService: params.surface.gatewayService,
    nodeService: params.surface.nodeService,
    agents: params.agents,
    secretDiagnostics: params.secretDiagnostics,
    ...(hostIntegrationBundle
      ? {
          hostIntegration: buildHostIntegrationStatusInventoryV1({
            bundle: hostIntegrationBundle,
            ownerEvidence: getCurrentHostIntegrationOwnerEvidenceV1(),
          }),
        }
      : {}),
    ...(params.securityAudit ? { securityAudit: params.securityAudit } : {}),
    ...(params.pluginCompatibility
      ? {
          // Keep warnings grouped with a count so consumers can test compatibility status cheaply.
          pluginCompatibility: {
            count: params.pluginCompatibility.length,
            warnings: params.pluginCompatibility,
          },
        }
      : {}),
    ...(params.health || params.usage || params.lastHeartbeat
      ? {
          // Deep/usage fields stay absent in fast mode instead of appearing as null placeholders.
          health: params.health,
          usage: params.usage,
          lastHeartbeat: params.lastHeartbeat,
        }
      : {}),
  };
}
