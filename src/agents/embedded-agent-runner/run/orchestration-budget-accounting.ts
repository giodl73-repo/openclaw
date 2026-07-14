import {
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

/** Charges one completed embedded attempt to its inherited shared budget owner. */
export async function chargeOrchestrationBudgetUsage(
  params: ChargeOrchestrationBudgetUsageParams,
): Promise<OrchestrationBudgetCharge | undefined> {
  const budget = params.explicitSkillInvocation?.orchestrationBudget;
  if (!budget) {
    return;
  }
  const tokens = resolveNormalizedUsageTokenTotal(params.usage);
  if (tokens === undefined) {
    return;
  }
  return await chargeSessionOrchestrationBudget({
    ownerSessionKey: budget.ownerSessionKey,
    rootRunId: budget.rootRunId,
    config: params.config,
    tokens,
  });
}
