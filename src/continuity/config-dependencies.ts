import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  readConfigIncludeFileWithGuards,
  resolveConfigIncludes,
  type IncludeResolver,
} from "../config/includes.js";
import { resolveIncludeRoots } from "../config/paths.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import type { ConfigUiHints } from "../config/schema.js";
import { coerceSecretRef, type SecretRefSource } from "../config/types.secrets.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

export type ContinuityConfigBlockerCode =
  | "continuity.config.malformed"
  | "continuity.config.include_unresolved"
  | "continuity.config.extension_metadata_incomplete"
  | "continuity.config.literal_sensitive_values";

export type ContinuityConfigDependencyEvidence = {
  includeFileCount: number;
  secretReferenceCount: number;
  secretReferencesBySource: Record<SecretRefSource, number>;
  literalSensitiveValueCount: number;
};

export type ContinuityConfigDependencyAssessment = {
  eligible: boolean;
  blockers: Array<{
    code: ContinuityConfigBlockerCode;
    count: number;
  }>;
  evidence: ContinuityConfigDependencyEvidence;
};

export type ContinuityConfigCapturePreparation = {
  assessment: ContinuityConfigDependencyAssessment;
  includedFiles: Array<{
    path: string;
    sha256: string;
  }>;
};

type InspectContinuityConfigDependenciesParams = {
  configPath: string;
  raw: string;
  uiHints: ConfigUiHints;
  extensionMetadataComplete: boolean;
  env?: NodeJS.ProcessEnv;
  allowedRoots?: readonly string[];
};

const ENV_PLACEHOLDER_SHAPE = /^\$\{[^}]*\}$/;

function exposeUnsupportedPlaceholders(value: unknown): unknown {
  if (
    typeof value === "string" &&
    ENV_PLACEHOLDER_SHAPE.test(value.trim()) &&
    coerceSecretRef(value) === null
  ) {
    return "__OPENCLAW_UNSUPPORTED_ENV_PLACEHOLDER__";
  }
  if (Array.isArray(value)) {
    return value.map(exposeUnsupportedPlaceholders);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, exposeUnsupportedPlaceholders(child)]),
    );
  }
  return value;
}

function emptyEvidence(): ContinuityConfigDependencyEvidence {
  return {
    includeFileCount: 0,
    secretReferenceCount: 0,
    secretReferencesBySource: {
      env: 0,
      file: 0,
      exec: 0,
    },
    literalSensitiveValueCount: 0,
  };
}

function countDependencies(
  authored: unknown,
  redacted: unknown,
  evidence: ContinuityConfigDependencyEvidence,
): void {
  const secretRef = coerceSecretRef(authored);
  if (secretRef) {
    evidence.secretReferenceCount += 1;
    evidence.secretReferencesBySource[secretRef.source] += 1;
    return;
  }

  if (redacted === REDACTED_SENTINEL) {
    evidence.literalSensitiveValueCount += 1;
    return;
  }

  if (Array.isArray(authored)) {
    const redactedItems = Array.isArray(redacted) ? redacted : [];
    authored.forEach((item, index) => {
      countDependencies(item, redactedItems[index], evidence);
    });
    return;
  }

  if (authored && typeof authored === "object") {
    const redactedRecord =
      redacted && typeof redacted === "object" && !Array.isArray(redacted)
        ? (redacted as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(authored)) {
      countDependencies(value, redactedRecord[key], evidence);
    }
  }
}

function classifyResolvedConfig(params: {
  config: unknown;
  uiHints: ConfigUiHints;
  extensionMetadataComplete: boolean;
  includeFileCount: number;
}): ContinuityConfigDependencyAssessment {
  const evidence = emptyEvidence();
  evidence.includeFileCount = params.includeFileCount;
  const classificationInput = exposeUnsupportedPlaceholders(params.config);
  const redacted = redactConfigObject(classificationInput, params.uiHints);
  countDependencies(params.config, redacted, evidence);

  const blockers: ContinuityConfigDependencyAssessment["blockers"] = [];
  if (!params.extensionMetadataComplete) {
    blockers.push({
      code: "continuity.config.extension_metadata_incomplete",
      count: 1,
    });
  }
  if (evidence.literalSensitiveValueCount > 0) {
    blockers.push({
      code: "continuity.config.literal_sensitive_values",
      count: evidence.literalSensitiveValueCount,
    });
  }
  return {
    eligible: blockers.length === 0,
    blockers,
    evidence,
  };
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function resolveConfigAndCollectIncludes(params: {
  configPath: string;
  parsed: unknown;
  env?: NodeJS.ProcessEnv;
  allowedRoots?: readonly string[];
}): { config: unknown; includedFiles: Array<{ path: string; sha256: string }> } {
  const includedFiles = new Map<string, string>();
  const resolver: IncludeResolver = {
    readFile: (candidate) => fs.readFileSync(candidate, "utf-8"),
    readFileWithGuards: (readParams) => {
      let includedPath: string | undefined;
      const raw = readConfigIncludeFileWithGuards({
        ...readParams,
        onResolvedPath: (resolvedPath) => {
          includedPath = resolvedPath;
        },
      });
      if (!includedPath) {
        throw new Error("Config include resolved without a canonical path");
      }
      includedFiles.set(includedPath, sha256(raw));
      return raw;
    },
    parseJson: (raw) => parseJsonWithJson5Fallback(raw),
  };
  const config = resolveConfigIncludes(params.parsed, params.configPath, resolver, {
    allowedRoots: params.allowedRoots ?? resolveIncludeRoots(params.env),
  });
  return {
    config,
    includedFiles: [...includedFiles]
      .map(([path, digest]) => ({ path, sha256: digest }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  };
}

/**
 * Classify a config recovery artifact without resolving SecretRefs or
 * environment placeholders to their secret bytes.
 */
export function prepareContinuityConfigCapture(
  params: InspectContinuityConfigDependenciesParams,
): ContinuityConfigCapturePreparation {
  let parsed: unknown;
  try {
    parsed = parseJsonWithJson5Fallback(params.raw);
  } catch {
    return {
      assessment: {
        eligible: false,
        blockers: [{ code: "continuity.config.malformed", count: 1 }],
        evidence: emptyEvidence(),
      },
      includedFiles: [],
    };
  }

  let resolved: {
    config: unknown;
    includedFiles: Array<{ path: string; sha256: string }>;
  };
  try {
    resolved = resolveConfigAndCollectIncludes({
      configPath: params.configPath,
      parsed,
      env: params.env,
      allowedRoots: params.allowedRoots,
    });
  } catch {
    return {
      assessment: {
        eligible: false,
        blockers: [{ code: "continuity.config.include_unresolved", count: 1 }],
        evidence: emptyEvidence(),
      },
      includedFiles: [],
    };
  }

  return {
    assessment: classifyResolvedConfig({
      config: resolved.config,
      uiHints: params.uiHints,
      extensionMetadataComplete: params.extensionMetadataComplete,
      includeFileCount: resolved.includedFiles.length,
    }),
    includedFiles: resolved.includedFiles,
  };
}

export function inspectContinuityConfigDependencies(
  params: InspectContinuityConfigDependenciesParams,
): ContinuityConfigDependencyAssessment {
  return prepareContinuityConfigCapture(params).assessment;
}
