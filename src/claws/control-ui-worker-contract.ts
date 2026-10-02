import type { MessagePort } from "node:worker_threads";
import type {
  ClawLifecycleApplyResult,
  ClawLifecyclePlanResult,
  ClawsAddApplyParams,
  ClawsUpdateApplyParams,
  ClawsRemovePlanParams,
  ClawsRemoveApplyParams,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { PersistedClawCronRef } from "./cron.js";

export type ClawControlUiCommand =
  | { operation: "add"; params: ClawsAddApplyParams }
  | { operation: "update"; params: ClawsUpdateApplyParams }
  | { operation: "remove.plan"; params: ClawsRemovePlanParams }
  | { operation: "remove"; params: ClawsRemoveApplyParams };
export type ClawControlUiWorkerInput = ClawControlUiCommand & {
  authority: MessagePort;
  configPersistence: MessagePort;
  configPersistenceWake: SharedArrayBuffer;
};
export type ClawControlUiWorkerResult = ClawLifecycleApplyResult | ClawLifecyclePlanResult;
export type ClawControlUiHostRequest = { method: string; params: Record<string, unknown> };
export type ClawControlUiHost = (request: ClawControlUiHostRequest) => Promise<unknown>;

export type ClawControlUiCronMutationParams =
  | { operation: "add"; input: Record<string, unknown>; previous?: PersistedClawCronRef }
  | { operation: "remove"; id: string; previous: PersistedClawCronRef };

export type ClawControlUiCronMutationResult = {
  result: unknown;
  compensationId: string;
};
