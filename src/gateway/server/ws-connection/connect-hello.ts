// Gateway WebSocket connect completion sends hello-ok and commits post-handshake state.
import {
  GATEWAY_SERVER_CAPS,
  PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  redeemDeviceBootstrapTokenProfile,
  revokeDeviceBootstrapToken,
  restoreDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import { finalizeNodePairingCleanupClaim } from "../../../infra/node-pairing.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import { listControlUiPluginTabs } from "../../control-ui-plugin-tabs.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";
import { scheduleNodeConnectionNotification } from "../../node-connection-notifications.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { buildGatewaySnapshot, getHealthCache, getHealthVersion } from "../health-state.js";
import { emitGatewayAuthSecurityEvent } from "./connect-auth-security.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

export async function sendGatewayHello(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
  pluginSurfaceUrls: Record<string, string>,
  onHelloSent?: () => void,
): Promise<void> {
  const {
    connId,
    nodeReapprovalCoordinator,
    gatewayMethods,
    events,
    buildRequestContext,
    refreshHealthSnapshot,
    close,
    advanceHandshakePhase,
    setCloseCause,
    logGateway,
    logHealth,
  } = context.handler;
  const {
    frame,
    connectParams,
    sendFrame,
    pendingNodePairingCleanup,
    releasePendingNodePairingCleanup,
  } = context;
  const {
    resolvedAuth,
    role,
    scopes,
    device,
    hasTokenAuth,
    hasPasswordAuth,
    bootstrapTokenCandidate,
    authMethod,
    issuedBootstrapProfile,
    handoffBootstrapProfile,
    deviceToken,
    bootstrapDeviceTokens,
    trustedHostProviderAdmission,
  } = state;
  const snapshot =
    role === "host-provider"
      ? {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: Math.round(process.uptime() * 1000),
        }
      : buildGatewaySnapshot({
          includeSensitive: scopes.includes(ADMIN_SCOPE),
        });
  if (role !== "host-provider") {
    const cachedHealth = getHealthCache();
    if (cachedHealth) {
      snapshot.health = cachedHealth;
      snapshot.stateVersion.health = getHealthVersion();
    }
  }
  const helloOkAuthScopes = deviceToken ? deviceToken.scopes : scopes;
  const controlUiTabs = role === "host-provider" ? [] : listControlUiPluginTabs(helloOkAuthScopes);
  const helloOk = {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: {
      version: resolveRuntimeServiceVersion(process.env),
      connId,
    },
    features: {
      methods: role === "host-provider" ? ["host.provider.frame"] : gatewayMethods,
      events: role === "host-provider" ? [] : events,
      capabilities:
        role === "host-provider"
          ? []
          : [
              GATEWAY_SERVER_CAPS.CHAT_SEND_ROUTING_CONTRACT,
              GATEWAY_SERVER_CAPS.CRESTODIAN_SETUP_MODEL_REF,
            ],
    },
    snapshot,
    ...(controlUiTabs.length > 0 ? { controlUiTabs } : {}),
    ...(role !== "host-provider" && Object.keys(pluginSurfaceUrls).length > 0
      ? { pluginSurfaceUrls }
      : {}),
    auth: {
      role,
      scopes: helloOkAuthScopes,
      ...(deviceToken
        ? {
            deviceToken: deviceToken.token,
            issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
            ...(bootstrapDeviceTokens.length > 1
              ? { deviceTokens: bootstrapDeviceTokens.slice(1) }
              : {}),
          }
        : {}),
    },
    policy: {
      maxPayload: MAX_PAYLOAD_BYTES,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      tickIntervalMs: TICK_INTERVAL_MS,
    },
  };
  advanceHandshakePhase("hello_payload_prepared");

  let revokedBootstrapTokenRecord:
    | Awaited<ReturnType<typeof revokeDeviceBootstrapToken>>["record"]
    | undefined;
  if (authMethod === "bootstrap-token" && bootstrapTokenCandidate && device) {
    try {
      if (handoffBootstrapProfile || issuedBootstrapProfile) {
        const redemption = await redeemDeviceBootstrapTokenProfile({
          token: bootstrapTokenCandidate,
          role,
          scopes,
        });
        if (handoffBootstrapProfile || redemption.fullyRedeemed) {
          const revoked = await revokeDeviceBootstrapToken({
            token: bootstrapTokenCandidate,
          });
          if (!revoked.removed) {
            logGateway.warn(
              `bootstrap token revoke skipped after profile redemption device=${device.id}`,
            );
          } else {
            revokedBootstrapTokenRecord = revoked.record;
          }
        }
      }
    } catch (err) {
      logGateway.warn(
        `bootstrap token post-connect bookkeeping failed device=${device.id}: ${formatForLog(err)}`,
      );
    }
  }
  try {
    await sendFrame({ type: "res", id: frame.id, ok: true, payload: helloOk });
  } catch (err) {
    if (revokedBootstrapTokenRecord) {
      try {
        await restoreDeviceBootstrapToken({ record: revokedBootstrapTokenRecord });
      } catch (restoreErr) {
        logGateway.warn(
          `bootstrap token restore after hello-send failure failed device=${device?.id ?? "unknown"}: ${formatForLog(restoreErr)}`,
        );
      }
    }
    await releasePendingNodePairingCleanup();
    setCloseCause("hello-send-failed", { error: formatForLog(err) });
    close();
    return;
  }
  try {
    onHelloSent?.();
  } catch (err) {
    await releasePendingNodePairingCleanup();
    setCloseCause("hello-activation-failed", { error: formatForLog(err) });
    close(1008, "session activation failed");
    return;
  }
  let authProvided = authMethod;
  if (authMethod !== "device-token" && authMethod !== "bootstrap-token") {
    if (hasPasswordAuth) {
      authProvided = "password";
    } else if (hasTokenAuth) {
      authProvided = "token";
    }
  }
  emitGatewayAuthSecurityEvent({
    action: "gateway.auth.succeeded",
    outcome: "success",
    severity: "low",
    authMode: trustedHostProviderAdmission ? "host-provider-token" : resolvedAuth.mode,
    authMethod: trustedHostProviderAdmission ? "host-provider-token" : authMethod,
    authProvided: trustedHostProviderAdmission ? "host-provider-token" : authProvided,
    role,
    scopes: helloOkAuthScopes,
    clientMode: connectParams.client.mode,
    deviceId: device?.id,
  });
  advanceHandshakePhase("ready");
  if (role === "node") {
    const requestContext = buildRequestContext();
    const nodeId = connectParams.device?.id ?? connectParams.client.id;
    const nodeSession = requestContext.nodeRegistry.get(nodeId);
    // Only a current session that received hello-ok counts as connected;
    // failed or replaced handshakes must not alert or consume cooldown.
    if (nodeSession?.connId === connId) {
      scheduleNodeConnectionNotification(requestContext.nodeRegistry, nodeSession);
    }
  }
  if (pendingNodePairingCleanup.value) {
    const requestContext = buildRequestContext();
    const cleanupClaim = pendingNodePairingCleanup.value;
    pendingNodePairingCleanup.value = undefined;
    try {
      const resolvedPairings = nodeReapprovalCoordinator
        ? await nodeReapprovalCoordinator.finalizeCleanup(cleanupClaim)
        : await finalizeNodePairingCleanupClaim(cleanupClaim);
      const resolvedAt = Date.now();
      for (const resolved of resolvedPairings) {
        requestContext.broadcast(
          "node.pair.resolved",
          {
            requestId: resolved.requestId,
            nodeId: resolved.nodeId,
            decision: "rejected",
            ts: resolvedAt,
          },
          { dropIfSlow: true },
        );
      }
    } catch (error) {
      logGateway.warn(
        `failed to clear stale pending pairings for ${cleanupClaim.nodeId}: ${formatForLog(error)}`,
      );
    }
  }
  logWs("out", "hello-ok", {
    connId,
    methods: gatewayMethods.length,
    events: events.length,
    presence: snapshot.presence.length,
    stateVersion: snapshot.stateVersion.presence,
  });
  // Post-connect refresh only needs a cached/config snapshot for UI state;
  // live channel probes here pulled slow Discord/Telegram HTTP checks into
  // reply-adjacent websocket handshakes.
  void refreshHealthSnapshot({ probe: false }).catch((err: unknown) =>
    logHealth.error(`post-connect health refresh failed: ${formatError(err)}`),
  );
}
