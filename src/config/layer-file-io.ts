import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseConfigJson5, resolveConfigSourceText } from "./io.js";
import { createManagedConfigIO } from "./layer-io.js";
import type { PersistConfigLayer } from "./layer-management.js";
import type { LayerActivationCandidate } from "./layer-runtime.js";
import type {
  ConfigLayerDescriptor,
  ParseConfigLayerSource,
  ResolveConfigLayerSource,
} from "./layer-sources.js";
import type { OpenClawConfig } from "./types.js";

export type LocalConfigLayerSource = { path: string; identity: string };
function collectRemovedPaths(
  current: unknown,
  proposed: unknown,
  prefix: string[] = [],
): string[][] {
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !proposed ||
    typeof proposed !== "object" ||
    Array.isArray(proposed)
  ) {
    return [];
  }
  const proposedRecord = proposed as Record<string, unknown>;
  return Object.entries(current as Record<string, unknown>).flatMap(([key, value]) => {
    const candidatePath = [...prefix, key];
    return Object.hasOwn(proposedRecord, key)
      ? collectRemovedPaths(value, proposedRecord[key], candidatePath)
      : [candidatePath];
  });
}

function sha256(content: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function resolveLocalSourceGeneration(
  content: Uint8Array,
  configPath: string,
  overrides: Parameters<typeof resolveConfigSourceText>[2] = {},
): string | undefined {
  const includeFileHashes: Record<string, string> = {};
  resolveConfigSourceText(new TextDecoder().decode(content), configPath, overrides, {
    resolveEnvironment: false,
    includeFileHashes,
  });
  const includeGeneration = Object.entries(includeFileHashes).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return includeGeneration.length > 0 ? sha256(JSON.stringify(includeGeneration)) : undefined;
}

export const resolveLocalConfigLayerSource: ResolveConfigLayerSource<
  LocalConfigLayerSource
> = async (source) => {
  const content = await fs.promises.readFile(source.path);
  const sourceGenerationIdentity = resolveLocalSourceGeneration(content, source.path);
  return {
    content,
    sourceIdentity: source.identity,
    ...(sourceGenerationIdentity ? { sourceGenerationIdentity } : {}),
  };
};

export const parseLocalConfigLayerSource: ParseConfigLayerSource = (content, context) => {
  const raw = new TextDecoder().decode(content);
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const source = context.source;
  if (source && typeof source === "object" && "path" in source && typeof source.path === "string") {
    const resolved = resolveConfigSourceText(
      raw,
      source.path,
      {},
      {
        resolveEnvironment: false,
        requireObjectRoot: true,
      },
    );
    const declared = { ...resolved };
    delete declared.meta;
    return declared;
  }
  return parsed.parsed;
};

/** Uses the ordinary primary config file as the one writable local layer. */
export function createLocalFileManagedConfigIO(params: {
  descriptors: readonly ConfigLayerDescriptor<LocalConfigLayerSource>[];
  publish: (candidate: LayerActivationCandidate) => void | Promise<void>;
  configIO?: Parameters<typeof createManagedConfigIO<LocalConfigLayerSource>>[0]["configIO"];
}) {
  const ioFs = params.configIO?.fs ?? fs;
  const resolveSource: ResolveConfigLayerSource<LocalConfigLayerSource> = async (source) => {
    const content = await ioFs.promises.readFile(source.path);
    const sourceGenerationIdentity = resolveLocalSourceGeneration(
      content,
      source.path,
      params.configIO,
    );
    return {
      content,
      sourceIdentity: source.identity,
      ...(sourceGenerationIdentity ? { sourceGenerationIdentity } : {}),
    };
  };

  const parseSource: ParseConfigLayerSource = (content, context) => {
    const descriptor = params.descriptors.find((candidate) => candidate.id === context.layerId);
    if (!descriptor) {
      throw new Error("unknown local managed configuration layer");
    }
    const raw = new TextDecoder().decode(content);
    const parsed = parseConfigJson5(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    if (!parsed.parsed || typeof parsed.parsed !== "object" || Array.isArray(parsed.parsed)) {
      throw new Error("managed layer root must contain a config object");
    }
    const resolved = resolveConfigSourceText(raw, descriptor.source.path, params.configIO, {
      resolveEnvironment: false,
      requireObjectRoot: true,
    });
    const declared = { ...resolved };
    delete declared.meta;
    return declared;
  };

  const persist: PersistConfigLayer<LocalConfigLayerSource> = async (persistence) => {
    if (path.resolve(persistence.source.path) !== path.resolve(facade.configIO.configPath)) {
      throw new Error("the writable managed layer must target the primary OpenClaw config file");
    }
    const prepared = await facade.configIO.readConfigFileSnapshotForWrite();
    const raw = prepared.snapshot.raw ?? "";
    if (sha256(raw) !== persistence.expectedTargetDigest) {
      throw new Error("primary config changed before persistence; reload and retry");
    }
    const parsed = parseConfigJson5(new TextDecoder().decode(persistence.content));
    if (
      !parsed.ok ||
      !parsed.parsed ||
      typeof parsed.parsed !== "object" ||
      Array.isArray(parsed.parsed)
    ) {
      throw new Error(parsed.ok ? "writable layer must contain a config object" : parsed.error);
    }
    await facade.configIO.writeConfigFile(parsed.parsed as OpenClawConfig, {
      ...prepared.writeOptions,
      baseSnapshot: prepared.snapshot,
      unsetPaths: collectRemovedPaths(prepared.snapshot.parsed, parsed.parsed),
      // writeConfigLayer validated the complete composed candidate and guarded
      // this replacement with the target digest. Higher layers may intentionally
      // make standalone clobber checks inapplicable to this sparse document.
      validationMode: "already-validated",
      runtimePreflightSourceConfig: persistence.effectiveSourceConfig as OpenClawConfig,
      preserveEnvReferences: false,
      persistenceMode: "replace",
      allowDestructiveWrite: true,
      allowConfigSizeDrop: true,
    });
    return { persistedContent: await ioFs.promises.readFile(facade.configIO.configPath) };
  };

  const facade = createManagedConfigIO({
    descriptors: params.descriptors,
    resolveSource,
    parseSource,
    persist,
    publish: params.publish,
    configIO: params.configIO,
  });
  return facade;
}
