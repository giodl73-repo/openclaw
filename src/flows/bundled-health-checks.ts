import { asOptionalObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { registerHealthCheck } from "./health-check-registry.js";

type BundledHealthApi = {
  registerFeedsDoctorChecks?: (host: { registerHealthCheck: typeof registerHealthCheck }) => void;
  registerPolicyDoctorChecks?: (host: { registerHealthCheck: typeof registerHealthCheck }) => void;
};

export function registerBundledHealthChecks(params: { cfg: OpenClawConfig; cwd?: string }): void {
  if (shouldRegisterFeedsHealth(params)) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "feeds",
      artifactBasename: "api.js",
    }).registerFeedsDoctorChecks?.({ registerHealthCheck });
  }
  if (shouldRegisterPolicyHealth(params)) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "policy",
      artifactBasename: "api.js",
    }).registerPolicyDoctorChecks?.({ registerHealthCheck });
  }
}

function shouldRegisterPolicyHealth(params: { cfg: OpenClawConfig; cwd?: string }): boolean {
  const entry = params.cfg.plugins?.entries?.policy;
  const config = readRecord(entry?.config) ?? {};
  if (entry === undefined || entry.enabled === false || config.enabled === false) {
    return false;
  }
  if (
    !passesManifestOwnerBasePolicy({
      plugin: { id: "policy" },
      normalizedConfig: normalizePluginsConfig(params.cfg.plugins),
    })
  ) {
    return false;
  }
  return entry.enabled === true || config.enabled === true;
}

function shouldRegisterFeedsHealth(params: { cfg: OpenClawConfig; cwd?: string }): boolean {
  const entry = params.cfg.plugins?.entries?.feeds;
  const config = readRecord(entry?.config) ?? {};
  if (entry === undefined || entry.enabled === false || config.enabled === false) {
    return false;
  }
  if (
    !passesManifestOwnerBasePolicy({
      plugin: { id: "feeds" },
      normalizedConfig: normalizePluginsConfig(params.cfg.plugins),
    })
  ) {
    return false;
  }
  return entry.enabled === true || config.enabled === true;
}
