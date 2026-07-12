import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LOBSTER_HOST_BUNDLE_MANIFEST_V1 } from "./package-api.js";

const plugin = {
  id: "lobster-host",
  name: "Lobster Host",
  description: "Registers the inactive Lobster hosted-integration bundle.",
  register(api: OpenClawPluginApi) {
    let unregisterBundle: (() => void) | undefined;
    api.registerService({
      id: "lobster-host-package",
      start: () => {
        unregisterBundle = api.registerHostIntegrationBundle(LOBSTER_HOST_BUNDLE_MANIFEST_V1);
      },
      stop: () => {
        unregisterBundle?.();
        unregisterBundle = undefined;
      },
    });
  },
};

export default plugin;
