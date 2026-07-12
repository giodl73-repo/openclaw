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

export const resolveLocalConfigLayerSource: ResolveConfigLayerSource<
  LocalConfigLayerSource
> = async (source) => ({
  content: await fs.promises.readFile(source.path),
  sourceIdentity: source.identity,
});

export const parseLocalConfigLayerSource: ParseConfigLayerSource = (content) => {
  const parsed = parseConfigJson5(new TextDecoder().decode(content));
  if (!parsed.ok) {
    throw new Error(parsed.error);
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
  const resolveSource: ResolveConfigLayerSource<LocalConfigLayerSource> = async (source) => ({
    content: await ioFs.promises.readFile(source.path),
    sourceIdentity: source.identity,
  });

  const parseSource: ParseConfigLayerSource = (content, context) => {
    const descriptor = params.descriptors.find((candidate) => candidate.id === context.layerId);
    if (!descriptor) {
      throw new Error("unknown local managed configuration layer");
    }
    return resolveConfigSourceText(
      new TextDecoder().decode(content),
      descriptor.source.path,
      params.configIO,
      { resolveEnvironment: false },
    );
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
