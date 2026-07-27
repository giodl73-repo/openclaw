import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { buildHostIntegrationRuntimeInventoryV1 } from "../../plugins/host-integration-runtime-inventory.js";
import type { GatewayRequestHandlers } from "./types.js";

function hasEmptyParams(params: Record<string, unknown>): boolean {
  return Object.keys(params).length === 0;
}

/** Returns the current registry-scoped host inventory without loading or activating plugins. */
export const hostIntegrationStatusHandlers: GatewayRequestHandlers = {
  "hostIntegration.status": async ({ params, respond, context }) => {
    if (!hasEmptyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "hostIntegration.status does not accept params"),
      );
      return;
    }
    const registry = context.getPluginRegistry?.();
    if (!registry) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "host integration status is unavailable"),
      );
      return;
    }
    try {
      respond(
        true,
        await buildHostIntegrationRuntimeInventoryV1({
          registry,
          config: context.getRuntimeConfig(),
        }),
        undefined,
      );
    } catch {
      // Owner checks are already bounded, but the status RPC still fails closed without
      // reflecting plugin exception text into the operator protocol.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "host integration status is unavailable"),
      );
    }
  },
};
