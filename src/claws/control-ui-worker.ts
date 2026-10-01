import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { createClawControlUiAuthority } from "./control-ui-authority.js";
import type {
  ClawControlUiCommand,
  ClawControlUiHost,
  ClawControlUiWorkerInput,
  ClawControlUiWorkerResult,
} from "./control-ui-worker-contract.js";

export async function runClawControlUiOperation(
  command: ClawControlUiCommand,
  options: { assertCurrent: () => void; request: ClawControlUiHost },
): Promise<ClawControlUiWorkerResult> {
  options.assertCurrent();
  const authority = createClawControlUiAuthority(options.assertCurrent);
  try {
    const pool = createOwnedWorkerTaskPool<ClawControlUiWorkerInput, ClawControlUiWorkerResult>({
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.clawControlUi),
      maxWorkers: 1,
    });
    try {
      // Cancellation revokes effect admission, not the worker's obligation to settle cleanup.
      const task = pool.runTask(
        { ...command, authority: authority.port },
        {
          transferList: (input) => [input.authority],
          onRequest: async (value) => {
            if (!isRecord(value) || typeof value.method !== "string" || !isRecord(value.params)) {
              throw new Error("Invalid Claw worker request.");
            }
            try {
              options.assertCurrent();
              const result = await options.request({ method: value.method, params: value.params });
              return { input: { ok: true, value: result }, timeoutMs: 30 * 60_000 };
            } catch {
              return { input: { ok: false }, timeoutMs: 30 * 60_000 };
            }
          },
        },
      );
      try {
        return await task.result;
      } finally {
        await task.close();
      }
    } finally {
      await pool.close();
    }
  } finally {
    authority.close();
  }
}
