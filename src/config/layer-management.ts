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
  | { reason: "UnknownTargetLayer" | "ReadOnlyLayer"; layer: string }
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
}) =>
  | void
  | { persistedContent: string | Uint8Array }
  | Promise<void | { persistedContent: string | Uint8Array }>;

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
      layers: layers.map((layer) => ({
        id: layer.id,
        access: layer.access,
        sourceIdentity: layer.sourceIdentity,
        contentDigest: layer.contentDigest,
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

  let persistedContent: string | Uint8Array | undefined;
  try {
    const persistence = await params.persist({
      targetLayerId: target.id,
      source: descriptor.source,
      content,
      expectedTargetDigest: params.expectedTargetDigest,
      expectedAuthorityChainIdentity: params.expectedAuthorityChainIdentity,
    });
    persistedContent = persistence?.persistedContent;
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

  let persistedCandidate = prepared.candidate;
  if (persistedContent !== undefined) {
    const committedContent = bytes(persistedContent);
    const committedDigest = digest(committedContent);
    proposedLayers[targetIndex] = {
      ...proposedLayers[targetIndex],
      contentDigest: committedDigest,
    };
    try {
      const committedConfig = await params.parseSource(committedContent, {
        layerId: target.id,
        sourceIdentity: target.sourceIdentity,
      });
      proposedLayers[targetIndex] = {
        ...target,
        config: committedConfig,
        contentDigest: committedDigest,
      };
      const committed = activationCandidate(proposedLayers, params.configIO);
      if (!committed.valid) {
        return {
          valid: false,
          findings: committed.findings,
          persisted: {
            targetDigest: proposedLayers[targetIndex].contentDigest,
            authorityChainIdentity: identifyAuthorityChain(proposedLayers),
          },
        };
      }
      persistedCandidate = committed.candidate;
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
          authorityChainIdentity: identifyAuthorityChain(proposedLayers),
        },
      };
    }
  }
  const persistedAuthorityChainIdentity = identifyAuthorityChain(proposedLayers);

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
        targetDigest: proposedLayers[targetIndex].contentDigest,
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
          ...(finding.layer !== undefined ? { layer: finding.layer } : {}),
          ...(finding.message !== undefined ? { message: finding.message } : {}),
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
