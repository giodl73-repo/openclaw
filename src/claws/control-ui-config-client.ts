import { AsyncLocalStorage } from "node:async_hooks";
import type { MessagePort } from "node:worker_threads";
import type { ConfigAuditAppendParams } from "../config/io.audit.js";
import type { ConfigHealthStateDeps, ConfigHealthStateStore } from "../config/io.health-state.js";
import type { ConfigHealthSnapshot, ConfigHealthState } from "../config/io.health-state.types.js";
import type { ConfigPersistenceProvider } from "../config/io.persistence-host.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import type {
  ClawConfigGuardRequest,
  ClawConfigLocation,
  ClawConfigRequest,
} from "./control-ui-config-contract.js";
import { createClawConfigPort } from "./control-ui-config-port.js";
import { isClawRollbackMetadata } from "./update-rollback.js";

export function createClawConfigPersistenceClient(port: MessagePort, wake: SharedArrayBuffer) {
  const guards = new Map<number, () => void>();
  let nextGuard = 0;
  const endpoint = createClawConfigPort<ClawConfigGuardRequest, ClawConfigRequest>(
    port,
    wake,
    (request) => {
      const guard = guards.get(request.guard);
      if (!guard) {
        throw new Error("Claw config guard is no longer retained.");
      }
      guard();
    },
  );
  const retainGuard = (assertCurrent?: () => void) => {
    const inOwnerContext = AsyncLocalStorage.snapshot();
    const rollbackMetadata = isClawRollbackMetadata();
    const id = ++nextGuard;
    guards.set(id, () =>
      inOwnerContext(() => {
        if (rollbackMetadata && !isClawRollbackMetadata()) {
          throw new Error("Claw rollback metadata owner is no longer active.");
        }
        assertCurrent?.();
      }),
    );
    return id;
  };
  const location = (deps: Pick<ConfigHealthStateDeps, "env" | "homedir">): ClawConfigLocation => ({
    env: deps.env,
    homedir: deps.homedir(),
  });
  const metadataRequest = (request: ClawConfigRequest): ClawConfigRequest =>
    isClawRollbackMetadata() ? { ...request, rollbackMetadata: true } : request;
  const call = <T>(request: ClawConfigRequest) => endpoint.call<T>(metadataRequest(request));
  const callSync = <T>(request: ClawConfigRequest) =>
    endpoint.callSync<T>(metadataRequest(request));
  const proxy = (id: number, assertCurrent?: () => void): ConfigHealthStateStore => ({
    isCurrent() {
      assertCurrent?.();
      return callSync<boolean>({ operation: "current", observation: id });
    },
    captureContinuation() {
      assertCurrent?.();
      return proxy(callSync<number>({ operation: "continue", observation: id }), assertCurrent);
    },
    [Symbol.dispose]() {
      callSync<void>({ operation: "dispose", observation: id });
    },
    read() {
      return call<ConfigHealthSnapshot | null>({
        operation: "read",
        observation: id,
        artifactPreserving: isArtifactPreservingStateRead(),
      });
    },
    update(changes, previous) {
      return call<void>({ operation: "update", observation: id, changes, previous });
    },
    updateAfterFileCommit(changes, previous) {
      return call<void>({
        operation: "updateAfterFileCommit",
        observation: id,
        changes,
        previous,
      });
    },
  });
  const audit = (
    params: ConfigAuditAppendParams,
    assertCurrent?: () => void,
  ): ClawConfigRequest => ({
    operation: "audit",
    location: location(params),
    record: params.record,
    guard: retainGuard(assertCurrent),
  });
  const provider: ConfigPersistenceProvider = {
    captureHealth(deps, configPath, assertCurrent) {
      assertCurrent?.();
      return proxy(
        callSync<number>({
          operation: "capture",
          location: location(deps),
          configPath,
          guard: retainGuard(assertCurrent),
        }),
        assertCurrent,
      );
    },
    readHealth(deps) {
      return callSync<ConfigHealthState>({
        operation: "readHealth",
        location: location(deps),
        artifactPreserving: isArtifactPreservingStateRead(),
      });
    },
    patchHealth(deps, configPath, changes) {
      callSync<void>({
        operation: "patchHealth",
        location: location(deps),
        configPath,
        changes,
      });
    },
    supersedeHealth(deps, configPath) {
      callSync<void>({ operation: "supersede", location: location(deps), configPath });
    },
    appendAudit(params, assertCurrent) {
      return call<void>(audit(params, assertCurrent));
    },
    appendAuditSync(params) {
      callSync<void>(audit(params));
    },
  };
  return {
    provider,
    async close() {
      await endpoint.close();
      guards.clear();
    },
  };
}
