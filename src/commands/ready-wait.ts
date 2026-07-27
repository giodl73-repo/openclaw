import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage } from "../infra/errors.js";

export type ReadyWaitError = {
  reason: "GatewayReadinessUnavailable";
  message: string;
};

export type ReadyWaitOutcome<T> =
  | { state: "ready"; result: T }
  | { state: "timed-out"; result?: T; error?: ReadyWaitError };

/** Poll sequentially under one total deadline without evaluating readiness locally. */
export async function waitForReady<T extends { ready: boolean }>(params: {
  waitMs: number;
  intervalMs: number;
  callTimeoutMs?: number;
  callReady: (params: { timeoutMs?: number; signal?: AbortSignal }) => Promise<T>;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
}): Promise<ReadyWaitOutcome<T>> {
  const controller = new AbortController();
  const waitMs = resolveTimerTimeoutMs(params.waitMs, 1);
  const deadlineMs = params.now() + waitMs;
  const deadlineTimer = setTimeout(() => controller.abort(), waitMs);
  let lastResult: T | undefined;
  let lastError: ReadyWaitError | undefined;

  try {
    while (!controller.signal.aborted && params.now() < deadlineMs) {
      const remainingMs = deadlineMs - params.now();
      try {
        lastResult = await params.callReady({
          timeoutMs: Math.max(1, Math.min(params.callTimeoutMs ?? remainingMs, remainingMs)),
          signal: controller.signal,
        });
        lastError = undefined;
        if (lastResult.ready) {
          return { state: "ready", result: lastResult };
        }
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }
        lastError = {
          reason: "GatewayReadinessUnavailable",
          message: formatErrorMessage(error),
        };
      }

      const delayMs = Math.min(params.intervalMs, deadlineMs - params.now());
      if (delayMs > 0) {
        await params.delay(delayMs, controller.signal);
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  return { state: "timed-out", result: lastResult, error: lastError };
}
