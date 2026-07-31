import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { ControlUiPolicySettingsConstraints } from "./control-ui-contract.js";

export async function collectPluginSettingsConstraints(params: {
  registry: Pick<PluginRegistry, "settingsConstraintsProviders">;
  config: OpenClawConfig;
  cwd?: string;
  configPath?: string;
}): Promise<ControlUiPolicySettingsConstraints | undefined> {
  const providers = params.registry.settingsConstraintsProviders;
  if (providers.length === 0) {
    return undefined;
  }
  const settings: ControlUiPolicySettingsConstraints["settings"] = {};
  for (const entry of providers) {
    const report = await entry.provider.build({
      config: params.config,
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.configPath !== undefined ? { configPath: params.configPath } : {}),
    });
    if (!report) {
      continue;
    }
    for (const [path, constraint] of Object.entries(report.settings)) {
      settings[path] = {
        ...constraint,
        source: constraint.source ?? entry.pluginId,
      };
    }
  }
  if (Object.keys(settings).length === 0) {
    return undefined;
  }
  return { settings };
}
