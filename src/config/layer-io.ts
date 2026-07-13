import { createConfigIO } from "./io.js";
import {
  createLayerGenerationJournal,
  identifyAuthorityChain,
  writeConfigLayer,
  type LayerWriteFinding,
  type LayerWriteResult,
  type PersistConfigLayer,
} from "./layer-management.js";
import {
  activateLayeredRuntimeConfig,
  type LayerActivationCandidate,
  type LayerActivationResult,
} from "./layer-runtime.js";
import {
  resolveConfigLayerSources,
  type ConfigLayerDescriptor,
  type ParseConfigLayerSource,
  type ResolveConfigLayerSource,
} from "./layer-sources.js";

type LayerGenerationJournal = ReturnType<typeof createLayerGenerationJournal>;

let registeredJournal: LayerGenerationJournal | null = null;

export type ManagedConfigReadiness = {
  ready: boolean;
  reason?: string;
  activeGeneration: number | null;
  attemptGeneration: number;
};

export type ManagedConfigIO = {
  configIO: ReturnType<typeof createConfigIO>;
  activate: () => Promise<LayerActivationResult>;
  write: (params: {
    targetLayerId: string;
    proposedContent: string | Uint8Array;
    expectedTargetDigest: string;
    expectedAuthorityChainIdentity: string;
  }) => Promise<LayerWriteResult>;
  inspect: LayerGenerationJournal["inspect"];
  readiness: () => ManagedConfigReadiness;
};

export function getManagedConfigReadiness(): ManagedConfigReadiness | null {
  return registeredJournal?.readiness() ?? null;
}

export function resetManagedConfigIOForTest(): void {
  registeredJournal = null;
}

/**
 * Creates the opt-in managed facade at the existing config I/O boundary.
 * Constructing this facade is the only operation that registers managed readiness.
 */
export function createManagedConfigIO<Source>(params: {
  descriptors: readonly ConfigLayerDescriptor<Source>[];
  resolveSource: ResolveConfigLayerSource<Source>;
  parseSource: ParseConfigLayerSource;
  persist: PersistConfigLayer<Source>;
  publish: (candidate: LayerActivationCandidate) => void | Promise<void>;
  configIO?: Parameters<typeof createConfigIO>[0];
}): ManagedConfigIO {
  if (registeredJournal !== null) {
    throw new Error("managed configuration I/O is already registered for this process");
  }
  const configIO = createConfigIO(params.configIO);
  const journal = createLayerGenerationJournal();
  registeredJournal = journal;

  async function activate(): Promise<LayerActivationResult> {
    const result = await activateLayeredRuntimeConfig({
      descriptors: params.descriptors,
      resolveSource: params.resolveSource,
      parseSource: params.parseSource,
      publish: params.publish,
      configIO: params.configIO,
    });
    if (result.valid) {
      journal.recordActivated(result.candidate);
    } else {
      journal.recordRejected(result.findings as LayerWriteFinding[]);
    }
    return result;
  }

  async function persistWithCurrentChainCheck(
    persistence: Parameters<PersistConfigLayer<Source>>[0],
  ): Promise<{ persistedContent: string | Uint8Array }> {
    const current = await resolveConfigLayerSources(
      params.descriptors,
      params.resolveSource,
      params.parseSource,
    );
    if (!current.valid) {
      throw new Error("managed configuration chain changed before persistence");
    }
    const target = current.layers.find((layer) => layer.id === persistence.targetLayerId);
    if (
      !target ||
      target.contentDigest !== persistence.expectedTargetDigest ||
      identifyAuthorityChain(current.layers) !== persistence.expectedAuthorityChainIdentity
    ) {
      throw new Error("managed configuration chain changed before persistence; reload and retry");
    }
    return await params.persist(persistence);
  }

  async function write(writeParams: {
    targetLayerId: string;
    proposedContent: string | Uint8Array;
    expectedTargetDigest: string;
    expectedAuthorityChainIdentity: string;
  }) {
    const result = await writeConfigLayer({
      descriptors: params.descriptors,
      ...writeParams,
      resolveSource: params.resolveSource,
      parseSource: params.parseSource,
      persist: persistWithCurrentChainCheck,
      publish: params.publish,
      configIO: params.configIO,
    });
    if (result.valid) {
      journal.recordActivated(result.candidate);
    } else {
      journal.recordRejected(result.findings, {
        affectsReadiness: result.persisted !== undefined,
      });
    }
    return result;
  }

  return {
    configIO,
    activate,
    write,
    inspect: journal.inspect,
    readiness: journal.readiness,
  };
}
