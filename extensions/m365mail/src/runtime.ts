import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setM365MailRuntime,
  clearRuntime: clearM365MailRuntime,
  tryGetRuntime: getOptionalM365MailRuntime,
  getRuntime: getM365MailRuntime,
} = createPluginRuntimeStore<PluginRuntime>(
  "Microsoft 365 Email runtime not initialized - plugin not registered",
);
export { clearM365MailRuntime, getM365MailRuntime, getOptionalM365MailRuntime, setM365MailRuntime };
