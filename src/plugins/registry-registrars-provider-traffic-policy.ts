import {
  registerProviderRequestTrafficPolicyForOwnerV1,
  type ProviderRequestTrafficPolicyRegistrationV1,
} from "../agents/provider-request-traffic-policy.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

export function createProviderRequestTrafficPolicyRegistrars(state: PluginRegistryState) {
  const registerProviderRequestTrafficPolicy = (
    record: PluginRecord,
    registration: ProviderRequestTrafficPolicyRegistrationV1,
  ): (() => void) => {
    if (state.registryParams.activateGlobalSideEffects === false) {
      return () => {};
    }
    const dispose = registerProviderRequestTrafficPolicyForOwnerV1(
      `plugin:${record.id}`,
      registration,
    );
    const disposers =
      state.pluginProviderRequestTrafficPolicyDisposers.get(record.id) ?? new Set<() => void>();
    disposers.add(dispose);
    state.pluginProviderRequestTrafficPolicyDisposers.set(record.id, disposers);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      disposers.delete(dispose);
      if (disposers.size === 0) {
        state.pluginProviderRequestTrafficPolicyDisposers.delete(record.id);
      }
      dispose();
    };
  };

  const rollbackProviderRequestTrafficPolicies = (pluginId: string): void => {
    const disposers = state.pluginProviderRequestTrafficPolicyDisposers.get(pluginId);
    if (!disposers) {
      return;
    }
    for (const dispose of [...disposers].toReversed()) {
      dispose();
    }
    state.pluginProviderRequestTrafficPolicyDisposers.delete(pluginId);
  };

  return { registerProviderRequestTrafficPolicy, rollbackProviderRequestTrafficPolicies };
}
