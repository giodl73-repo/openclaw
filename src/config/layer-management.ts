import { createHash } from "node:crypto";
import type { ConfigIoDeps } from "./io.js";
import type { ConfigPathProvenance } from "./layer-composition.js";
import {
  prepareLayeredRuntimeConfig,
  type LayerActivationCandidate,
  type LayerActivationResult,
} from "./layer-runtime.js";
import {
  resolveConfigLayerSources,
  type ConfigLayerDescriptor,
  type ConfigLayerSourceFinding,
  type ParseConfigLayerSource,
  type ResolveConfigLayerSource,
  type ResolvedConfigLayer,
} from "./layer-sources.js";

export type LayerWriteFinding =
  | ConfigLayerSourceFinding
  | {
      reason: "UnknownTargetLayer" | "ReadOnlyLayer" | "DigestPinnedWritableLayer";
      layer: string;
    }
  | {
      reason: "StaleTargetGeneration" | "StaleAuthorityChain";
      layer: string;
      expected: string;
      actual: string;
      message: string;
    }
  | {
      reason: "LayerPersistenceFailed" | "LayerPersistedButActivationFailed";
      message: string;
    }
  | { reason: string; layer?: string; message?: string };

export type PersistConfigLayer<Source> = (params: {
  targetLayerId: string;
  source: Source;
  content: Uint8Array;
  expectedTargetDigest: string;
  expectedAuthorityChainIdentity: string;
  effectiveSourceConfig: LayerActivationCandidate["sourceConfig"];
}) =>
  | { persistedContent: string | Uint8Array }
  | Promise<{ persistedContent: string | Uint8Array }>;

export type LayerWriteResult =
  | {
      valid: true;
      candidate: LayerActivationCandidate;
      authorityChainIdentity: string;
    }
  | {
      valid: false;
      findings: LayerWriteFinding[];
      persisted?: {
        targetDigest: string;
        authorityChainIdentity: string;
      };
    };

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Stable identity for the ordered authority inputs, excluding config values and source locations. */
export function identifyAuthorityChain(layers: readonly ResolvedConfigLayer[]): `sha256:${string}` {
  const canonical = layers.map((layer) => ({
    id: layer.id,
    access: layer.access,
    contentDigest: layer.contentDigest,
    ...(layer.sourceGenerationIdentity
      ? { sourceGenerationIdentity: layer.sourceGenerationIdentity }
      : {}),
  }));
  return digest(new TextEncoder().encode(JSON.stringify(canonical)));
}

function activationCandidate(
  layers: readonly ResolvedConfigLayer[],
  configIO?: ConfigIoDeps,
): LayerActivationResult | { valid: true; candidate: LayerActivationCandidate } {
  const prepared = prepareLayeredRuntimeConfig(layers, configIO);
  if (!prepared.valid) {
    return prepared;
  }
  return {
    valid: true,
    candidate: {
      sourceConfig: prepared.sourceConfig,
      runtimeConfig: prepared.runtimeConfig,
      provenance: prepared.provenance,
      pluginMetadataSnapshot: prepared.pluginMetadataSnapshot,
      layers: layers.map((layer) => ({
        id: layer.id,
        access: layer.access,
        sourceIdentity: layer.sourceIdentity,
        contentDigest: layer.contentDigest,
        ...(layer.sourceGenerationIdentity
          ? { sourceGenerationIdentity: layer.sourceGenerationIdentity }
          : {}),
      })),
      advisories: layers
        .filter(
          (layer) => !prepared.provenance.some((entry) => entry.declaringLayers.includes(layer.id)),
        )
        .map((layer) => ({ reason: "NoDeclaredValues" as const, layer: layer.id })),
    },
  };
}

/** Preflights a targeted layer write against the complete current authority chain. */
export async function writeConfigLayer<Source>(params: {
  descriptors: readonly ConfigLayerDescriptor<Source>[];
  targetLayerId: string;
  proposedContent: string | Uint8Array;
  expectedTargetDigest: string;
  expectedAuthorityChainIdentity: string;
  resolveSource: ResolveConfigLayerSource<Source>;
  parseSource: ParseConfigLayerSource;
  persist: PersistConfigLayer<Source>;
  publish: (candidate: LayerActivationCandidate) => void | Promise<void>;
  configIO?: ConfigIoDeps;
}): Promise<LayerWriteResult> {
  const resolved = await resolveConfigLayerSources(
    params.descriptors,
    params.resolveSource,
    params.parseSource,
  );
  if (!resolved.valid) {
    return resolved;
  }

  const targetIndex = resolved.layers.findIndex((layer) => layer.id === params.targetLayerId);
  if (targetIndex < 0) {
    return {
      valid: false,
      findings: [{ reason: "UnknownTargetLayer", layer: params.targetLayerId }],
    };
  }
  const target = resolved.layers[targetIndex];
  const descriptor = params.descriptors[targetIndex];
  if (target.access !== "read-write") {
    return { valid: false, findings: [{ reason: "ReadOnlyLayer", layer: target.id }] };
  }
  if (descriptor.expectedDigest !== undefined) {
    return {
      valid: false,
      findings: [{ reason: "DigestPinnedWritableLayer", layer: target.id }],
    };
  }

  const authorityChainIdentity = identifyAuthorityChain(resolved.layers);
  if (target.contentDigest !== params.expectedTargetDigest) {
    return {
      valid: false,
      findings: [
        {
          reason: "StaleTargetGeneration",
          layer: target.id,
          expected: params.expectedTargetDigest,
          actual: target.contentDigest,
          message: "reload the target source and retry the write",
        },
      ],
    };
  }
  if (authorityChainIdentity !== params.expectedAuthorityChainIdentity) {
    return {
      valid: false,
      findings: [
        {
          reason: "StaleAuthorityChain",
          layer: target.id,
          expected: params.expectedAuthorityChainIdentity,
          actual: authorityChainIdentity,
          message: "reload the complete layer chain and retry the write",
        },
      ],
    };
  }

  const content = bytes(params.proposedContent);
  let config: unknown;
  try {
    config = await params.parseSource(content, {
      layerId: target.id,
      sourceIdentity: target.sourceIdentity,
      source: descriptor.source,
    });
  } catch (error) {
    return {
      valid: false,
      findings: [
        {
          reason: "LayerSourceParseFailed",
          layer: target.id,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const proposedLayers = [...resolved.layers];
  proposedLayers[targetIndex] = { ...target, config, contentDigest: digest(content) };
  const prepared = activationCandidate(proposedLayers, params.configIO);
  if (!prepared.valid) {
    return prepared;
  }

  let committedContent: Uint8Array;
  try {
    const persistence = await params.persist({
      targetLayerId: target.id,
      source: descriptor.source,
      content,
      expectedTargetDigest: params.expectedTargetDigest,
      expectedAuthorityChainIdentity: params.expectedAuthorityChainIdentity,
      effectiveSourceConfig: prepared.candidate.sourceConfig,
    });
    committedContent = bytes(persistence.persistedContent);
  } catch (error) {
    return {
      valid: false,
      findings: [
        {
          reason: "LayerPersistenceFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const committedDigest = digest(committedContent);
  proposedLayers[targetIndex] = {
    ...proposedLayers[targetIndex],
    contentDigest: committedDigest,
  };
  const refreshed = await resolveConfigLayerSources(
    params.descriptors,
    params.resolveSource,
    params.parseSource,
  );
  if (!refreshed.valid) {
    return {
      valid: false,
      findings: refreshed.findings,
      persisted: {
        targetDigest: committedDigest,
        authorityChainIdentity: identifyAuthorityChain(proposedLayers),
      },
    };
  }

  const committedLayers = refreshed.layers;
  const refreshedTarget = committedLayers.find((layer) => layer.id === target.id);
  if (refreshedTarget?.contentDigest !== committedDigest) {
    return {
      valid: false,
      findings: [
        {
          reason: "TargetChangedAfterPersistence",
          layer: target.id,
          message: "the writable source changed after commit; reload and retry",
        },
      ],
      persisted: {
        targetDigest: refreshedTarget?.contentDigest ?? committedDigest,
        authorityChainIdentity: identifyAuthorityChain(committedLayers),
      },
    };
  }
  const committed = activationCandidate(committedLayers, params.configIO);
  if (!committed.valid) {
    return {
      valid: false,
      findings: committed.findings,
      persisted: {
        targetDigest: committedDigest,
        authorityChainIdentity: identifyAuthorityChain(committedLayers),
      },
    };
  }
  const persistedCandidate = committed.candidate;
  const persistedAuthorityChainIdentity = identifyAuthorityChain(committedLayers);

  try {
    await params.publish(persistedCandidate);
  } catch (error) {
    return {
      valid: false,
      findings: [
        {
          reason: "LayerPersistedButActivationFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      persisted: {
        targetDigest: committedDigest,
        authorityChainIdentity: persistedAuthorityChainIdentity,
      },
    };
  }
  return {
    valid: true,
    candidate: persistedCandidate,
    authorityChainIdentity: persistedAuthorityChainIdentity,
  };
}

export type LayerGenerationInspection = {
  attemptGeneration: number;
  activeGeneration: number | null;
  attemptedAt: string;
  ready: boolean;
  findings: Array<{ reason: string; layer?: string; message?: string }>;
  layers: LayerActivationCandidate["layers"];
  provenance: ConfigPathProvenance[];
  advisories: LayerActivationCandidate["advisories"];
};

/** In-memory projection for existing status/readiness adapters; it never retains config values. */
export function createLayerGenerationJournal(now: () => Date = () => new Date()) {
  let attemptGeneration = 0;
  let activeGeneration: number | null = null;
  let inspection: LayerGenerationInspection | null = null;

  return {
    recordActivated(candidate: LayerActivationCandidate): LayerGenerationInspection {
      attemptGeneration += 1;
      activeGeneration = attemptGeneration;
      inspection = {
        attemptGeneration,
        activeGeneration,
        attemptedAt: now().toISOString(),
        ready: true,
        findings: [],
        layers: candidate.layers,
        provenance: candidate.provenance,
        advisories: candidate.advisories,
      };
      return inspection;
    },
    recordRejected(
      findings: LayerWriteFinding[],
      options: { affectsReadiness?: boolean } = {},
    ): LayerGenerationInspection {
      attemptGeneration += 1;
      const ready = options.affectsReadiness === false && activeGeneration !== null;
      inspection = {
        attemptGeneration,
        activeGeneration,
        attemptedAt: now().toISOString(),
        ready,
        findings: findings.map((finding) => ({
          reason: finding.reason,
          ...("layer" in finding && finding.layer !== undefined ? { layer: finding.layer } : {}),
          ...("message" in finding && finding.message !== undefined
            ? { message: finding.message }
            : {}),
        })),
        layers: inspection?.layers ?? [],
        provenance: inspection?.provenance ?? [],
        advisories: inspection?.advisories ?? [],
      };
      return inspection;
    },
    inspect: (): LayerGenerationInspection | null => inspection,
    readiness: () => ({
      ready: inspection?.ready ?? false,
      reason: inspection?.ready ? undefined : "managed-config-candidate-rejected",
      activeGeneration,
      attemptGeneration,
    }),
  };
}
