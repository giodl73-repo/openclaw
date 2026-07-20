import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { resolveManifestContractOwnerPluginIds } from "../plugins/plugin-registry-contributions.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  ContinuityPublicationError,
  normalizeContinuityPublicationProviderIdV1,
  type ContinuityPublicationProviderReferenceV1,
} from "./publication-provider.js";

export type ContinuityPublicationProviderRuntimeV1 = {
  pluginId: string;
  registry: PluginRegistry;
  reference: ContinuityPublicationProviderReferenceV1;
};

export function resolveContinuityPublicationProviderRuntimeV1(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
}): ContinuityPublicationProviderRuntimeV1 {
  const providerId = normalizeContinuityPublicationProviderIdV1(
    params.config.continuity?.publicationProvider,
  );
  if (!providerId) {
    throw new ContinuityPublicationError(
      "provider-not-found",
      "Continuity publication provider is not configured",
    );
  }

  const pluginIds = resolveManifestContractOwnerPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    contract: "continuityPublicationProviders",
    value: providerId,
  });
  if (pluginIds.length === 0) {
    throw new ContinuityPublicationError(
      "provider-not-found",
      `Continuity publication provider "${providerId}" has no manifest owner`,
    );
  }
  if (pluginIds.length !== 1) {
    throw new ContinuityPublicationError(
      "provider-ambiguous",
      `Continuity publication provider "${providerId}" has multiple manifest owners`,
    );
  }

  const pluginId = pluginIds[0];
  const registry = resolveRuntimePluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: [pluginId],
    activate: false,
    cache: false,
  });
  if (!registry) {
    throw new ContinuityPublicationError(
      "provider-not-found",
      `Continuity publication plugin "${pluginId}" could not be loaded`,
    );
  }
  const registrations = registry.continuityPublicationProviders.filter(
    (registration) => registration.pluginId === pluginId && registration.provider.id === providerId,
  );
  if (registrations.length === 0) {
    throw new ContinuityPublicationError(
      "provider-not-found",
      `Continuity publication provider "${providerId}" was not registered by plugin "${pluginId}"`,
    );
  }
  if (registrations.length !== 1) {
    throw new ContinuityPublicationError(
      "provider-ambiguous",
      `Continuity publication provider "${providerId}" was registered more than once`,
    );
  }
  const provider = registrations[0]?.provider;
  if (!provider) {
    throw new ContinuityPublicationError(
      "provider-not-found",
      `Continuity publication provider "${providerId}" is unavailable`,
    );
  }

  return {
    pluginId,
    registry,
    reference: {
      pluginId,
      id: provider.id,
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: provider.generation,
    },
  };
}
