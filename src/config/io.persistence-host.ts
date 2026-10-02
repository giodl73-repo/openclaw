import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ConfigAuditAppendParams } from "./io.audit.js";
import type { ConfigHealthStateDeps, ConfigHealthStateStore } from "./io.health-state.js";
import type { ConfigHealthEntryChanges, ConfigHealthState } from "./io.health-state.types.js";

/** Config persistence only; file preparation and its live guards remain with the caller. */
export type ConfigPersistenceProvider = {
  captureHealth(
    deps: ConfigHealthStateDeps,
    configPath: string,
    assertCurrent?: () => void,
  ): ConfigHealthStateStore;
  readHealth(deps: ConfigHealthStateDeps): ConfigHealthState;
  patchHealth(
    deps: ConfigHealthStateDeps,
    configPath: string,
    changes: ConfigHealthEntryChanges,
  ): void;
  supersedeHealth(deps: ConfigHealthStateDeps, configPath: string): void;
  appendAudit(params: ConfigAuditAppendParams, assertCurrent?: () => void): Promise<void>;
  appendAuditSync(params: ConfigAuditAppendParams): void;
};

const persistenceProvider = resolveGlobalSingleton(
  Symbol.for("openclaw.configPersistenceProvider"),
  () => new AsyncLocalStorage<ConfigPersistenceProvider | undefined>(),
);

export function getConfigPersistenceProvider(): ConfigPersistenceProvider | undefined {
  return persistenceProvider.getStore();
}

/** Passing undefined lets the host invoke canonical owners without reentering its adapter. */
export function withConfigPersistenceProvider<T>(
  provider: ConfigPersistenceProvider | undefined,
  run: () => T,
): T {
  return persistenceProvider.run(provider, run);
}
