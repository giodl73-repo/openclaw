import { isPlainObject } from "../infra/plain-object.js";
import {
  composeConfigLayers,
  type ConfigLayer,
  type ConfigPathProvenance,
} from "./layer-composition.js";
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
    let declared: Record<string, unknown>;
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
export function prepareLayeredRuntimeConfig(layers: readonly ConfigLayer[]): LayerRuntimeResult {
  const composition = prepareConfigLayers(layers);
  if (!composition.valid) {
    return composition;
  }

  const effectiveValidation = validateConfigObjectWithPlugins(composition.config);
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
