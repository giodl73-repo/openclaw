import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveLobsterHostConfig } from "./config.js";
import { LOBSTER_HOST_BUNDLE_MANIFEST_V1 } from "./package-api.js";
import { LobsterContinuityPublicationProvider } from "./publication-provider.js";

let activeBundleLease:
  | {
      references: number;
      unregister: () => void;
    }
  | undefined;

const plugin = {
  id: "lobster-host",
  name: "Lobster Host",
  description: "Registers the inactive Lobster hosted-integration bundle.",
  register(api: OpenClawPluginApi) {
    const config = resolveLobsterHostConfig(api.pluginConfig, api.resolvePath);
    api.registerContinuityPublicationProvider(
      new LobsterContinuityPublicationProvider(config.publicationRoot, config.providerGeneration),
    );
    let unregisterBundle: (() => void) | undefined;
    api.registerService({
      id: "lobster-host-package",
      start: () => {
        if (activeBundleLease) {
          activeBundleLease.references += 1;
          unregisterBundle = () => {
            if (!activeBundleLease || activeBundleLease.references > 1) {
              if (activeBundleLease) {
                activeBundleLease.references -= 1;
              }
              return;
            }
            activeBundleLease.unregister();
            activeBundleLease = undefined;
          };
          return;
        }
        const unregister = api.registerHostIntegrationBundle(LOBSTER_HOST_BUNDLE_MANIFEST_V1);
        activeBundleLease = { references: 1, unregister };
        unregisterBundle = () => {
          if (!activeBundleLease || activeBundleLease.references > 1) {
            if (activeBundleLease) {
              activeBundleLease.references -= 1;
            }
            return;
          }
          activeBundleLease.unregister();
          activeBundleLease = undefined;
        };
      },
      stop: () => {
        unregisterBundle?.();
        unregisterBundle = undefined;
      },
    });
  },
};

export default plugin;
