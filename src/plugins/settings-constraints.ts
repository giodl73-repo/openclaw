import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiPolicySettingsConstraints } from "../gateway/control-ui-contract.js";

export type PluginSettingsConstraintsContext = {
  config: OpenClawConfig;
  cwd?: string;
  configPath?: string;
};

export type PluginSettingsConstraintsProvider = {
  id: string;
  description?: string;
  build: (
    context: PluginSettingsConstraintsContext,
  ) =>
    | ControlUiPolicySettingsConstraints
    | null
    | undefined
    | Promise<ControlUiPolicySettingsConstraints | null | undefined>;
};

export type PluginSettingsConstraintsProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: PluginSettingsConstraintsProvider;
  source: string;
  rootDir?: string;
};
