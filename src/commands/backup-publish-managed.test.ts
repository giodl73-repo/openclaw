import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
} from "../continuity/publication-provider.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  executeManagedPublicationRetrieval,
  executeManagedPublication,
  parseManagedPublicationRequest,
  type ManagedPublicationHooks,
  type ManagedPublicationRequest,
} from "./backup-publish-managed.js";

const mocks = vi.hoisted(() => ({
  verifyBackupArchive: vi.fn(),
}));

vi.mock("./backup-verify.js", () => ({
  DEFAULT_BACKUP_VERIFY_MAX_CONTENT_BYTES: 1024 * 1024,
  verifyBackupArchive: mocks.verifyBackupArchive,
}));

const tempDirs: string[] = [];

async function createRequest(): Promise<{
  request: ManagedPublicationRequest;
  bytes: Buffer;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-publication-"));
  tempDirs.push(root);
  const archivePath = path.join(root, "continuity.tar.gz");
  const bytes = Buffer.from("portable continuity archive");
  await fs.writeFile(archivePath, bytes);
  return {
    bytes,
    request: {
      version: "continuity-managed-publication/v1",
      receipt: {
        ownerId: `sha256:${"1".repeat(64)}`,
        ownerGeneration: "runtime-7",
        handoffIdentity: "handoff-7",
        captureIdentity: "capture-7",
        executionIncarnationIdentity: `sha256:${"2".repeat(64)}`,
        archivePath,
        archiveSha256: createHash("sha256").update(bytes).digest("hex"),
        archiveSize: bytes.byteLength,
        manifestSha256: "a".repeat(64),
      },
      provider: {
        pluginId: "example-continuity",
        id: "example/continuity",
        version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
        generation: "provider-7",
      },
    },
  };
}

function createHooks(bytes: Buffer) {
  const registries = [createEmptyPluginRegistry(), createEmptyPluginRegistry()];
  const reference = {
    pluginId: "example-continuity",
    id: "example/continuity",
    version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
    generation: "provider-7",
  } as const;
  const resolveProviderRuntime = vi
    .fn<NonNullable<ManagedPublicationHooks["resolveProviderRuntime"]>>()
    .mockReturnValueOnce({
      pluginId: reference.pluginId,
      registry: registries[0],
      reference,
    })
    .mockReturnValueOnce({
      pluginId: reference.pluginId,
      registry: registries[1],
      reference,
    });
  const stops = [vi.fn(), vi.fn()];
  const startServices = vi
    .fn<NonNullable<ManagedPublicationHooks["startServices"]>>()
    .mockResolvedValueOnce({ stop: stops[0] })
    .mockResolvedValueOnce({ stop: stops[1] });
  let published = Buffer.alloc(0);
  const publish = vi.fn<NonNullable<ManagedPublicationHooks["publish"]>>(async (params) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of params.content) {
      chunks.push(chunk);
    }
    published = Buffer.concat(chunks);
    return {
      version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
      publicationId: "publication/handoff-7",
      identity: params.identity,
      durabilityClass: "immutable",
      acceptedAt: "2026-07-15T00:00:00.000Z",
      publicationPluginId: params.reference.pluginId,
      publicationBindingId: params.reference.id,
      publicationBindingVersion: params.reference.version,
      publicationBindingGeneration: params.reference.generation,
    };
  });
  const retrieve = vi.fn<NonNullable<ManagedPublicationHooks["retrieve"]>>(async (params) => ({
    version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
    publicationId: params.receipt.publicationId,
    identity: params.receipt.identity,
    content: (async function* () {
      yield published.subarray(0, 5);
      yield published.subarray(5);
    })(),
  }));
  const hooks: ManagedPublicationHooks = {
    resolveRuntimeContext: async () => ({
      config: {
        continuity: {
          level: "portable",
          publicationProvider: "example/continuity",
        },
      },
      workspaceDir: path.resolve("workspace"),
    }),
    resolveProviderRuntime,
    startServices,
    publish,
    retrieve,
  };
  hooks.runFreshRetrieval = async ({ request, acceptance }) => {
    await executeManagedPublicationRetrieval(
      {
        version: "continuity-managed-publication-retrieval/v1",
        ownerId: request.receipt.ownerId,
        identity: {
          ownerId: request.receipt.ownerId,
          sourceRuntimeGeneration: request.receipt.ownerGeneration,
          handoffId: request.receipt.handoffIdentity,
          captureId: request.receipt.captureIdentity,
          archiveSha256: request.receipt.archiveSha256,
          archiveSize: request.receipt.archiveSize,
          manifestSha256: request.receipt.manifestSha256,
        },
        provider: request.provider,
        acceptance,
      },
      hooks,
    );
  };
  return {
    hooks,
    registries,
    resolveProviderRuntime,
    startServices,
    stops,
    published: () => published,
    bytes,
  };
}

beforeEach(() => {
  mocks.verifyBackupArchive.mockReset();
  mocks.verifyBackupArchive.mockResolvedValue({
    result: { manifestSha256: "a".repeat(64) },
  });
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("managed continuity publication", () => {
  it("publishes on one registry and freshly retrieves through a second registry", async () => {
    const { request, bytes } = await createRequest();
    const fixture = createHooks(bytes);

    const result = await executeManagedPublication(request, fixture.hooks);

    expect(result).toMatchObject({
      ok: true,
      acceptance: {
        publicationPluginId: "example-continuity",
        publicationBindingId: "example/continuity",
        publicationBindingVersion: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
        publicationBindingGeneration: "provider-7",
      },
    });
    expect(fixture.resolveProviderRuntime).toHaveBeenCalledTimes(2);
    expect(fixture.startServices.mock.calls.map((call) => call[0].registry)).toEqual(
      fixture.registries,
    );
    expect(fixture.stops[0]).toHaveBeenCalledOnce();
    expect(fixture.stops[1]).toHaveBeenCalledOnce();
    expect(fixture.published()).toEqual(bytes);
    expect(mocks.verifyBackupArchive).toHaveBeenCalledTimes(2);
  });

  it("quarantines changed plugin ownership before provider execution", async () => {
    const { request, bytes } = await createRequest();
    const fixture = createHooks(bytes);
    request.provider.pluginId = "replacement-continuity";

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_stale",
      disposition: "quarantine",
      causeCode: "provider-provenance-mismatch",
    });
    expect(fixture.startServices).not.toHaveBeenCalled();
  });

  it("preserves the provider failure when service cleanup also fails", async () => {
    const { request, bytes } = await createRequest();
    const fixture = createHooks(bytes);
    fixture.hooks.publish = async () => {
      throw Object.assign(new Error("conflicting publication"), { code: "conflict" });
    };
    fixture.stops[0].mockRejectedValueOnce(new Error("service cleanup failed"));

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_conflict",
      disposition: "quarantine",
      causeCode: "conflict",
    });
  });

  it("stops services that finish starting after the operation deadline", async () => {
    const { request, bytes } = await createRequest();
    const fixture = createHooks(bytes);
    let resolveLateStart: ((services: { stop: () => Promise<void> }) => void) | undefined;
    const lateStop = vi.fn(async () => {});
    fixture.hooks.operationTimeoutMs = 20;
    fixture.hooks.startServices = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLateStart = resolve;
        }),
    );

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_unavailable",
      disposition: "retry-same-publication",
      causeCode: "unavailable",
    });

    resolveLateStart?.({ stop: lateStop });
    await vi.waitFor(() => expect(lateStop).toHaveBeenCalledOnce());
  });

  it("rejects an oversized source before copying it into temporary storage", async () => {
    const { request, bytes } = await createRequest();
    const fixture = createHooks(bytes);
    await fs.writeFile(request.receipt.archivePath, Buffer.alloc(1024 * 1024 + 1));

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "archive",
      code: "continuity.publication.resource_exhausted",
      disposition: "hold",
    });
    expect(fixture.startServices).not.toHaveBeenCalled();
  });

  it("rejects the obsolete host-bundle request shape", async () => {
    const { request } = await createRequest();
    expect(() =>
      parseManagedPublicationRequest(
        JSON.stringify({
          ...request,
          provider: {
            id: request.provider.id,
            version: request.provider.version,
            generation: request.provider.generation,
            hostBundleIdentity: "example/host@1.0.0",
          },
        }),
      ),
    ).toThrow(/unknown or missing/u);
  });
});
