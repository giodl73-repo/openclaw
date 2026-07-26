const SAFE_PLUGIN_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const PLUGIN_READINESS_LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Keeps common plugin ids readable and encodes every other valid manifest id without collisions. */
export function encodePluginReadinessNamespace(pluginId: string): string {
  if (SAFE_PLUGIN_NAMESPACE_PATTERN.test(pluginId)) {
    return pluginId;
  }
  const encoded = Array.from(new TextEncoder().encode(pluginId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `x-${encoded}`;
}

export function pluginReadinessCriterionPrefix(pluginId: string): string {
  return `plugin.${encodePluginReadinessNamespace(pluginId)}.`;
}

export function formatPluginReadinessCriterionId(pluginId: string, localId: string): string {
  return pluginReadinessCriterionPrefix(pluginId) + localId;
}
