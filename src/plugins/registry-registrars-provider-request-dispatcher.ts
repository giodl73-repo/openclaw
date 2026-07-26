import {
  registerProviderRequestDispatcherForOwnerV1,
  type ProviderRequestDispatcherRegistrationV1,
} from "../agents/provider-request-dispatcher.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

export function createProviderRequestDispatcherRegistrars(state: PluginRegistryState) {
  const registerProviderRequestDispatcher = (
    record: PluginRecord,
    registration: ProviderRequestDispatcherRegistrationV1,
  ): (() => void) => {
    if (state.registryParams.activateGlobalSideEffects === false) {
      return () => {};
    }
    const dispose = registerProviderRequestDispatcherForOwnerV1(
      `plugin:${record.id}`,
      registration,
    );
    const disposers =
      state.pluginProviderRequestDispatcherDisposers.get(record.id) ?? new Set<() => void>();
    disposers.add(dispose);
    state.pluginProviderRequestDispatcherDisposers.set(record.id, disposers);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      disposers.delete(dispose);
      if (disposers.size === 0) {
        state.pluginProviderRequestDispatcherDisposers.delete(record.id);
      }
      dispose();
    };
  };

  const rollbackProviderRequestDispatchers = (pluginId: string): void => {
    const disposers = state.pluginProviderRequestDispatcherDisposers.get(pluginId);
    if (!disposers) {
      return;
    }
    for (const dispose of [...disposers].toReversed()) {
      dispose();
    }
    state.pluginProviderRequestDispatcherDisposers.delete(pluginId);
  };

  return { registerProviderRequestDispatcher, rollbackProviderRequestDispatchers };
}
