import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setM365MailRuntime, getRuntime: getM365MailRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "Microsoft 365 Email runtime not initialized - plugin not registered",
  );
export { getM365MailRuntime, setM365MailRuntime };
