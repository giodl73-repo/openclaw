import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../infra/crypto-digest.js";
import type { RuntimeEnv } from "../runtime.js";
import { backupPlanRestoreCommand } from "./backup-plan-restore.js";
import type { VerifiedBackupArchive } from "./backup-verify.js";

const mocks = vi.hoisted(() => ({
  verifyBackupArchive: vi.fn(),
}));

vi.mock("./backup-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-verify.js")>();
  return { ...actual, verifyBackupArchive: mocks.verifyBackupArchive };
});

const tempDirs: string[] = [];
const ARCHIVE_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-plan-"));
  tempDirs.push(root);
  const materializedRoot = path.join(root, "materialized");
  const targetParent = path.join(root, "live");
  const stateTarget = path.join(targetParent, "state");
  const includeTarget = path.join(targetParent, "includes", "gateway.json");
  const archivePath = path.join(root, "continuity.tar.gz");
  await fs.mkdir(path.join(materializedRoot, "state", "workspace"), { recursive: true });
  await fs.mkdir(path.join(materializedRoot, "includes"), { recursive: true });
  await fs.mkdir(targetParent);
  await fs.writeFile(path.join(materializedRoot, "state", "openclaw.json"), "{}\n");
  await fs.writeFile(path.join(materializedRoot, "state", "workspace", "AGENTS.md"), "workspace\n");
  await fs.writeFile(path.join(materializedRoot, "includes", "gateway.json"), "{}\n");
  await fs.writeFile(archivePath, "verified by mock");

  const manifest: VerifiedBackupArchive["manifest"] = {
    schemaVersion: 1,
    artifactType: "continuity",
    createdAt: "2026-07-12T00:00:00.000Z",
    archiveRoot: "continuity",
    runtimeVersion: "2026.7.12",
    platform: process.platform,
    nodeVersion: process.version,
    assets: [
      {
        kind: "state",
        sourcePath: stateTarget,
        archivePath: "continuity/payload/state",
        component: { id: "state", restoreOrder: 2, dependsOn: ["config"] },
      },
      {
        kind: "config",
        sourcePath: path.join(stateTarget, "openclaw.json"),
        archivePath: "continuity/payload/state/openclaw.json",
        component: { id: "config", restoreOrder: 1, dependsOn: ["config-include"] },
      },
      {
        kind: "config-include",
        sourcePath: includeTarget,
        archivePath: "continuity/payload/includes/gateway.json",
        component: { id: "config-include", restoreOrder: 0, dependsOn: [] },
      },
      {
        kind: "workspace",
        sourcePath: path.join(stateTarget, "workspace"),
        archivePath: "continuity/payload/state/workspace",
        component: { id: "workspace", restoreOrder: 3, dependsOn: ["state"] },
      },
    ],
  };
  const verified: VerifiedBackupArchive = {
    manifest,
    result: {
      ok: true,
      artifactType: "continuity",
      archivePath,
      archiveRoot: manifest.archiveRoot,
      createdAt: manifest.createdAt,
      runtimeVersion: manifest.runtimeVersion,
      assetCount: manifest.assets.length,
      componentCount: manifest.assets.length,
      entryCount: 8,
      archiveSha256: ARCHIVE_SHA,
      manifestSha256: MANIFEST_SHA,
    },
  };
  mocks.verifyBackupArchive.mockResolvedValue(verified);
  const receipt = {
    schemaVersion: 1,
    artifactType: "continuity",
    archiveRoot: manifest.archiveRoot,
    archiveSha256: ARCHIVE_SHA,
    manifestSha256: MANIFEST_SHA,
    activated: false,
    activationReady: false,
    effectiveArchived: false,
    contentInventory: {
      version: 1,
      files: await Promise.all(
        [
          "continuity/payload/includes/gateway.json",
          "continuity/payload/state/openclaw.json",
          "continuity/payload/state/workspace/AGENTS.md",
        ].map(async (inventoryPath) => {
          const relativePath = path.posix.relative("continuity/payload", inventoryPath);
          const materializedPath = path.join(materializedRoot, ...relativePath.split("/"));
          const stat = await fs.stat(materializedPath);
          return {
            archivePath: inventoryPath,
            sha256: await sha256File(materializedPath),
            size: stat.size,
            executable: false,
          };
        }),
      ),
    },
  };
  const receiptPath = path.join(materializedRoot, ".openclaw-continuity-materialization.json");
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  return {
    archivePath,
    includeTarget,
    materializedRoot,
    receipt,
    receiptPath,
    stateTarget,
    targetParent,
    verified,
  };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("backupPlanRestoreCommand", () => {
  it("plans real materialized assets without creating target or staging paths", async () => {
    const fixture = await makeFixture();

    const result = await backupPlanRestoreCommand(runtime, {
      archive: fixture.archivePath,
      materialized: fixture.materializedRoot,
      authorize: [fixture.stateTarget, fixture.includeTarget],
      json: true,
    });

    expect(result.plan).toMatchObject({
      executionEligible: false,
      groups: [
        {
          canonicalTargetPath: fixture.includeTarget,
          members: [{ componentId: "config-include" }],
        },
        {
          canonicalTargetPath: fixture.stateTarget,
          members: [
            { componentId: "config" },
            { componentId: "state" },
            { componentId: "workspace" },
          ],
        },
      ],
      blockers: [
        { code: "continuity.restore.launcher_lease_required" },
        { code: "continuity.restore.publication_capability_missing" },
      ],
    });
    expect(result.plan.groups.flatMap((group) => group.files ?? [])).toHaveLength(3);
    await expect(fs.access(fixture.stateTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(fixture.targetParent, ".openclaw-restore")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.log).toHaveBeenCalledTimes(1);
  });

  it("rejects a target that already exists", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(fixture.stateTarget);

    await expect(
      backupPlanRestoreCommand(runtime, {
        archive: fixture.archivePath,
        materialized: fixture.materializedRoot,
        authorize: [fixture.stateTarget, fixture.includeTarget],
      }),
    ).rejects.toMatchObject({ code: "continuity.restore.target_present" });
  });

  it("rejects a materialization receipt for another archive identity", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(
      fixture.receiptPath,
      `${JSON.stringify({ ...fixture.receipt, archiveSha256: "f".repeat(64) })}\n`,
    );

    await expect(
      backupPlanRestoreCommand(runtime, {
        archive: fixture.archivePath,
        materialized: fixture.materializedRoot,
        authorize: [fixture.stateTarget, fixture.includeTarget],
      }),
    ).rejects.toThrow(/receipt does not match/);
  });

  it("keeps older receipts previewable but execution-blocked", async () => {
    const fixture = await makeFixture();
    const { contentInventory: _contentInventory, ...legacyReceipt } = fixture.receipt;
    await fs.writeFile(fixture.receiptPath, `${JSON.stringify(legacyReceipt)}\n`);

    const result = await backupPlanRestoreCommand(runtime, {
      archive: fixture.archivePath,
      materialized: fixture.materializedRoot,
      authorize: [fixture.stateTarget, fixture.includeTarget],
    });

    expect(result.plan.blockers[0]).toEqual({
      code: "continuity.restore.materialization_content_identity_required",
    });
    expect(result.plan.groups.every((group) => group.files === undefined)).toBe(true);
  });

  it("rejects changed materialized bytes against the receipt inventory", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(path.join(fixture.materializedRoot, "state", "openclaw.json"), "changed\n");

    await expect(
      backupPlanRestoreCommand(runtime, {
        archive: fixture.archivePath,
        materialized: fixture.materializedRoot,
        authorize: [fixture.stateTarget, fixture.includeTarget],
      }),
    ).rejects.toThrow(/file identity mismatch/i);
  });

  it("rejects a missing materialized asset", async () => {
    const fixture = await makeFixture();
    await fs.rm(path.join(fixture.materializedRoot, "includes", "gateway.json"));

    await expect(
      backupPlanRestoreCommand(runtime, {
        archive: fixture.archivePath,
        materialized: fixture.materializedRoot,
        authorize: [fixture.stateTarget, fixture.includeTarget],
      }),
    ).rejects.toThrow(/inventory does not match/i);
  });

  it("rejects an extra materialized file outside the receipt inventory", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(path.join(fixture.materializedRoot, "state", "foreign.txt"), "foreign\n");

    await expect(
      backupPlanRestoreCommand(runtime, {
        archive: fixture.archivePath,
        materialized: fixture.materializedRoot,
        authorize: [fixture.stateTarget, fixture.includeTarget],
      }),
    ).rejects.toThrow(/inventory does not match/i);
  });

  it("rejects authorization that does not exactly cover publication roots", async () => {
    const fixture = await makeFixture();

    await expect(
      backupPlanRestoreCommand(runtime, {
        archive: fixture.archivePath,
        materialized: fixture.materializedRoot,
        authorize: [fixture.stateTarget],
      }),
    ).rejects.toMatchObject({ code: "continuity.restore.target_unauthorized" });
  });
});
