import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ClawControlUiCronMutationParams,
  ClawControlUiHost,
} from "./control-ui-worker-contract.js";
import type { ClawCronGateway, ClawCronMutation } from "./cron.js";

export function createClawControlUiCronGateway(host: ClawControlUiHost): ClawCronGateway {
  const mutate = async (params: ClawControlUiCronMutationParams): Promise<ClawCronMutation> => {
    const reply = await host({ method: "cron.mutate", params });
    if (!isRecord(reply) || typeof reply.compensationId !== "string") {
      throw new Error("Claw cron mutation returned no compensation custody.");
    }
    const compensationId = reply.compensationId;
    return {
      result: reply.result,
      rollback: () => host({ method: "cron.compensate", params: { compensationId } }),
    };
  };
  return {
    add: (params) => host({ method: "cron.add", params }),
    get: (id) => host({ method: "cron.get", params: { id } }),
    list: (agentId) => host({ method: "cron.list", params: { agentId, includeDisabled: true } }),
    remove: (id) => host({ method: "cron.remove", params: { id } }),
    addWithRollback: (input, previous) => mutate({ operation: "add", input, previous }),
    removeWithRollback: (id, previous) => mutate({ operation: "remove", id, previous }),
    waitUntilAgentAvailable: async (agentId) => {
      await host({ method: "agent.ready", params: { agentId } });
    },
  };
}
