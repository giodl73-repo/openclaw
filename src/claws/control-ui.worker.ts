import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withCliProcessScope, withCliCommandCleanup } from "../cli/runtime-cleanup-scope.js";
import { closeCliResources, waitForPendingCliDisposers } from "../cli/runtime-cleanup.js";
import { withConfigPersistenceProvider } from "../config/io.persistence-host.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { executeClawControlUiOperation } from "./control-ui-apply.js";
import { clawControlUiCommitGuard } from "./control-ui-authority.js";
import { createClawConfigPersistenceClient } from "./control-ui-config-client.js";
import type {
  ClawControlUiWorkerInput,
  ClawControlUiWorkerResult,
} from "./control-ui-worker-contract.js";

serveWorkerTasks<ClawControlUiWorkerResult>(async (input, channel) => {
  if (
    !channel ||
    !isRecord(input) ||
    !(input.authority instanceof MessagePort) ||
    !(input.configPersistence instanceof MessagePort) ||
    !(input.configPersistenceWake instanceof SharedArrayBuffer) ||
    input.configPersistenceWake.byteLength !== 2 * Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("Claw lifecycle requires its owning Gateway.");
  }
  // This private entry receives only the validated host command, never a browser object.
  const command = input as ClawControlUiWorkerInput;
  const configPersistence = createClawConfigPersistenceClient(
    command.configPersistence,
    command.configPersistenceWake,
  );
  channel.consumeInput();
  try {
    return await withConfigPersistenceProvider(configPersistence.provider, () =>
      withCliProcessScope(() =>
        withCliCommandCleanup(false, async (cleanup) => {
          try {
            return await executeClawControlUiOperation(
              command,
              async (request) => {
                const reply = await channel.request(request);
                try {
                  if (!isRecord(reply.input) || reply.input.ok !== true) {
                    throw new Error("Claw Gateway operation failed.");
                  }
                  return reply.input.value;
                } finally {
                  reply.consumed();
                }
              },
              clawControlUiCommitGuard(command.authority),
            );
          } finally {
            try {
              await closeCliResources(cleanup);
            } finally {
              try {
                await cleanup?.pluginResources?.release();
              } finally {
                try {
                  await waitForPendingCliDisposers();
                } finally {
                  await closeOpenClawStateDatabaseAsync();
                }
              }
            }
          }
        }),
      ),
    );
  } finally {
    try {
      await configPersistence.close();
    } finally {
      command.authority.close();
    }
  }
});
