import path from "node:path";
import {
  createLocalFileManagedConfigIO,
  resolveConfigPath,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import type {
  ConfigIoDeps,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../../config/io.js";
import { composeConfigLayers } from "../../config/layer-composition.js";
import type { LocalConfigLayerSource } from "../../config/layer-file-io.js";
import type { LayerActivationResult } from "../../config/layer-runtime.js";
import type { ConfigLayerDescriptor } from "../../config/layer-sources.js";
import { setManagedConfigWritesBlocked } from "../../config/nix-mode-write-guard.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import { resolveUserPath } from "../../utils.js";
import type { GatewayRunOpts } from "./run-options.js";

type ManagedGatewayConfigOptions = Pick<GatewayRunOpts, "configLayer">;

let managedGatewayConfigActive = false;
let preparedManagedGatewaySnapshotRead: ReadConfigFileSnapshotWithPluginMetadataResult | undefined;

export type ManagedGatewayConfigActivation =
  | {
      valid: true;
      cfg: OpenClawConfig;
      snapshot: ConfigFileSnapshot;
      startupConfigSnapshotRead: ReadConfigFileSnapshotWithPluginMetadataResult;
    }
  | Extract<LayerActivationResult, { valid: false }>;

function normalizeLayerArguments(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new Error("--config-layer must be supplied as <id=path>");
}

export function isManagedGatewayConfigActive(): boolean {
  return managedGatewayConfigActive;
}

export function takePreparedManagedGatewaySnapshotRead():
  | ReadConfigFileSnapshotWithPluginMetadataResult
  | undefined {
  const prepared = preparedManagedGatewaySnapshotRead;
  preparedManagedGatewaySnapshotRead = undefined;
  return prepared;
}

export function setPreparedManagedGatewaySnapshot(snapshot: ConfigFileSnapshot): void {
  preparedManagedGatewaySnapshotRead = { snapshot };
}

export function resetManagedGatewayConfigForTest(): void {
  managedGatewayConfigActive = false;
  preparedManagedGatewaySnapshotRead = undefined;
}

export function assertManagedGatewayBootstrapCompatibility(config: OpenClawConfig): void {
  if (config.env !== undefined) {
    throw new Error(
      [
        "managed configuration layers cannot declare env during this startup slice",
        "Supply process or service-manager environment before OpenClaw starts",
      ].join(". "),
    );
  }
}

export function parseManagedGatewayConfigLayers(
  opts: ManagedGatewayConfigOptions,
): ConfigLayerDescriptor<LocalConfigLayerSource>[] | undefined {
  const layerArguments = normalizeLayerArguments(opts.configLayer);
  if (layerArguments.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  return layerArguments.map((argument) => {
    const separator = argument.indexOf("=");
    const id = separator < 0 ? "" : argument.slice(0, separator).trim();
    const sourcePath = separator < 0 ? "" : argument.slice(separator + 1).trim();
    if (!id || !sourcePath) {
      throw new Error("--config-layer must use a non-empty <id=path>");
    }
    if (seen.has(id)) {
      throw new Error(`duplicate managed configuration layer id: ${id}`);
    }
    seen.add(id);
    return {
      id,
      source: {
        path: resolveUserPath(sourcePath),
        identity: `managed-config:${id}`,
      },
      access: "read-only" as const,
      contractVersion: 1 as const,
    };
  });
}

export function formatManagedGatewayConfigFailure(result: {
  findings: readonly unknown[];
}): string {
  return [
    "Managed configuration activation failed:",
    ...result.findings.map((finding) => `- ${JSON.stringify(finding)}`),
  ].join("\n");
}

export function createManagedGatewayConfigController(params: {
  opts: ManagedGatewayConfigOptions;
  configIO?: ConfigIoDeps;
}) {
  const descriptors = parseManagedGatewayConfigLayers(params.opts);
  if (!descriptors) {
    return undefined;
  }

  let publishedPrimaryRead: ReadConfigFileSnapshotWithPluginMetadataResult | undefined;
  let activeSnapshot: ConfigFileSnapshot | undefined;
  const io = createLocalFileManagedConfigIO({
    descriptors,
    publish: async (candidate) => {
      publishedPrimaryRead = await io.configIO.readConfigFileSnapshotWithPluginMetadata();
      setRuntimeConfigSnapshot(candidate.runtimeConfig, publishedPrimaryRead.snapshot.sourceConfig);
    },
    configIO: {
      observe: false,
      ...params.configIO,
    },
  });
  const primaryConfigPath = path.resolve(io.configIO.configPath);
  if (
    !descriptors.some((descriptor) => path.resolve(descriptor.source.path) === primaryConfigPath)
  ) {
    throw new Error("managed configuration layers must include OPENCLAW_CONFIG_PATH");
  }
  setManagedConfigWritesBlocked(true);
  managedGatewayConfigActive = true;

  return {
    assertSelectedPrimary() {
      const selectedConfigPath = path.resolve(resolveConfigPath());
      if (selectedConfigPath !== primaryConfigPath) {
        throw new Error(
          "managed configuration primary changed during startup: " + selectedConfigPath,
        );
      }
    },
    getActiveSnapshot() {
      return activeSnapshot;
    },
    async previewSourceConfig() {
      const resolved = await io.resolveLayers();
      if (!resolved.valid) {
        return resolved;
      }
      const composed = composeConfigLayers(resolved.layers);
      return composed.valid
        ? { valid: true as const, config: composed.config as OpenClawConfig }
        : composed;
    },
    async activate(): Promise<ManagedGatewayConfigActivation> {
      const activation = await io.activate();
      if (!activation.valid) {
        return activation;
      }
      publishedPrimaryRead = undefined;
      const { candidate } = activation;
      const snapshot: ConfigFileSnapshot = {
        path: io.configIO.configPath,
        exists: true,
        raw: JSON.stringify(candidate.sourceConfig, null, 2),
        parsed: candidate.sourceConfig,
        sourceConfig: candidate.sourceConfig,
        resolved: candidate.sourceConfig,
        valid: true,
        runtimeConfig: candidate.runtimeConfig,
        config: candidate.runtimeConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
      activeSnapshot = snapshot;
      return {
        valid: true,
        cfg: candidate.runtimeConfig,
        snapshot,
        startupConfigSnapshotRead: { snapshot },
      };
    },
  };
}
