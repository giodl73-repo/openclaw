import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContinuityArchiveObligations } from "../continuity/archive-obligations.js";
import {
  CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
  CONTINUITY_PUBLICATION_PROVIDER_VERSION,
} from "../continuity/publication-provider.js";
import {
  executeManagedPreparation,
  parseManagedPreparationRequest,
  type ManagedPreparationHooks,
  type ManagedPreparationRequest,
} from "./backup-prepare-managed.js";
import type { VerifiedBackupArchive } from "./backup-verify.js";

const tempDirs: string[] = [];
const OWNER_ID = `sha256:${"1".repeat(64)}`;
const EXECUTION_ID = `sha256:${"2".repeat(64)}`;
const MANIFEST_SHA = "b".repeat(64);
const PLAN_ID = "c".repeat(64);
const ARCHIVE_BYTES = Buffer.from("verified continuity archive");
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE_BYTES).digest("hex");

const obligations: ContinuityArchiveObligations = {
  schemaVersion: 1,
  reconstructed: {
    authProfileRuntimeState: {
      owner: "auth-profiles",
      treatment: "safe-empty-default",
      removedRowCount: 1,
      readiness: "non-blocking",
    },
    pluginRuntimeDependencies: {
      owner: "plugins",
      treatment: "owner-reinstall",
      omittedTreeCount: 2,
      readiness: "owner-required",
    },
  },
  external: {
    configSecretReferences: {
      owner: "secrets",
      referenceCounts: { env: 1, file: 0, exec: 0 },
      readiness: "owner-required",
    },
    authProfileCredentials: {
      owner: "auth-profiles",
      removedRowCount: 1,
      credentialRows: 0,
      oauthCaptured: false,
      readiness: "owner-required",
    },
  },
  ephemeral: {
    runtimeTransients: {
      owner: "runtime",
      treatment: "normal-startup",
      readiness: "owner-owned",
    },
  },
};

async function createFixture(): Promise<{
  request: ManagedPreparationRequest;
  raw: string;
  hooks: ManagedPreparationHooks;
  retrieve: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
  plan: ReturnType<typeof vi.fn>;
  receiptRaw: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-prepare-"));
  tempDirs.push(root);
  const archivePath = path.join(root, "archive", "continuity.tar.gz");
  const materializedRoot = path.join(root, "materialized", "root");
  const journalRoot = path.join(root, "journal");
  const identity = {
    ownerId: OWNER_ID,
    sourceRuntimeGeneration: "runtime-7",
    handoffId: "handoff-7",
    captureId: "capture-7",
    archiveSha256: ARCHIVE_SHA,
    manifestSha256: MANIFEST_SHA,
    archiveSize: ARCHIVE_BYTES.byteLength,
  };
  const request: ManagedPreparationRequest = {
    version: "continuity-managed-preparation/v1",
    authority: {
      ownerId: OWNER_ID,
      ownerGeneration: "runtime-7",
      preparationIdentity: "preparation-7",
      executionIncarnationIdentity: EXECUTION_ID,
    },
    identity,
    provider: {
      pluginId: "example-continuity",
      id: "example/continuity",
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: "provider-7",
    },
    acceptance: {
      version: CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION,
      publicationId: "publication/handoff-7",
      identity,
      durabilityClass: "immutable",
      acceptedAt: "2026-07-17T00:00:00.000Z",
      publicationPluginId: "example-continuity",
      publicationBindingId: "example/continuity",
      publicationBindingVersion: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      publicationBindingGeneration: "provider-7",
    },
    destination: { archivePath, materializedRoot },
    policy: { authorizedPublicationRoots: [path.join(root, "targets", "state")] },
    journalRoot,
  };
  const receiptRaw = `${JSON.stringify({
    schemaVersion: 1,
    artifactType: "continuity",
    archiveSha256: ARCHIVE_SHA,
    manifestSha256: MANIFEST_SHA,
  })}\n`;
  const retrieve = vi.fn(async (_request, destinationPath: string) => {
    await fs.writeFile(destinationPath, ARCHIVE_BYTES, { flag: "wx" });
  });
  const materialize = vi.fn(async ({ destination }: { destination: string }) => {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(
      path.join(destination, ".openclaw-continuity-materialization.json"),
      receiptRaw,
    );
    return {} as never;
  });
  const verifyArchive = vi.fn(async (observedPath: string) => {
    const bytes = await fs.readFile(observedPath);
    if (!bytes.equals(ARCHIVE_BYTES)) {
      throw new Error("corrupt archive");
    }
    return {
      manifest: {
        artifactType: "continuity",
        continuityObligations: obligations,
      },
      result: {
        artifactType: "continuity",
        archiveSha256: ARCHIVE_SHA,
        manifestSha256: MANIFEST_SHA,
      },
    } as VerifiedBackupArchive;
  });
  const plan = vi.fn(async () => {
    const receipt = await fs.readFile(
      path.join(materializedRoot, ".openclaw-continuity-materialization.json"),
    );
    return {
      ok: true,
      archivePath,
      materializedRoot,
      plan: {
        planId: PLAN_ID,
        artifact: {
          archiveSha256: ARCHIVE_SHA,
          manifestSha256: MANIFEST_SHA,
        },
        materialization: {
          receiptSha256: createHash("sha256").update(receipt).digest("hex"),
        },
        groups: [],
      },
    } as never;
  });
  return {
    request,
    raw: JSON.stringify(request),
    hooks: { retrieve, materialize, verifyArchive, plan },
    retrieve,
    materialize,
    plan,
    receiptRaw,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("managed continuity destination preparation", () => {
  it("strictly parses the complete managed request", async () => {
    const fixture = await createFixture();
    expect(parseManagedPreparationRequest(fixture.raw)).toEqual(fixture.request);

    const unknown = JSON.parse(fixture.raw);
    unknown.extra = true;
    expect(() => parseManagedPreparationRequest(JSON.stringify(unknown))).toThrow(
      /unknown or missing field/i,
    );

    const mismatched = JSON.parse(fixture.raw);
    mismatched.acceptance.identity.captureId = "capture-other";
    expect(() => parseManagedPreparationRequest(JSON.stringify(mismatched))).toThrow(
      /identities do not match/i,
    );

    const wrongProvider = JSON.parse(fixture.raw);
    wrongProvider.acceptance.publicationPluginId = "replacement";
    expect(() => parseManagedPreparationRequest(JSON.stringify(wrongProvider))).toThrow(
      /provider does not match/i,
    );

    const overlapping = JSON.parse(fixture.raw);
    overlapping.destination.materializedRoot = path.dirname(overlapping.destination.archivePath);
    expect(() => parseManagedPreparationRequest(JSON.stringify(overlapping))).toThrow(/overlap/i);

    if (process.platform === "win32") {
      const crossDrive = JSON.parse(fixture.raw);
      const archiveRoot = path.parse(crossDrive.destination.archivePath).root.toLowerCase();
      const otherRoot = archiveRoot === "c:\\" ? "D:\\" : "C:\\";
      crossDrive.destination.materializedRoot = path.join(
        otherRoot,
        "openclaw-managed-prepare",
        "materialized",
      );
      expect(() => parseManagedPreparationRequest(JSON.stringify(crossDrive))).not.toThrow();
    }
  });

  it("returns the exact restore source and obligations without activating targets", async () => {
    const fixture = await createFixture();

    const result = await executeManagedPreparation(fixture.request, fixture.hooks);

    expect(result).toEqual({
      version: "continuity-managed-preparation-result/v1",
      ok: true,
      authority: fixture.request.authority,
      archivePath: fixture.request.destination.archivePath,
      archiveSha256: ARCHIVE_SHA,
      manifestSha256: MANIFEST_SHA,
      materializedRoot: fixture.request.destination.materializedRoot,
      materializationReceiptSha256: createHash("sha256").update(fixture.receiptRaw).digest("hex"),
      expectedPlanId: PLAN_ID,
      continuityObligations: obligations,
    });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.materialize).toHaveBeenCalledOnce();
    expect(fixture.plan).toHaveBeenCalledOnce();
  });

  it("replays the exact result without retrieving or materializing again", async () => {
    const fixture = await createFixture();
    const first = await executeManagedPreparation(fixture.request, fixture.hooks);

    const second = await executeManagedPreparation(fixture.request, fixture.hooks);

    expect(second).toEqual(first);
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.materialize).toHaveBeenCalledOnce();
    expect(fixture.plan).toHaveBeenCalledTimes(2);
  });

  it("retries exact journal directory durability after a committed record sync failure", async () => {
    const fixture = await createFixture();
    fixture.hooks.syncJournalDirectory = vi
      .fn()
      .mockRejectedValueOnce(new Error("journal directory sync failed"))
      .mockResolvedValue(undefined);

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.preparation.journal_unavailable",
      disposition: "hold",
    });
    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).resolves.toMatchObject({
      ok: true,
      expectedPlanId: PLAN_ID,
    });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.materialize).toHaveBeenCalledOnce();
  });

  it("quarantines a different request under the same preparation identity", async () => {
    const fixture = await createFixture();
    await executeManagedPreparation(fixture.request, fixture.hooks);
    const conflicting = {
      ...fixture.request,
      destination: {
        ...fixture.request.destination,
        archivePath: path.join(
          path.dirname(fixture.request.destination.archivePath),
          "other.tar.gz",
        ),
      },
    };

    await expect(executeManagedPreparation(conflicting, fixture.hooks)).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.preparation.journal_conflict",
      disposition: "quarantine",
    });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.materialize).toHaveBeenCalledOnce();
  });

  it("quarantines corrupt retrieved bytes", async () => {
    const fixture = await createFixture();
    fixture.retrieve.mockImplementationOnce(async (_request, destinationPath: string) => {
      await fs.writeFile(destinationPath, "corrupt", { flag: "wx" });
    });

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.preparation.retrieval_corrupt",
      disposition: "quarantine",
    });
    expect(fixture.materialize).not.toHaveBeenCalled();
  });

  it("quarantines a raw invalid retrieval classification", async () => {
    const fixture = await createFixture();
    fixture.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("invalid retrieval"), { code: "invalid-retrieval" }),
    );

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.preparation.retrieval_corrupt",
      disposition: "quarantine",
    });
  });

  it("quarantines a raw provider provenance mismatch", async () => {
    const fixture = await createFixture();
    fixture.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("provider mismatch"), {
        code: "provider-provenance-mismatch",
      }),
    );

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.preparation.retrieval_stale",
      disposition: "quarantine",
    });
  });

  it("resumes from an existing exact archive without another retrieval", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.request.destination.archivePath), { recursive: true });
    await fs.writeFile(fixture.request.destination.archivePath, ARCHIVE_BYTES);

    await executeManagedPreparation(fixture.request, fixture.hooks);

    expect(fixture.retrieve).not.toHaveBeenCalled();
    expect(fixture.materialize).toHaveBeenCalledOnce();
    expect(fixture.plan).toHaveBeenCalledOnce();
  });

  it("retries exact archive directory durability without retrieving again", async () => {
    const fixture = await createFixture();
    fixture.hooks.syncArchiveDirectory = vi
      .fn()
      .mockRejectedValueOnce(new Error("archive directory sync failed"))
      .mockResolvedValue(undefined);

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.preparation.retrieval_unavailable",
      disposition: "hold",
    });
    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).resolves.toMatchObject({
      ok: true,
      expectedPlanId: PLAN_ID,
    });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.hooks.syncArchiveDirectory).toHaveBeenCalledTimes(2);
  });

  it("resumes from an existing exact materialized root without rematerializing", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.request.destination.archivePath), { recursive: true });
    await fs.writeFile(fixture.request.destination.archivePath, ARCHIVE_BYTES);
    await fs.mkdir(fixture.request.destination.materializedRoot, { recursive: true });
    await fs.writeFile(
      path.join(
        fixture.request.destination.materializedRoot,
        ".openclaw-continuity-materialization.json",
      ),
      fixture.receiptRaw,
    );

    await executeManagedPreparation(fixture.request, fixture.hooks);

    expect(fixture.retrieve).not.toHaveBeenCalled();
    expect(fixture.materialize).not.toHaveBeenCalled();
    expect(fixture.plan).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")(
    "accepts an archive path beneath a symlinked ancestor",
    async () => {
      const fixture = await createFixture();
      const fixtureRoot = path.dirname(path.dirname(fixture.request.destination.archivePath));
      const archiveParent = path.dirname(fixture.request.destination.archivePath);
      const canonicalParent = path.join(fixtureRoot, "archive-canonical");
      await fs.mkdir(canonicalParent);
      await fs.symlink(canonicalParent, archiveParent, "dir");

      await expect(
        executeManagedPreparation(fixture.request, fixture.hooks),
      ).resolves.toMatchObject({
        ok: true,
        archivePath: fixture.request.destination.archivePath,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts a materialized root beneath a symlinked ancestor",
    async () => {
      const fixture = await createFixture();
      const fixtureRoot = path.dirname(path.dirname(fixture.request.destination.materializedRoot));
      const materializedParent = path.dirname(fixture.request.destination.materializedRoot);
      const canonicalParent = path.join(fixtureRoot, "materialized-canonical");
      await fs.mkdir(canonicalParent);
      await fs.symlink(canonicalParent, materializedParent, "dir");
      fixture.plan.mockImplementationOnce(async () => {
        const receipt = await fs.readFile(
          path.join(
            fixture.request.destination.materializedRoot,
            ".openclaw-continuity-materialization.json",
          ),
        );
        return {
          ok: true,
          archivePath: fixture.request.destination.archivePath,
          materializedRoot: await fs.realpath(fixture.request.destination.materializedRoot),
          plan: {
            planId: PLAN_ID,
            artifact: {
              archiveSha256: ARCHIVE_SHA,
              manifestSha256: MANIFEST_SHA,
            },
            materialization: {
              receiptSha256: createHash("sha256").update(receipt).digest("hex"),
            },
            groups: [],
          },
        } as never;
      });

      await expect(
        executeManagedPreparation(fixture.request, fixture.hooks),
      ).resolves.toMatchObject({
        ok: true,
        materializedRoot: fixture.request.destination.materializedRoot,
      });
    },
  );

  it("replaces an incomplete materialization before planning", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.request.destination.archivePath), { recursive: true });
    await fs.writeFile(fixture.request.destination.archivePath, ARCHIVE_BYTES);
    await fs.mkdir(fixture.request.destination.materializedRoot, { recursive: true });
    await fs.writeFile(
      path.join(fixture.request.destination.materializedRoot, ".openclaw-materialize-incomplete"),
      `${ARCHIVE_SHA}\n`,
    );
    await fs.writeFile(path.join(fixture.request.destination.materializedRoot, "partial"), "data");

    await executeManagedPreparation(fixture.request, fixture.hooks);

    expect(fixture.materialize).toHaveBeenCalledOnce();
    await expect(
      fs.stat(
        path.join(fixture.request.destination.materializedRoot, ".openclaw-materialize-incomplete"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(
        path.join(
          fixture.request.destination.materializedRoot,
          ".openclaw-continuity-materialization.json",
        ),
        "utf8",
      ),
    ).resolves.toBe(fixture.receiptRaw);
  });

  it("quarantines a markerless materialization without a receipt", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.request.destination.archivePath), { recursive: true });
    await fs.writeFile(fixture.request.destination.archivePath, ARCHIVE_BYTES);
    await fs.mkdir(fixture.request.destination.materializedRoot, { recursive: true });
    await fs.writeFile(path.join(fixture.request.destination.materializedRoot, "foreign"), "data");

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "materialization",
      code: "continuity.preparation.materialization_failed",
      disposition: "quarantine",
    });
    expect(fixture.materialize).not.toHaveBeenCalled();
  });

  it("holds when a published materialization cannot be committed durably", async () => {
    const fixture = await createFixture();
    fixture.hooks.syncDirectory = vi
      .fn()
      .mockRejectedValueOnce(new Error("directory sync failed"))
      .mockRejectedValueOnce(new Error("directory sync still failed"))
      .mockResolvedValueOnce(undefined);

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "materialization",
      code: "continuity.preparation.materialization_unavailable",
      disposition: "hold",
    });
    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "materialization",
      code: "continuity.preparation.materialization_unavailable",
      disposition: "hold",
    });
    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).resolves.toMatchObject({
      ok: true,
      expectedPlanId: PLAN_ID,
    });
    expect(fixture.materialize).toHaveBeenCalledOnce();
    expect(fixture.plan).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent exact preparations without exposing partial journal records", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.request.destination.archivePath), { recursive: true });
    await fs.writeFile(fixture.request.destination.archivePath, ARCHIVE_BYTES);
    let materializationsStarted = 0;
    let releaseMaterializations!: () => void;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterializations = resolve;
    });
    fixture.materialize.mockImplementation(async ({ destination }: { destination: string }) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(
        path.join(destination, ".openclaw-continuity-materialization.json"),
        fixture.receiptRaw,
      );
      materializationsStarted += 1;
      if (materializationsStarted === 2) {
        releaseMaterializations();
      }
      await materializationGate;
      return {} as never;
    });

    const results = await Promise.all([
      executeManagedPreparation(fixture.request, fixture.hooks),
      executeManagedPreparation(fixture.request, fixture.hooks),
    ]);

    expect(results[1]).toEqual(results[0]);
    expect(fixture.materialize).toHaveBeenCalledTimes(2);
    expect(fixture.plan).toHaveBeenCalledTimes(2);
  });

  it("holds retrieval resource exhaustion under the same preparation identity", async () => {
    const fixture = await createFixture();
    fixture.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("destination full"), {
        code: "continuity.publication.resource_exhausted",
      }),
    );

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.preparation.retrieval_resource_exhausted",
      disposition: "hold",
    });
  });

  it("quarantines an ambiguous frozen retrieval provider", async () => {
    const fixture = await createFixture();
    fixture.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("provider ambiguous"), {
        code: "continuity.publication.retrieval_unavailable",
        causeCode: "provider-ambiguous",
      }),
    );

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "retrieval",
      code: "continuity.preparation.retrieval_stale",
      disposition: "quarantine",
    });
  });

  it("quarantines a restore target that overlaps preparation evidence", async () => {
    const fixture = await createFixture();
    fixture.plan.mockImplementationOnce(async () => {
      const receipt = await fs.readFile(
        path.join(
          fixture.request.destination.materializedRoot,
          ".openclaw-continuity-materialization.json",
        ),
      );
      return {
        ok: true,
        archivePath: fixture.request.destination.archivePath,
        materializedRoot: fixture.request.destination.materializedRoot,
        plan: {
          planId: PLAN_ID,
          artifact: {
            archiveSha256: ARCHIVE_SHA,
            manifestSha256: MANIFEST_SHA,
          },
          materialization: {
            receiptSha256: createHash("sha256").update(receipt).digest("hex"),
          },
          groups: [{ canonicalTargetPath: fixture.request.journalRoot }],
        },
      } as never;
    });

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "plan",
      code: "continuity.preparation.plan_mismatch",
      disposition: "quarantine",
    });
  });

  it.skipIf(process.platform === "win32")("rejects a group-readable journal root", async () => {
    const fixture = await createFixture();
    await fs.mkdir(fixture.request.journalRoot, { recursive: true, mode: 0o755 });
    await fs.chmod(fixture.request.journalRoot, 0o755);

    await expect(executeManagedPreparation(fixture.request, fixture.hooks)).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.preparation.journal_unavailable",
      disposition: "hold",
    });
  });
});
