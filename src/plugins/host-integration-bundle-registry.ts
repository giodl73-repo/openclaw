/** Registry-scoped view of validated host integration bundle declarations. */
import { createHash } from "node:crypto";
import type { PluginManifestHostIntegrationBundle } from "./host-integration-bundle.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PluginOrigin } from "./types.js";

export type RegisteredHostIntegrationBundle = Readonly<{
  pluginId: string;
  source: string;
  rootDir?: string;
  origin: PluginOrigin;
  generation: string;
  bundle: PluginManifestHostIntegrationBundle;
}>;

export function deriveHostIntegrationBundleGeneration(plugin: {
  id: string;
  version?: string;
  origin: PluginOrigin;
  hostIntegrationBundle: PluginManifestHostIntegrationBundle;
}): string {
  const bundle = plugin.hostIntegrationBundle;
  const identity = JSON.stringify({
    contractVersion: "registered-host-integration-bundle/v1",
    pluginId: plugin.id,
    pluginVersion: plugin.version ?? null,
    origin: plugin.origin,
    bundle: {
      contractVersion: bundle.contractVersion,
      id: bundle.id,
      version: bundle.version,
      contributions: bundle.contributions.toSorted((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    },
  });
  const digest = createHash("sha256").update(identity).digest("hex");
  return `host-bundle-generation/v1:sha256:${digest}`;
}

/** Returns the enabled, non-failed bundle declarations in the supplied registry snapshot. */
export function listRegisteredHostIntegrationBundles(
  registry: Pick<PluginRegistry, "plugins">,
): readonly RegisteredHostIntegrationBundle[] {
  const registrations = registry.plugins
    .filter(
      (
        plugin,
      ): plugin is typeof plugin & {
        hostIntegrationBundle: PluginManifestHostIntegrationBundle;
      } =>
        plugin.enabled && plugin.status !== "error" && plugin.hostIntegrationBundle !== undefined,
    )
    .map((plugin) =>
      Object.freeze({
        pluginId: plugin.id,
        source: plugin.source,
        ...(plugin.rootDir ? { rootDir: plugin.rootDir } : {}),
        origin: plugin.origin,
        generation: deriveHostIntegrationBundleGeneration(plugin),
        bundle: plugin.hostIntegrationBundle,
      }),
    )
    .toSorted(
      (left, right) =>
        left.bundle.id.localeCompare(right.bundle.id) ||
        left.pluginId.localeCompare(right.pluginId),
    );
  return Object.freeze(registrations);
}
