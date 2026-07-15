import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
  CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
  ContinuityPublicationError,
  type ContinuityPublicationAcceptanceReceiptV1,
} from "../continuity/publication-provider.js";
import {
  clearCurrentHostIntegrationBundleSnapshotV1,
  getCurrentHostIntegrationBundleSnapshotV1,
} from "../hosting/host-integration-bundle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  executeManagedPublication,
  parseManagedPublicationRequest,
  readManagedPublicationRequestFromStdin,
  type ManagedPublicationHooks,
  type ManagedPublicationRequest,
} from "./backup-publish-managed.js";

const roots: string[] = [];

async function createRequest(
  assets: Array<{ kind: string; sourcePath: string; archivePath: string }> = [],
): Promise<ManagedPublicationRequest> {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".managed-publication-test-"));
  roots.push(root);
  const archivePath = path.join(root, "continuity.tar.gz");
  const archiveRoot = path.join(root, "continuity");
  await fs.mkdir(archiveRoot);
  const manifestBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-07-15T04:00:00.000Z",
      archiveRoot: "continuity",
      runtimeVersion: "2026.7.15",
      platform: process.platform,
      nodeVersion: process.version,
      assets,
    })}\n`,
  );
  await fs.writeFile(path.join(archiveRoot, "manifest.json"), manifestBytes);
  await tar.c({ cwd: root, file: archivePath, gzip: true }, ["continuity"]);
  const archiveBytes = await fs.readFile(archivePath);
  return {
    version: "continuity-managed-publication/v1",
    receipt: {
      ownerId: `sha256:${"1".repeat(64)}`,
      ownerGeneration: "runtime-7",
      handoffIdentity: "handoff-7",
      captureIdentity: "capture-7",
      executionIncarnationIdentity: `sha256:${"2".repeat(64)}`,
      archivePath,
      archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      archiveSize: archiveBytes.byteLength,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    },
    provider: {
      id: "lobster/continuity",
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: "provider-7",
      hostBundleIdentity: "lobster/host@1.0.0",
    },
  };
}

function createHooks(params: {
  acceptance?: ContinuityPublicationAcceptanceReceiptV1;
  publishError?: unknown;
  retrievalError?: unknown;
}) {
  const registries = [
    { scope: "publish" } as unknown as PluginRegistry,
    { scope: "retrieve" } as unknown as PluginRegistry,
  ];
  const loadRegistry = vi
    .fn<NonNullable<ManagedPublicationHooks["loadRegistry"]>>()
    .mockImplementationOnce(() => registries[0])
    .mockImplementationOnce(() => registries[1]);
  const stops = [vi.fn(), vi.fn()];
  const startServices = vi
    .fn<NonNullable<ManagedPublicationHooks["startServices"]>>()
    .mockImplementation(async ({ registry }) => {
      const index = registry === registries[0] ? 0 : 1;
      return { stop: stops[index] };
    });
  let retrievalConsumed = false;
  let publishedBytes = Buffer.alloc(0);
  const publish = vi.fn<NonNullable<ManagedPublicationHooks["publish"]>>(async (input) => {
    if (params.publishError) {
      throw params.publishError;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.content) {
      chunks.push(chunk);
    }
    expect(input.registry).toBe(registries[0]);
    publishedBytes = Buffer.concat(chunks);
    return (
      params.acceptance ?? {
        version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
        publicationId: "lobster/continuity/publication-7",
        identity: input.identity,
        durabilityClass: "immutable",
        acceptedAt: "2026-07-15T04:00:00.000Z",
        publicationBindingId: input.reference.id,
        publicationBindingGeneration: input.reference.generation,
        hostBundleGeneration: input.reference.hostBundleGeneration,
      }
    );
  });
  const retrieve = vi.fn<NonNullable<ManagedPublicationHooks["retrieve"]>>(async (input) => {
    if (params.retrievalError) {
      throw params.retrievalError;
    }
    expect(input.registry).toBe(registries[1]);
    return {
      version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
      publicationId: input.receipt.publicationId,
      identity: input.receipt.identity,
      content: (async function* () {
        yield publishedBytes.subarray(0, 5);
        yield publishedBytes.subarray(5);
        retrievalConsumed = true;
      })(),
    };
  });
  return {
    hooks: {
      resolveRuntimeContext: async () => ({
        config: {} as OpenClawConfig,
        workspaceDir: path.resolve("workspace"),
      }),
      loadRegistry,
      startServices,
      resolveProviderReference: (request) => ({
        id: request.provider.id,
        version: request.provider.version,
        generation: request.provider.generation,
        hostBundleGeneration: "bundle-7",
      }),
      publish,
      retrieve,
    } satisfies ManagedPublicationHooks,
    registries,
    loadRegistry,
    startServices,
    stops,
    wasRetrievalConsumed: () => retrievalConsumed,
  };
}

afterEach(async () => {
  clearCurrentHostIntegrationBundleSnapshotV1();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed continuity publication", () => {
  it("verifies bytes, scopes both service lifetimes, and freshly retrieves without Gateway", async () => {
    const request = await createRequest();
    const fixture = createHooks({});

    const result = await executeManagedPublication(request, fixture.hooks);

    expect(result).toMatchObject({
      ok: true,
      ownerGeneration: "runtime-7",
      handoffIdentity: "handoff-7",
      captureIdentity: "capture-7",
      executionIncarnationIdentity: `sha256:${"2".repeat(64)}`,
    });

    expect(fixture.loadRegistry).toHaveBeenCalledTimes(2);
    for (const call of fixture.loadRegistry.mock.calls) {
      expect(call[0]).toMatchObject({
        onlyPluginIds: ["lobster-host"],
        cache: false,
        workspaceDir: path.resolve("workspace"),
      });
    }
    expect(fixture.startServices.mock.calls.map((call) => call[0].registry)).toEqual(
      fixture.registries,
    );
    expect(fixture.stops[0]).toHaveBeenCalledOnce();
    expect(fixture.stops[1]).toHaveBeenCalledOnce();
    expect(fixture.wasRetrievalConsumed()).toBe(true);
  });

  it("publishes the verified pinned copy after the source path disappears", async () => {
    const request = await createRequest();
    const fixture = createHooks({});
    const loadRegistry = fixture.hooks.loadRegistry;
    let removed = false;
    fixture.hooks.loadRegistry = (params) => {
      if (!removed) {
        rmSync(request.receipt.archivePath);
        removed = true;
      }
      return loadRegistry(params);
    };

    await expect(executeManagedPublication(request, fixture.hooks)).resolves.toMatchObject({
      ok: true,
      captureIdentity: request.receipt.captureIdentity,
    });
  });

  it("loads only lobster-host and round-trips through the production owner contract", async () => {
    const request = await createRequest();
    const publicationRoot = path.join(path.dirname(request.receipt.archivePath), "published");
    const workspaceDir = path.join(path.dirname(request.receipt.archivePath), "workspace");
    const config = {
      plugins: {
        enabled: true,
        allow: ["lobster-host"],
        entries: {
          "lobster-host": {
            enabled: true,
            config: {
              publicationRoot,
              providerGeneration: request.provider.generation,
            },
          },
        },
      },
    } as OpenClawConfig;
    const result = await executeManagedPublication(request, {
      resolveRuntimeContext: async () => ({ config, workspaceDir }),
    });

    expect(result.ok).toBe(true);
    expect(result.acceptance.publicationBindingId).toBe("lobster/continuity");
    expect(getCurrentHostIntegrationBundleSnapshotV1()).toBeUndefined();
  });

  it("quarantines a stale portable host bundle identity", async () => {
    const request = await createRequest();
    request.provider.hostBundleIdentity = "lobster/host@2.0.0";
    const publicationRoot = path.join(path.dirname(request.receipt.archivePath), "published");
    const workspaceDir = path.join(path.dirname(request.receipt.archivePath), "workspace");
    const config = {
      plugins: {
        enabled: true,
        allow: ["lobster-host"],
        entries: {
          "lobster-host": {
            enabled: true,
            config: {
              publicationRoot,
              providerGeneration: request.provider.generation,
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      executeManagedPublication(request, {
        resolveRuntimeContext: async () => ({ config, workspaceDir }),
      }),
    ).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_stale",
      disposition: "quarantine",
      causeCode: "stale-host-bundle-generation",
    });
    expect(getCurrentHostIntegrationBundleSnapshotV1()).toBeUndefined();
  });

  it("holds when scoped startup does not publish a host bundle", async () => {
    const request = await createRequest();
    const fixture = createHooks({});
    delete fixture.hooks.resolveProviderReference;

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_unavailable",
      disposition: "hold",
      causeCode: "host-bundle-unavailable",
    });
    expect(fixture.stops[0]).toHaveBeenCalledOnce();
  });

  it("rejects malformed and extensible requests", async () => {
    const request = await createRequest();
    expect(() =>
      parseManagedPublicationRequest(JSON.stringify({ ...request, command: "upload" })),
    ).toThrow(/unknown or missing/u);
    expect(() =>
      parseManagedPublicationRequest(
        JSON.stringify({
          ...request,
          provider: { ...request.provider, id: "other/continuity" },
        }),
      ),
    ).toThrow(/unsupported/u);
  });

  it("fails before plugin loading when archive bytes do not match the receipt", async () => {
    const request = await createRequest();
    await fs.writeFile(request.receipt.archivePath, "changed");
    const fixture = createHooks({});

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "archive",
      code: "continuity.publication.archive_identity_mismatch",
      disposition: "quarantine",
    });
    expect(fixture.loadRegistry).not.toHaveBeenCalled();
  });

  it("fails before plugin loading when the manifest identity does not match", async () => {
    const request = await createRequest();
    request.receipt.manifestSha256 = "f".repeat(64);
    const fixture = createHooks({});

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "archive",
      code: "continuity.publication.archive_identity_mismatch",
      disposition: "quarantine",
    });
    expect(fixture.loadRegistry).not.toHaveBeenCalled();
  });

  it("fails before plugin loading when full archive verification fails", async () => {
    const request = await createRequest([
      {
        kind: "state",
        sourcePath: "/srv/openclaw/state",
        archivePath: "continuity/payload/state",
      },
    ]);
    const fixture = createHooks({});

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "archive",
      code: "continuity.publication.archive_identity_mismatch",
      disposition: "quarantine",
    });
    expect(fixture.loadRegistry).not.toHaveBeenCalled();
  });

  it("quarantines stale provider references", async () => {
    const request = await createRequest();
    const fixture = createHooks({
      publishError: new ContinuityPublicationError("stale-provider-generation", "stale provider"),
    });

    await expect(executeManagedPublication(request, fixture.hooks)).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_stale",
      disposition: "quarantine",
      causeCode: "stale-provider-generation",
    });
    expect(fixture.stops[0]).toHaveBeenCalledOnce();
  });

  it("preserves structured provider failures when archive cleanup also fails", async () => {
    const request = await createRequest();
    const fixture = createHooks({
      publishError: new ContinuityPublicationError("stale-provider-generation", "stale provider"),
    });
    const cleanupError = new Error("cleanup failed");
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupError);

    try {
      const error = await executeManagedPublication(request, fixture.hooks).catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({
        phase: "provider",
        code: "continuity.publication.provider_stale",
        disposition: "quarantine",
        causeCode: "stale-provider-generation",
      });
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect(((error as Error).cause as AggregateError).errors).toContain(cleanupError);
    } finally {
      rm.mockRestore();
    }
  });

  it("completes fresh retrieval and service shutdown after transient archive cleanup failure", async () => {
    const request = await createRequest();
    const fixture = createHooks({});
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup failed"));

    try {
      await expect(executeManagedPublication(request, fixture.hooks)).resolves.toMatchObject({
        ok: true,
      });
      expect(fixture.wasRetrievalConsumed()).toBe(true);
      expect(fixture.stops[0]).toHaveBeenCalledOnce();
      expect(fixture.stops[1]).toHaveBeenCalledOnce();
      expect(rm).toHaveBeenCalledTimes(3);
    } finally {
      rm.mockRestore();
    }
  });

  it("preserves corrupt retrieval quarantine when retrieval cleanup also fails", async () => {
    const request = await createRequest();
    const fixture = createHooks({});
    fixture.hooks.retrieve = vi.fn(async (input) => ({
      version: CONTINUITY_PUBLICATION_RETRIEVAL_VERSION,
      publicationId: input.receipt.publicationId,
      identity: input.receipt.identity,
      content: (async function* () {
        yield Buffer.from("not an archive");
      })(),
    }));
    const cleanupError = new Error("cleanup failed");
    const rm = vi
      .spyOn(fs, "rm")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cleanupError);

    try {
      const error = await executeManagedPublication(request, fixture.hooks).catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({
        phase: "retrieval",
        code: "continuity.publication.retrieval_corrupt",
        disposition: "quarantine",
        causeCode: "invalid-retrieval",
      });
      expect((error as Error).cause).toMatchObject({ cause: cleanupError });
      expect(fixture.stops[0]).toHaveBeenCalledOnce();
      expect(fixture.stops[1]).toHaveBeenCalledOnce();
    } finally {
      rm.mockRestore();
    }
  });

  it("holds unknown provider outcomes and corrupt retrievals fail closed", async () => {
    const request = await createRequest();
    const unknown = createHooks({
      publishError: Object.assign(new Error("unknown"), { code: "outcome-unknown" }),
    });
    await expect(executeManagedPublication(request, unknown.hooks)).rejects.toMatchObject({
      phase: "provider",
      code: "continuity.publication.provider_outcome_unknown",
      disposition: "hold",
    });

    const corrupt = createHooks({
      retrievalError: Object.assign(new Error("corrupt"), { code: "corrupt-retrieval" }),
    });
    await expect(executeManagedPublication(request, corrupt.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.publication.retrieval_corrupt",
      disposition: "quarantine",
    });
    expect(corrupt.stops[0]).toHaveBeenCalledOnce();
    expect(corrupt.stops[1]).toHaveBeenCalledOnce();
  });

  it("reads bounded stdin only", async () => {
    async function* input() {
      yield '{"version":';
      yield '"continuity-managed-publication/v1"}';
    }
    await expect(readManagedPublicationRequestFromStdin(input())).resolves.toBe(
      '{"version":"continuity-managed-publication/v1"}',
    );

    async function* oversized() {
      yield new Uint8Array(256 * 1024 + 1);
    }
    await expect(readManagedPublicationRequestFromStdin(oversized())).rejects.toThrow(/too large/u);
  });
});
