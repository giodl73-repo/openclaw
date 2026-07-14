import {
  assertSessionOrchestrationBudgetAvailable,
  chargeSessionOrchestrationBudget,
  type OrchestrationBudgetCharge,
} from "../../../config/sessions/orchestration-budgets.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ExplicitSkillInvocation } from "../../../skills/types.js";
import type { NormalizedUsage } from "../../usage.js";
import { resolveNormalizedUsageTokenTotal } from "../usage-accumulator.js";

type ChargeOrchestrationBudgetUsageParams = {
  config?: OpenClawConfig;
  explicitSkillInvocation?: ExplicitSkillInvocation;
  usage?: NormalizedUsage;
};

/** Checks the durable root counter before another model action is dispatched. */
export function assertOrchestrationBudgetAvailable(
  params: Omit<ChargeOrchestrationBudgetUsageParams, "usage">,
): void {
  const budget = params.explicitSkillInvocation?.orchestrationBudget;
  if (!budget) {
    return;
  }
  assertSessionOrchestrationBudgetAvailable({
    ownerSessionKey: budget.ownerSessionKey,
    rootRunId: budget.rootRunId,
    config: params.config,
  });
}

/** Charges one completed embedded attempt to its inherited shared budget owner. */
export async function chargeOrchestrationBudgetUsage(
  params: ChargeOrchestrationBudgetUsageParams,
): Promise<OrchestrationBudgetCharge | undefined> {
  const budget = params.explicitSkillInvocation?.orchestrationBudget;
  if (!budget) {
    return undefined;
  }
  const tokens = resolveNormalizedUsageTokenTotal(params.usage);
  if (tokens === undefined) {
    return undefined;
  }
  return await chargeSessionOrchestrationBudget({
    ownerSessionKey: budget.ownerSessionKey,
    rootRunId: budget.rootRunId,
    config: params.config,
    tokens,
  });
}
