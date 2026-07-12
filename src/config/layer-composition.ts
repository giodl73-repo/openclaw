import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../infra/plain-object.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  compareConfigLayerBound,
  prepareConfigLayerAuthorityValue,
  type ConfigLayerControl,
} from "./layer-authority.js";

export type ConfigLayer = {
  id: string;
  config: unknown;
};

export type ConfigPathProvenance = {
  path: string;
  control: ConfigLayerControl;
  controllingLayer: string;
  declaringLayers: string[];
};

export type ConfigLayerFinding = {
  reason:
    | "EmptyLayerId"
    | "DuplicateLayerId"
    | "InvalidLayerDocument"
    | "BlockedConfigPath"
    | "ControlledByEarlierLayer"
    | "WouldWeakenEarlierLayer";
  layer: string;
  path?: string;
  controllingLayer?: string;
  controllingValue?: unknown;
  conflictingValue?: unknown;
};

export type ConfigCompositionResult =
  | {
      valid: true;
      config: Record<string, unknown>;
      provenance: ConfigPathProvenance[];
    }
  | {
      valid: false;
      findings: ConfigLayerFinding[];
    };

type ExactClaim = {
  control: ConfigLayerControl;
  value: unknown;
  controllingLayer: string;
  declaringLayers: string[];
};

type StoredClaim = { path: string[]; claim: ExactClaim };

function formatPath(segments: readonly string[]): string {
  return segments.join(".");
}

function pathKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

function setPath(target: Record<string, unknown>, segments: readonly string[], value: unknown) {
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (isPlainObject(current)) {
      cursor = current;
      continue;
    }
    const next: Record<string, unknown> = {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]] = structuredClone(value);
}

/**
 * Composes sparse, already-resolved config layers from strongest to weakest.
 * Defaults and runtime normalization belong after this presence-preserving fold.
 */
export function composeConfigLayers(layers: readonly ConfigLayer[]): ConfigCompositionResult {
  const findings: ConfigLayerFinding[] = [];
  const seenLayerIds = new Set<string>();

  for (const layer of layers) {
    if (!layer.id.trim()) {
      findings.push({ reason: "EmptyLayerId", layer: layer.id });
      continue;
    }
    if (seenLayerIds.has(layer.id)) {
      findings.push({ reason: "DuplicateLayerId", layer: layer.id });
      continue;
    }
    seenLayerIds.add(layer.id);
    if (!isPlainObject(layer.config)) {
      findings.push({ reason: "InvalidLayerDocument", layer: layer.id });
    }
  }

  if (findings.length > 0) {
    return { valid: false, findings };
  }

  const claims = new Map<string, StoredClaim>();
  const config: Record<string, unknown> = {};

  const findAncestorClaim = (path: readonly string[]): StoredClaim | undefined =>
    [...claims.values()].find(
      (entry) =>
        entry.path.length < path.length &&
        entry.path.every((segment, index) => segment === path[index]),
    );

  const findDescendantClaim = (path: readonly string[]): StoredClaim | undefined =>
    [...claims.values()].find(
      (entry) =>
        entry.path.length > path.length &&
        path.every((segment, index) => segment === entry.path[index]),
    );

  const recordConflict = (params: {
    layer: ConfigLayer;
    path: string[];
    candidate: unknown;
    existing: StoredClaim;
    reason?: "ControlledByEarlierLayer" | "WouldWeakenEarlierLayer";
  }) => {
    findings.push({
      reason: params.reason ?? "ControlledByEarlierLayer",
      layer: params.layer.id,
      path: formatPath(params.path),
      controllingLayer: params.existing.claim.controllingLayer,
      controllingValue: structuredClone(params.existing.claim.value),
      conflictingValue: structuredClone(params.candidate),
    });
  };

  const visit = (layer: ConfigLayer, value: Record<string, unknown>, parent: string[]) => {
    for (const key of Object.keys(value).toSorted()) {
      const path = [...parent, key];
      if (isBlockedObjectKey(key)) {
        findings.push({ reason: "BlockedConfigPath", layer: layer.id, path: formatPath(path) });
        continue;
      }

      const candidate = value[key];
      if (isPlainObject(candidate)) {
        const exact = claims.get(pathKey(path));
        const overlapping = exact ?? findAncestorClaim(path);
        if (overlapping) {
          recordConflict({ layer, path, candidate, existing: overlapping });
          continue;
        }
        visit(layer, candidate, path);
        continue;
      }

      const keyForPath = pathKey(path);
      const existing = claims.get(keyForPath);
      if (!existing) {
        const overlapping = findAncestorClaim(path) ?? findDescendantClaim(path);
        if (overlapping) {
          recordConflict({ layer, path, candidate, existing: overlapping });
          continue;
        }
        const prepared = prepareConfigLayerAuthorityValue(formatPath(path), candidate);
        claims.set(keyForPath, {
          path,
          claim: {
            control: prepared.control,
            value: prepared.value,
            controllingLayer: layer.id,
            declaringLayers: [layer.id],
          },
        });
        setPath(config, path, prepared.value);
        continue;
      }

      if (existing.claim.control !== "exact") {
        const comparison = compareConfigLayerBound({
          control: existing.claim.control,
          inherited: existing.claim.value,
          candidate,
        });
        if (!comparison.accepted) {
          recordConflict({
            layer,
            path,
            candidate,
            existing,
            reason: "WouldWeakenEarlierLayer",
          });
          continue;
        }
        existing.claim.declaringLayers.push(layer.id);
        if (comparison.tightened) {
          existing.claim.value = comparison.value;
          existing.claim.controllingLayer = layer.id;
          setPath(config, path, comparison.value);
        }
        continue;
      }

      if (isDeepStrictEqual(existing.claim.value, candidate)) {
        existing.claim.declaringLayers.push(layer.id);
        continue;
      }

      recordConflict({ layer, path, candidate, existing });
    }
  };

  for (const layer of layers) {
    const claimsBefore = structuredClone(claims);
    const configBefore = structuredClone(config);
    const findingCountBefore = findings.length;
    let document: Record<string, unknown>;
    try {
      document = structuredClone(layer.config) as Record<string, unknown>;
    } catch {
      findings.push({ reason: "InvalidLayerDocument", layer: layer.id });
      continue;
    }
    visit(layer, document, []);
    if (findings.length > findingCountBefore) {
      claims.clear();
      for (const [key, claim] of claimsBefore) {
        claims.set(key, claim);
      }
      for (const key of Object.keys(config)) {
        delete config[key];
      }
      Object.assign(config, configBefore);
    }
  }

  if (findings.length > 0) {
    return { valid: false, findings };
  }

  const provenance = [...claims.values()]
    .map(({ path, claim }) => ({
      path: formatPath(path),
      control: claim.control,
      controllingLayer: claim.controllingLayer,
      declaringLayers: [...claim.declaringLayers],
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path));

  return { valid: true, config, provenance };
}
