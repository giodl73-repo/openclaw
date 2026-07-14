import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionEntry, patchSessionEntry } from "./session-accessor.js";
import type { SessionOrchestrationBudget } from "./types.js";

type OrchestrationBudgetScope = {
  ownerSessionKey: string;
  config?: OpenClawConfig;
  storePath?: string;
};

export type OrchestrationBudgetCharge = {
  budget: SessionOrchestrationBudget;
  chargedTokens: number;
  exhausted: boolean;
};

function resolveBudgetStorePath(scope: OrchestrationBudgetScope): string {
  if (scope.storePath) {
    return scope.storePath;
  }
  const agentId = normalizeAgentId(parseAgentSessionKey(scope.ownerSessionKey)?.agentId);
  return resolveStorePath(scope.config?.session?.store, { agentId });
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/** Creates the sole budget owner on an already-created root child session. */
export async function createSessionOrchestrationBudget(
  scope: OrchestrationBudgetScope & { rootRunId: string; tokenLimit: number; now?: number },
): Promise<SessionOrchestrationBudget> {
  const rootRunId = scope.rootRunId.trim();
  if (!rootRunId) {
    throw new Error("root run id required");
  }
  const tokenLimit = requirePositiveInteger(scope.tokenLimit, "token limit");
  const now = scope.now ?? Date.now();
  let created: SessionOrchestrationBudget | undefined;
  const entry = await patchSessionEntry(
    {
      sessionKey: scope.ownerSessionKey,
      storePath: resolveBudgetStorePath(scope),
    },
    (current) => {
      if (current.orchestrationBudget) {
        throw new Error("orchestration budget already exists");
      }
      created = {
        schemaVersion: 1,
        rootRunId,
        tokenLimit,
        tokensUsed: 0,
        createdAt: now,
        updatedAt: now,
      };
      return { orchestrationBudget: created };
    },
  );
  if (!entry || !created) {
    throw new Error("budget owner session not found");
  }
  return { ...created };
}

/** Reads the current shared budget without mutating its accounting state. */
export function getSessionOrchestrationBudget(
  scope: OrchestrationBudgetScope,
): SessionOrchestrationBudget | undefined {
  const budget = loadSessionEntry({
    sessionKey: scope.ownerSessionKey,
    storePath: resolveBudgetStorePath(scope),
  })?.orchestrationBudget;
  return budget ? { ...budget } : undefined;
}

/** Atomically charges normalized observed usage to the root session's shared counter. */
export async function chargeSessionOrchestrationBudget(
  scope: OrchestrationBudgetScope & { rootRunId: string; tokens: number; now?: number },
): Promise<OrchestrationBudgetCharge> {
  const rootRunId = scope.rootRunId.trim();
  if (!rootRunId) {
    throw new Error("root run id required");
  }
  const chargedTokens = requirePositiveInteger(scope.tokens, "token charge");
  const now = scope.now ?? Date.now();
  let charged: SessionOrchestrationBudget | undefined;
  const entry = await patchSessionEntry(
    {
      sessionKey: scope.ownerSessionKey,
      storePath: resolveBudgetStorePath(scope),
    },
    (current) => {
      const budget = current.orchestrationBudget;
      if (!budget) {
        throw new Error("orchestration budget not found");
      }
      if (budget.rootRunId !== rootRunId) {
        throw new Error("orchestration budget root run mismatch");
      }
      const tokensUsed = budget.tokensUsed + chargedTokens;
      if (!Number.isSafeInteger(tokensUsed)) {
        throw new Error("orchestration budget token count exceeds safe integer range");
      }
      charged = {
        ...budget,
        tokensUsed,
        updatedAt: now,
        ...(tokensUsed >= budget.tokenLimit ? { exhaustedAt: budget.exhaustedAt ?? now } : {}),
      };
      return { orchestrationBudget: charged };
    },
  );
  if (!entry || !charged) {
    throw new Error("budget owner session not found");
  }
  return {
    budget: { ...charged },
    chargedTokens,
    exhausted: charged.tokensUsed >= charged.tokenLimit,
  };
}
