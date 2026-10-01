import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

export function clawsAvailable(snapshot: ApplicationGatewaySnapshot | null | undefined): boolean {
  return Boolean(
    snapshot &&
    ["claws.status", "claws.doctor"].every(
      (method) => isGatewayMethodAdvertised(snapshot, method) === true,
    ),
  );
}

export function canReadClaws(snapshot: ApplicationGatewaySnapshot | null | undefined): boolean {
  return ["claws.status", "claws.doctor"].every((method) =>
    canCallGatewayMethod(snapshot, method, "operator.read"),
  );
}
