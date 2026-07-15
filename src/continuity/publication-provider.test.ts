import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  getCurrentHostIntegrationBundleSnapshotV1,
} from "../hosting/host-integration-bundle.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
  ContinuityPublicationError,
  publishContinuityArtifactV1,
  retrieveContinuityArtifactV1,
  type ContinuityPublicationIdentityV1,
  type ContinuityPublicationProviderReferenceV1,
  type ContinuityPublicationProviderV1,
} from "./publication-provider.js";

type StoredArtifact = {
  identity: ContinuityPublicationIdentityV1;
  bytes: Uint8Array;
  acceptedAt: string;
};

const content = new TextEncoder().encode("continuity fixture");
const identity: ContinuityPublicationIdentityV1 = {
  ownerId: "tenant/cell-1",
  sourceRuntimeGeneration: "runtime-7",
  handoffId: "handoff-1",
  captureId: "capture-1",
  archiveSha256: createHash("sha256").update(content).digest("hex"),
  manifestSha256: "a".repeat(64),
  archiveSize: content.byteLength,
};

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
});

function createRegistry(): ReturnType<typeof createPluginRegistry> {
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
}

function registerProvider(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  provider: ContinuityPublicationProviderV1;
  registerBundle?: boolean;
}): ContinuityPublicationProviderReferenceV1 {
  const record = createPluginRecord({
    id: "example-host",
    name: "Example Host",
    source: "/plugins/example-host/index.js",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const api = params.registry.createApi(record, { config: {} as OpenClawConfig });
  api.registerContinuityPublicationProvider(params.provider);
  if (params.registerBundle !== false) {
    api.registerHostIntegrationBundle({
      version: "host-integration-bundle/v1",
      id: "example/host",
      bundleVersion: "1.0.0",
      contributions: [
        {
          owner: "continuity",
          kind: "continuity-publication-provider",
          id: params.provider.id,
          version: params.provider.version,
          required: true,
          readinessCriteria: ["continuity.publication.example"],
        },
      ],
    });
  }
  const snapshot =
    params.registerBundle === false ? undefined : getCurrentHostIntegrationBundleSnapshotV1();
  if (params.registerBundle !== false && !snapshot) {
    throw new Error("expected host integration bundle");
  }
  return {
    id: params.provider.id,
    version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
    generation: params.provider.generation,
    hostBundleGeneration: snapshot?.generation ?? "missing",
  };
}

function createFakeProvider(
  store: Map<string, StoredArtifact>,
  observedChunkSizes: number[],
): ContinuityPublicationProviderV1 {
  return {
    id: "example/continuity",
    version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
    generation: "binding-7",
    async publish({ identity: requested, content: source }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) {
        observedChunkSizes.push(chunk.byteLength);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const existing = store.get(requested.handoffId);
      if (existing) {
        if (existing.identity.archiveSha256 !== requested.archiveSha256) {
          throw Object.assign(new Error("digest conflict"), { code: "conflict" as const });
        }
        return {
          version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
          publicationId: `publication/${requested.handoffId}`,
          identity: existing.identity,
          durabilityClass: "immutable",
          acceptedAt: existing.acceptedAt,
        };
      }
      const acceptedAt = "2026-07-15T00:00:00.000Z";
      store.set(requested.handoffId, {
        identity: requested,
        bytes,
        acceptedAt,
      });
      return {
        version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
        publicationId: `publication/${requested.handoffId}`,
        identity: requested,
        durabilityClass: "immutable",
        acceptedAt,
      };
    },
    async retrieve({ receipt }) {
      const stored = store.get(receipt.identity.handoffId);
      if (!stored) {
        throw new Error("missing publication");
      }
      return {
        version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
        publicationId: receipt.publicationId,
        identity: stored.identity,
        content: (async function* () {
          yield stored.bytes.subarray(0, 4);
          yield stored.bytes.subarray(4);
        })(),
      };
    },
  };
}

async function* chunkedContent(): AsyncIterable<Uint8Array> {
  yield content.subarray(0, 3);
  yield content.subarray(3, 8);
  yield content.subarray(8);
}

describe("continuity publication provider", () => {
  it("rejects malformed and duplicate plugin registrations", () => {
    const registry = createRegistry();
    const record = createPluginRecord({
      id: "example-host",
      name: "Example Host",
      source: "/plugins/example-host/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = registry.createApi(record, { config: {} as OpenClawConfig });
    const provider = createFakeProvider(new Map(), []);

    api.registerContinuityPublicationProvider({ ...provider, generation: "" });
    api.registerContinuityPublicationProvider({ ...provider, generation: "build=7" });
    api.registerContinuityPublicationProvider({ ...provider, id: "Continuity" });
    api.registerContinuityPublicationProvider({
      ...provider,
      generation: 7 as unknown as string,
    });
    api.registerContinuityPublicationProvider(provider);
    api.registerContinuityPublicationProvider(provider);

    expect(registry.registry.continuityPublicationProviders).toHaveLength(1);
    expect(registry.registry.diagnostics.map((entry) => entry.message)).toEqual([
      "continuity publication provider registration is invalid",
      "continuity publication provider registration is invalid",
      "continuity publication provider registration is invalid",
      "continuity publication provider registration is invalid",
      "continuity publication provider already registered: example/continuity (example-host)",
    ]);
  });

  it("stores and resolves canonical provider binding values", async () => {
    const registry = createRegistry();
    const reference = registerProvider({
      registry,
      provider: {
        ...createFakeProvider(new Map(), []),
        generation: " binding-7 ",
      },
    });

    expect(reference.generation).toBe(" binding-7 ");
    expect(registry.registry.continuityPublicationProviders[0]?.provider.generation).toBe(
      "binding-7",
    );
    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference,
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      publicationBindingId: "example/continuity",
      publicationBindingGeneration: "binding-7",
    });
    const receipt = await publishContinuityArtifactV1({
      registry: registry.registry,
      reference,
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });
    const retrieval = await retrieveContinuityArtifactV1({
      registry: registry.registry,
      reference,
      receipt,
      signal: new AbortController().signal,
    });
    await expect(
      (async () => {
        for await (const chunk of retrieval.content) {
          void chunk;
        }
      })(),
    ).resolves.toBeUndefined();
  });

  it("preserves class-based provider methods and receiver state", async () => {
    class ClassProvider implements ContinuityPublicationProviderV1 {
      readonly id = "example/continuity";
      readonly version = CONTINUITY_PUBLICATION_PROVIDER_VERSION;
      readonly generation = "binding-7";
      private readonly provider = createFakeProvider(new Map(), []);

      publish(params: Parameters<ContinuityPublicationProviderV1["publish"]>[0]) {
        return this.provider.publish(params);
      }

      retrieve(params: Parameters<ContinuityPublicationProviderV1["retrieve"]>[0]) {
        return this.provider.retrieve(params);
      }
    }

    const registry = createRegistry();
    const reference = registerProvider({
      registry,
      provider: new ClassProvider(),
    });

    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference,
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ publicationId: "publication/handoff-1" });
  });

  it("rejects an id collision whose provider provenance differs from the bundle owner", async () => {
    const registry = createRegistry();
    const otherRecord = createPluginRecord({
      id: "other-host",
      name: "Other Host",
      source: "/plugins/other-host/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    registry
      .createApi(otherRecord, { config: {} as OpenClawConfig })
      .registerContinuityPublicationProvider(createFakeProvider(new Map(), []));
    const ownerRecord = createPluginRecord({
      id: "example-host",
      name: "Example Host",
      source: "/plugins/example-host/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const ownerApi = registry.createApi(ownerRecord, { config: {} as OpenClawConfig });
    ownerApi.registerHostIntegrationBundle({
      version: "host-integration-bundle/v1",
      id: "example/host",
      bundleVersion: "1.0.0",
      contributions: [
        {
          owner: "continuity",
          kind: "continuity-publication-provider",
          id: "example/continuity",
          version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
          required: true,
          readinessCriteria: ["continuity.publication.example"],
        },
      ],
    });
    const snapshot = getCurrentHostIntegrationBundleSnapshotV1();
    if (!snapshot) {
      throw new Error("expected host integration bundle");
    }

    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference: {
          id: "example/continuity",
          version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
          generation: "binding-7",
          hostBundleGeneration: snapshot.generation,
        },
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "provider-provenance-mismatch" });
  });

  it("publishes through one exact binding and retrieves through a fresh provider instance", async () => {
    const store = new Map<string, StoredArtifact>();
    const observedChunkSizes: number[] = [];
    const firstRegistry = createRegistry();
    const reference = registerProvider({
      registry: firstRegistry,
      provider: createFakeProvider(store, observedChunkSizes),
    });

    const receipt = await publishContinuityArtifactV1({
      registry: firstRegistry.registry,
      reference,
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });

    expect(observedChunkSizes).toEqual([3, 5, content.byteLength - 8]);
    expect(receipt).toMatchObject({
      publicationId: "publication/handoff-1",
      publicationBindingId: "example/continuity",
      publicationBindingGeneration: "binding-7",
      hostBundleGeneration: reference.hostBundleGeneration,
      identity,
    });

    const freshRegistry = createRegistry();
    registerProvider({
      registry: freshRegistry,
      provider: createFakeProvider(store, []),
      registerBundle: false,
    });
    const retrieval = await retrieveContinuityArtifactV1({
      registry: freshRegistry.registry,
      reference,
      receipt,
      signal: new AbortController().signal,
    });
    const retrievedChunks: Uint8Array[] = [];
    for await (const chunk of retrieval.content) {
      retrievedChunks.push(chunk);
    }
    const retrieved = Buffer.concat(retrievedChunks);
    expect(new Uint8Array(retrieved)).toEqual(content);
  });

  it.each([
    ["truncated", content.subarray(0, content.byteLength - 1)],
    ["changed", new TextEncoder().encode("continuity fixturf")],
  ])("rejects %s retrieved content", async (_case, corruptContent) => {
    const store = new Map<string, StoredArtifact>();
    const registry = createRegistry();
    const provider = createFakeProvider(store, []);
    provider.retrieve = async ({ receipt }) => ({
      version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
      publicationId: receipt.publicationId,
      identity: receipt.identity,
      content: (async function* () {
        yield corruptContent;
      })(),
    });
    const reference = registerProvider({ registry, provider });
    const receipt = await publishContinuityArtifactV1({
      registry: registry.registry,
      reference,
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });
    const retrieval = await retrieveContinuityArtifactV1({
      registry: registry.registry,
      reference,
      receipt,
      signal: new AbortController().signal,
    });

    await expect(
      (async () => {
        for await (const chunk of retrieval.content) {
          void chunk;
        }
      })(),
    ).rejects.toMatchObject({ code: "corrupt-retrieval" });
  });

  it("returns the original acceptance on exact replay and conflicts on changed content", async () => {
    const registry = createRegistry();
    const reference = registerProvider({
      registry,
      provider: createFakeProvider(new Map(), []),
    });
    const request = {
      registry: registry.registry,
      reference,
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    };

    const first = await publishContinuityArtifactV1(request);
    const replay = await publishContinuityArtifactV1({
      ...request,
      content: chunkedContent(),
    });
    expect(replay).toEqual(first);

    await expect(
      publishContinuityArtifactV1({
        ...request,
        identity: {
          ...identity,
          archiveSha256: "b".repeat(64),
        },
        content: chunkedContent(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails closed on stale provider and host-bundle generations", async () => {
    const registry = createRegistry();
    const reference = registerProvider({
      registry,
      provider: createFakeProvider(new Map(), []),
    });

    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference: { ...reference, generation: "binding-8" },
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "stale-provider-generation" });

    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference: { ...reference, hostBundleGeneration: "example/host@1.0.0#stale" },
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "stale-host-bundle-generation" });
  });

  it("rejects mismatched acceptance evidence", async () => {
    const registry = createRegistry();
    const provider = createFakeProvider(new Map(), []);
    provider.publish = async () => ({
      version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
      publicationId: "publication/handoff-1",
      identity: { ...identity, captureId: "capture-2" },
      durabilityClass: "immutable",
      acceptedAt: "2026-07-15T00:00:00.000Z",
    });
    const reference = registerProvider({ registry, provider });

    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference,
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ContinuityPublicationError>>({
        code: "invalid-acceptance",
      }),
    );
  });

  it.each([
    ["missing acceptance", undefined, "invalid-acceptance"],
    [
      "malformed acceptance field",
      {
        version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
        publicationId: 7,
        identity,
        durabilityClass: "immutable",
        acceptedAt: "2026-07-15T00:00:00.000Z",
      },
      "invalid-acceptance",
    ],
    [
      "non-immutable acceptance",
      {
        version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
        publicationId: "publication/handoff-1",
        identity,
        durabilityClass: "ephemeral",
        acceptedAt: "2026-07-15T00:00:00.000Z",
      },
      "invalid-acceptance",
    ],
  ])("classifies %s as structured provider evidence failure", async (_case, acceptance, code) => {
    const registry = createRegistry();
    const provider = createFakeProvider(new Map(), []);
    provider.publish = async () =>
      acceptance as unknown as Awaited<ReturnType<ContinuityPublicationProviderV1["publish"]>>;
    const reference = registerProvider({ registry, provider });

    await expect(
      publishContinuityArtifactV1({
        registry: registry.registry,
        reference,
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("classifies a malformed retrieval as structured provider evidence failure", async () => {
    const registry = createRegistry();
    const provider = createFakeProvider(new Map(), []);
    provider.retrieve = async () =>
      undefined as unknown as Awaited<ReturnType<ContinuityPublicationProviderV1["retrieve"]>>;
    const reference = registerProvider({ registry, provider });
    const receipt = await publishContinuityArtifactV1({
      registry: registry.registry,
      reference,
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });

    await expect(
      retrieveContinuityArtifactV1({
        registry: registry.registry,
        reference,
        receipt,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid-retrieval" });
  });

  it("rejects a persisted receipt without immutable durability evidence", async () => {
    const registry = createRegistry();
    const reference = registerProvider({
      registry,
      provider: createFakeProvider(new Map(), []),
    });
    const receipt = await publishContinuityArtifactV1({
      registry: registry.registry,
      reference,
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });

    await expect(
      retrieveContinuityArtifactV1({
        registry: registry.registry,
        reference,
        receipt: { ...receipt, durabilityClass: "ephemeral" as "immutable" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid-acceptance" });
  });
});
