import { AsyncLocalStorage } from "node:async_hooks";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const rollbackMetadata = resolveGlobalSingleton(
  Symbol.for("openclaw.clawRollbackMetadata"),
  () => new AsyncLocalStorage<{ active: boolean }>(),
);

/** Metadata may settle an owned inverse; this grants no file or scheduler mutation authority. */
export function isClawRollbackMetadata(): boolean {
  return rollbackMetadata.getStore()?.active === true;
}

type ClawRollbackStep =
  | (() => Promise<void>)
  | readonly [label: string, rollback: () => Promise<void>];

export async function collectClawRollbackFailures(
  steps: readonly ClawRollbackStep[],
): Promise<string[]> {
  const failures: string[] = [];
  // Callers own step order and partial-state policy; attempt every rollback sequentially.
  for (const step of steps) {
    const rollback = typeof step === "function" ? step : step[1];
    const scope = { active: true };
    try {
      await rollbackMetadata.run(scope, rollback);
    } catch (error) {
      const message = coerceErrorMessage(error);
      failures.push(typeof step === "function" ? message : `${step[0]}: ${message}`);
    } finally {
      scope.active = false;
    }
  }
  return failures;
}
