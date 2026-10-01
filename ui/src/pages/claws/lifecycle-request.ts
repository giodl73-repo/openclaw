import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/schema/claws.js";

type Coordinate = { packageName: string; version: string };
export type PendingClawOperation =
  | { operation: "add"; source: Coordinate; agentId?: string }
  | { operation: "update"; source: Coordinate; target: string }
  | { operation: "remove"; target: string; removeUnused: false };

export function clawPlanParams(pending: PendingClawOperation) {
  const { operation: _operation, ...params } = pending;
  return params;
}

export function buildClawApplyRequest(
  pending: PendingClawOperation,
  plan: ClawLifecyclePlanResult,
  riskAcknowledged: boolean,
) {
  if (
    pending.operation !== plan.operation ||
    plan.blockers.length ||
    plan.actions.some((action) => action.blocked) ||
    (plan.riskAcknowledgementRequired && !riskAcknowledged)
  ) {
    return null;
  }
  return {
    method: `claws.${pending.operation}.apply`,
    params: {
      ...clawPlanParams(pending),
      planIntegrity: plan.planIntegrity,
      ...(pending.operation !== "remove" && riskAcknowledged
        ? { acknowledgeClawHubRisk: true }
        : {}),
    },
  };
}
