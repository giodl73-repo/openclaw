import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateClawsAddApplyParams,
  validateClawsUpdateApplyParams,
  validateClawsRemovePlanParams,
  validateClawsRemoveApplyParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  ClawControlUiCommand,
  ClawControlUiHost,
  ClawControlUiCronMutationParams,
} from "../../claws/control-ui-worker-contract.js";
import { assertExperimentalClawsEnabled } from "../../claws/experimental.js";
import { sleep } from "../../utils/sleep.js";
import { ADMIN_SCOPE, READ_SCOPE } from "../operator-scopes.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

async function invokeOwner(
  handler: GatewayRequestHandler | undefined,
  options: GatewayRequestHandlerOptions,
  method: string,
  params: Record<string, unknown>,
  assertCurrent: () => void,
): Promise<unknown> {
  if (!handler) {
    throw new Error(`Claw Gateway operation is not registered: ${method}`);
  }
  let answered = false;
  let result: unknown;
  let failure: unknown;
  assertCurrent();
  await handler({
    ...options,
    req: { ...options.req, method, params },
    params,
    sessionMutationCommitGuard: assertCurrent,
    respond: (ok, value, error) => {
      answered = true;
      result = value;
      if (!ok) {
        failure = new Error(error?.message ?? "Claw Gateway operation failed.");
      }
    },
  });
  if (failure) {
    throw failure;
  }
  if (!answered) {
    throw new Error("Claw Gateway operation did not return an outcome.");
  }
  return result;
}

export function createClawControlUiHost(
  options: GatewayRequestHandlerOptions,
  assertCurrent: () => void,
): ClawControlUiHost {
  const cron = options.context.cron;
  const cronStorePath = options.context.cronStorePath;
  let compensation:
    | ReturnType<
        typeof import("../../claws/control-ui-cron-compensation.js").createClawControlUiCronCompensation
      >
    | undefined;
  return async ({ method, params }) => {
    if (method === "cron.compensate") {
      if (typeof params.compensationId !== "string" || Object.keys(params).length !== 1) {
        throw new Error("Invalid Claw cron compensation request.");
      }
      if (!compensation) {
        throw new Error("Claw cron compensation custody is unavailable.");
      }
      return await compensation.compensate(params.compensationId);
    }
    assertCurrent();
    if (method === "cron.mutate") {
      // Private worker input, never a public Gateway method or browser-authored inverse.
      if (
        !(
          (params.operation === "add" && isRecord(params.input)) ||
          (params.operation === "remove" &&
            typeof params.id === "string" &&
            isRecord(params.previous))
        )
      ) {
        throw new Error("Invalid Claw cron mutation request.");
      }
      if (!compensation) {
        const { createClawControlUiCronCompensation } =
          await import("../../claws/control-ui-cron-compensation.js");
        compensation = createClawControlUiCronCompensation({
          cron,
          assertCurrent,
          assertOwnerCurrent: () => {
            if (options.context.cron !== cron || options.context.cronStorePath !== cronStorePath) {
              throw new Error("Claw cron scheduler owner changed.");
            }
          },
          invoke: async (method, input, guard, isCommitted) => {
            const { cronHandlers } = await import("./cron.js");
            return await invokeOwner(
              cronHandlers[method],
              {
                ...options,
                // Only this invocation's scheduler-owned postcommit settlement survives revoke.
                hasCurrentClientAuthority: () =>
                  isCommitted() || options.hasCurrentClientAuthority?.() !== false,
              },
              method,
              input,
              guard,
            );
          },
        });
      }
      return await compensation.mutate(params as ClawControlUiCronMutationParams);
    }
    if (method === "config") {
      return options.context.getRuntimeConfig();
    }
    if (method === "monitor.binding") {
      const { resolveClawMonitorCleanupBinding } =
        await import("../../claws/monitor-cleanup-binding.js");
      return resolveClawMonitorCleanupBinding(options.context.cronStorePath);
    }
    if (method === "agent.ready") {
      const { configHandlers } = await import("./config.js");
      const deadline = performance.now() + 15_000;
      do {
        const snapshot = await invokeOwner(
          configHandlers["config.get"],
          options,
          "config.get",
          {},
          assertCurrent,
        );
        assertCurrent();
        if (
          isRecord(snapshot) &&
          typeof snapshot.configRevisionHash === "string" &&
          snapshot.configRevisionHash === snapshot.appliedConfigHash &&
          typeof params.agentId === "string" &&
          Object.hasOwn(options.context.getRuntimeConfig().agents?.entries ?? {}, params.agentId)
        ) {
          return;
        }
        if (
          options.context.getDeferredChannelReloads?.().some((reload) => reload.publicationPending)
        ) {
          throw new Error(
            "Claw configuration is saved; runtime reload is waiting for active requests to finish.",
          );
        }
        await sleep(100);
      } while (performance.now() < deadline);
      throw new Error("Gateway has not applied the Claw configuration yet.");
    }
    if (["cron.add", "cron.get", "cron.list", "cron.remove"].includes(method)) {
      const { cronHandlers } = await import("./cron.js");
      return await invokeOwner(cronHandlers[method], options, method, params, assertCurrent);
    }
    if (method === "claws.monitors") {
      const { clawsMonitorHandlers } = await import("./claws-monitors.js");
      return await invokeOwner(
        clawsMonitorHandlers[method],
        options,
        method,
        params,
        assertCurrent,
      );
    }
    if (method === "claws.packages.remove") {
      const { clawsPackageHandlers } = await import("./claws-packages.js");
      return await invokeOwner(
        clawsPackageHandlers[method],
        options,
        method,
        params,
        assertCurrent,
      );
    }
    throw new Error("Unsupported Claw worker request.");
  };
}

function lifecycleHandler<T>(
  method: string,
  validate: Validator<T>,
  command: (params: T) => ClawControlUiCommand,
  readOnly = false,
): GatewayRequestHandler {
  return async (options) => {
    const {
      params,
      respond,
      client,
      signal,
      hasCurrentClientAuthority,
      sessionMutationCommitGuard,
    } = options;
    try {
      assertExperimentalClawsEnabled();
      if (!assertValidParams(params, validate, method, respond)) {
        return;
      }
      const assertCurrent = () => {
        assertExperimentalClawsEnabled();
        if (
          hasCurrentClientAuthority?.() === false ||
          (client &&
            (client.invalidated ||
              (client.connect.role ?? "operator") !== "operator" ||
              !(
                client.connect.scopes?.includes(ADMIN_SCOPE) ||
                (readOnly && client.connect.scopes?.includes(READ_SCOPE))
              )))
        ) {
          throw new Error("Claw lifecycle authority is no longer active.");
        }
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
      };
      assertCurrent();
      const { runClawControlUiOperation } = await import("../../claws/control-ui-worker.js");
      const result = await runClawControlUiOperation(command(params), {
        assertCurrent,
        request: createClawControlUiHost(options, assertCurrent),
      });
      respond(true, result);
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Claw operation did not complete. Refresh inventory and review a new plan before retrying.",
        ),
      );
    }
  };
}

export const clawsMutationHandlers: GatewayRequestHandlers = {
  "claws.add.apply": lifecycleHandler("claws.add.apply", validateClawsAddApplyParams, (params) => ({
    operation: "add",
    params,
  })),
  "claws.update.apply": lifecycleHandler(
    "claws.update.apply",
    validateClawsUpdateApplyParams,
    (params) => ({ operation: "update", params }),
  ),
  "claws.remove.plan": lifecycleHandler(
    "claws.remove.plan",
    validateClawsRemovePlanParams,
    (params) => ({ operation: "remove.plan", params }),
    true,
  ),
  "claws.remove.apply": lifecycleHandler(
    "claws.remove.apply",
    validateClawsRemoveApplyParams,
    (params) => ({ operation: "remove", params }),
  ),
};
