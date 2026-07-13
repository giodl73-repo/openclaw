import { createHash } from "node:crypto";
import type { ConfigLayer } from "./layer-composition.js";

export type ConfigLayerAccess = "read-only" | "read-write";

export type ConfigLayerDescriptor<Source> = {
  id: string;
  source: Source;
  access: ConfigLayerAccess;
  contractVersion: 1;
  expectedDigest?: `sha256:${string}`;
};

export type ResolvedConfigLayer = ConfigLayer & {
  access: ConfigLayerAccess;
  sourceIdentity: string;
  sourceGenerationIdentity?: string;
  contentDigest: `sha256:${string}`;
};

export type ConfigLayerSourceFinding = {
  reason:
    | "EmptyLayerId"
    | "DuplicateLayerId"
    | "UnsupportedLayerContractVersion"
    | "InvalidExpectedDigest"
    | "LayerSourceResolutionFailed"
    | "LayerSourceDigestMismatch"
    | "LayerSourceParseFailed";
  layer: string;
  message?: string;
  expectedDigest?: string;
  actualDigest?: string;
};

export type ResolveConfigLayerSource<Source> = (
  source: Source,
  context: { layerId: string },
) => Promise<{
  content: string | Uint8Array;
  sourceIdentity: string;
  sourceGenerationIdentity?: string;
}>;

export type ParseConfigLayerSource = (
  content: Uint8Array,
  context: { layerId: string; sourceIdentity: string; source?: unknown },
) => unknown | Promise<unknown>;

export type ResolveConfigLayerSourcesResult =
  | { valid: true; layers: ResolvedConfigLayer[] }
  | { valid: false; findings: ConfigLayerSourceFinding[] };

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function sourceBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function resolveConfigLayerSources<Source>(
  descriptors: readonly ConfigLayerDescriptor<Source>[],
  resolveSource: ResolveConfigLayerSource<Source>,
  parseSource: ParseConfigLayerSource,
): Promise<ResolveConfigLayerSourcesResult> {
  const findings: ConfigLayerSourceFinding[] = [];
  const seen = new Set<string>();

  for (const descriptor of descriptors) {
    if (!descriptor.id.trim()) {
      findings.push({ reason: "EmptyLayerId", layer: descriptor.id });
    } else if (seen.has(descriptor.id)) {
      findings.push({ reason: "DuplicateLayerId", layer: descriptor.id });
    }
    seen.add(descriptor.id);
    if (descriptor.contractVersion !== 1) {
      findings.push({
        reason: "UnsupportedLayerContractVersion",
        layer: descriptor.id,
        message: `unsupported layer contract version ${String(descriptor.contractVersion)}`,
      });
    }
    if (
      descriptor.expectedDigest !== undefined &&
      !SHA256_DIGEST_PATTERN.test(descriptor.expectedDigest)
    ) {
      findings.push({
        reason: "InvalidExpectedDigest",
        layer: descriptor.id,
        expectedDigest: descriptor.expectedDigest,
      });
    }
  }

  if (findings.length > 0) {
    return { valid: false, findings };
  }

  const outcomes = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        const resolved = await resolveSource(descriptor.source, { layerId: descriptor.id });
        const content = sourceBytes(resolved.content);
        const contentDigest = sha256(content);
        if (
          descriptor.expectedDigest !== undefined &&
          descriptor.expectedDigest !== contentDigest
        ) {
          return {
            finding: {
              reason: "LayerSourceDigestMismatch" as const,
              layer: descriptor.id,
              expectedDigest: descriptor.expectedDigest,
              actualDigest: contentDigest,
            },
          };
        }
        try {
          const config = await parseSource(content, {
            layerId: descriptor.id,
            sourceIdentity: resolved.sourceIdentity,
            source: descriptor.source,
          });
          return {
            layer: {
              id: descriptor.id,
              config,
              access: descriptor.access,
              sourceIdentity: resolved.sourceIdentity,
              ...(resolved.sourceGenerationIdentity
                ? { sourceGenerationIdentity: resolved.sourceGenerationIdentity }
                : {}),
              contentDigest,
            },
          };
        } catch (error) {
          return {
            finding: {
              reason: "LayerSourceParseFailed" as const,
              layer: descriptor.id,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      } catch (error) {
        return {
          finding: {
            reason: "LayerSourceResolutionFailed" as const,
            layer: descriptor.id,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );

  const sourceFindings = outcomes.flatMap((outcome) => (outcome.finding ? [outcome.finding] : []));
  if (sourceFindings.length > 0) {
    return { valid: false, findings: sourceFindings };
  }
  return {
    valid: true,
    layers: outcomes.flatMap((outcome) => (outcome.layer ? [outcome.layer] : [])),
  };
}
