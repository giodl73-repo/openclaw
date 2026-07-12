import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const hostProviderHandlers: GatewayRequestHandlers = {
  "host.provider.frame": ({ params, client, context, respond }) => {
    if (!client?.connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "client is not connected"));
      return;
    }
    if (!context.hostProviderRegistry) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "host provider registry is unavailable"),
      );
      return;
    }
    try {
      context.hostProviderRegistry.receiveFrame(client.connId, params);
      respond(true, { accepted: true });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "host provider frame is invalid",
        ),
      );
    }
  },
};
