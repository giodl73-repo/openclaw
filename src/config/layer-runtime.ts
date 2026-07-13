import { loadDotEnv } from "../infra/dotenv.js";
import { isPlainObject } from "../infra/plain-object.js";
import { cloneEnvWithPlatformSemantics } from "./env-vars.js";
import { resolveConfigSourceText, type ConfigIoDeps } from "./io.js";
import {
  composeConfigLayers,
  type ConfigLayer,
  type ConfigPathProvenance,
} from "./layer-composition.js";
import {
  resolveConfigLayerSources,
  type ConfigLayerDescriptor,
  type ConfigLayerSourceFinding,
  type ParseConfigLayerSource,
  type ResolveConfigLayerSource,
} from "./layer-sources.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig, RuntimeConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export type ConfigLayerValidationFinding = {
  reason: "InvalidLayerConfig";
  layer: string;
  issues: Array<{ path: string; message: string }>;
};

export type EffectiveConfigValidationFinding = {
  reason: "InvalidEffectiveConfig";
  issues: Array<{ path: string; message: string }>;
};

export type LayerRuntimeResult =
  | {
      valid: true;
      sourceConfig: Record<string, unknown>;
      runtimeConfig: RuntimeConfig;
      provenance: ConfigPathProvenance[];
    }
  | {
      valid: false;
      findings: Array<
        | ConfigLayerValidationFinding
        | EffectiveConfigValidationFinding
        | {
            reason: string;
            layer: string;
            path?: string;
            controllingLayer?: string;
            controllingValue?: unknown;
            conflictingValue?: unknown;
          }
      >;
    };

export type LayerActivationCandidate = {
  sourceConfig: Record<string, unknown>;
  runtimeConfig: RuntimeConfig;
  provenance: ConfigPathProvenance[];
  layers: Array<{
    id: string;
    access: "read-only" | "read-write";
    sourceIdentity: string;
    contentDigest: string;
  }>;
  advisories: Array<{
    reason: "NoDeclaredValues";
    layer: string;
  }>;
};

export type LayerActivationResult =
  | { valid: true; candidate: LayerActivationCandidate }
  | {
      valid: false;
      findings: Array<
        | ConfigLayerSourceFinding
        | ConfigLayerValidationFinding
        | EffectiveConfigValidationFinding
        | { reason: string; layer?: string; message?: string }
      >;
    };

/** Keeps normalized values only at paths explicitly authored by a sparse layer. */
export function projectValidatedConfigOntoDeclaredShape(
  declared: unknown,
  validated: unknown,
): unknown {
  if (!isPlainObject(declared) || !isPlainObject(validated)) {
    return structuredClone(validated);
  }

  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(declared).toSorted()) {
    if (!Object.hasOwn(validated, key)) {
      continue;
    }
    projected[key] = projectValidatedConfigOntoDeclaredShape(declared[key], validated[key]);
  }
  return projected;
}

function prepareConfigLayers(layers: readonly ConfigLayer[]) {
  const prepared: ConfigLayer[] = [];
  const findings: ConfigLayerValidationFinding[] = [];

  for (const layer of layers) {
    let declared: unknown;
    try {
      declared = structuredClone(layer.config);
    } catch {
      findings.push({
        reason: "InvalidLayerConfig",
        layer: layer.id,
        issues: [
          {
            path: "",
            message: "layer document must contain structured-cloneable configuration values",
          },
        ],
      });
      continue;
    }

    // Exact authority compares authored values; normalization occurs only after the fold.
    prepared.push({ id: layer.id, config: declared });
  }

  if (findings.length > 0) {
    return { valid: false as const, findings };
  }
  return composeConfigLayers(prepared);
}

/** Produces one ordinary runtime config after sparse layer admission succeeds. */
export function prepareLayeredRuntimeConfig(
  layers: readonly ConfigLayer[],
  configIO: ConfigIoDeps = {},
): LayerRuntimeResult {
  const composition = prepareConfigLayers(layers);
  if (!composition.valid) {
    return composition;
  }

  const sourceEnv = configIO.env ?? process.env;
  if (sourceEnv === process.env) {
    loadDotEnv({ quiet: true });
  }
  const effectiveEnv = cloneEnvWithPlatformSemantics(sourceEnv);
  let effectiveSourceConfig: OpenClawConfig;
  try {
    effectiveSourceConfig = resolveConfigSourceText(
      JSON.stringify(composition.config),
      "<managed-config>",
      {
        ...configIO,
        env: effectiveEnv,
      },
    );
  } catch (error) {
    return {
      valid: false,
      findings: [
        {
          reason: "InvalidEffectiveConfig",
          issues: [
            {
              path: "",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      ],
    };
  }
  const effectiveValidation = validateConfigObjectWithPlugins(effectiveSourceConfig, {
    env: effectiveEnv,
  });
  if (!effectiveValidation.ok) {
    return {
      valid: false,
      findings: [
        {
          reason: "InvalidEffectiveConfig",
          issues: effectiveValidation.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      ],
    };
  }

  return {
    valid: true,
    sourceConfig: projectValidatedConfigOntoDeclaredShape(
      composition.config,
      effectiveValidation.config as OpenClawConfig,
    ) as Record<string, unknown>,
    runtimeConfig: materializeRuntimeConfig(effectiveValidation.config, "load"),
    provenance: composition.provenance,
  };
}

/** Resolves and validates every layer before invoking one atomic snapshot publisher. */
export async function activateLayeredRuntimeConfig<Source>(params: {
  descriptors: readonly ConfigLayerDescriptor<Source>[];
  resolveSource: ResolveConfigLayerSource<Source>;
  parseSource: ParseConfigLayerSource;
  publish: (candidate: LayerActivationCandidate) => void | Promise<void>;
  configIO?: ConfigIoDeps;
}): Promise<LayerActivationResult> {
  const resolved = await resolveConfigLayerSources(
    params.descriptors,
    params.resolveSource,
    params.parseSource,
  );
  if (!resolved.valid) {
    return resolved;
  }

  const prepared = prepareLayeredRuntimeConfig(resolved.layers, params.configIO);
  if (!prepared.valid) {
    return prepared;
  }

  const candidate: LayerActivationCandidate = {
    sourceConfig: prepared.sourceConfig,
    runtimeConfig: prepared.runtimeConfig,
    provenance: prepared.provenance,
    layers: resolved.layers.map((layer) => ({
      id: layer.id,
      access: layer.access,
      sourceIdentity: layer.sourceIdentity,
      contentDigest: layer.contentDigest,
    })),
    advisories: resolved.layers
      .filter(
        (layer) => !prepared.provenance.some((entry) => entry.declaringLayers.includes(layer.id)),
      )
      .map((layer) => ({ reason: "NoDeclaredValues" as const, layer: layer.id })),
  };

  try {
    await params.publish(candidate);
  } catch (error) {
    return {
      valid: false,
      findings: [
        {
          reason: "RuntimeSnapshotPublishFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  return { valid: true, candidate };
}
