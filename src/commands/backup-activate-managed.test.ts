import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTINUITY_RESTORE_CLAIM_MARKER } from "../continuity/restore-claim.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  backupActivateManagedCommand,
  executeManagedRestore,
  parseManagedRestoreRequest,
  type ManagedRestoreRequest,
} from "./backup-activate-managed.js";
import { planContinuityRestore } from "./backup-plan-restore.js";
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
const OWNER_ID = `sha256:${"c".repeat(64)}`;
const EXECUTION_ID = `sha256:${"d".repeat(64)}`;

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

async function makeFixture(
  options: { claimMarkerPayload?: boolean; emptyWorkspace?: boolean } = {},
): Promise<{
  request: ManagedRestoreRequest;
  requestRaw: string;
  stateTarget: string;
  includeTarget: string;
  journalRoot: string;
  materializedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-restore-"));
  tempDirs.push(root);
  const materializedRoot = path.join(root, "materialized");
  const targetParent = path.join(root, "live");
  const stateTarget = path.join(targetParent, "state");
  const includeTarget = path.join(targetParent, "includes", "gateway.json");
  const journalRoot = path.join(root, "journal");
  const archivePath = path.join(root, "continuity.tar.gz");
  const allMaterializedFiles = [
    {
      archivePath: "continuity/payload/includes/gateway.json",
      relativePath: "includes/gateway.json",
      content: '{"gateway":true}\n',
      executable: false,
    },
    {
      archivePath: "continuity/payload/state/openclaw.json",
      relativePath: "state/openclaw.json",
      content: "{}\n",
      executable: false,
    },
    {
      archivePath: "continuity/payload/state/state/openclaw.sqlite",
      relativePath: "state/state/openclaw.sqlite",
      content: "sqlite-state\n",
      executable: false,
    },
    {
      archivePath: "continuity/payload/state/workspace/AGENTS.md",
      relativePath: "state/workspace/AGENTS.md",
      content: "workspace\n",
      executable: false,
    },
    {
      archivePath: "continuity/payload/state/workspace/tool.sh",
      relativePath: "state/workspace/tool.sh",
      content: "#!/bin/sh\nexit 0\n",
      executable: true,
    },
  ] as const;
  const materializedFiles = [
    ...allMaterializedFiles,
    ...(options.claimMarkerPayload
      ? [
          {
            archivePath: `continuity/payload/state/${CONTINUITY_RESTORE_CLAIM_MARKER}`,
            relativePath: `state/${CONTINUITY_RESTORE_CLAIM_MARKER}`,
            content: "captured claim marker\n",
            executable: false,
          },
        ]
      : []),
  ]
    .filter((file) => !options.emptyWorkspace || !file.relativePath.startsWith("state/workspace/"))
    .toSorted((left, right) => left.archivePath.localeCompare(right.archivePath));
  await fs.mkdir(materializedRoot, { recursive: true });
  if (options.emptyWorkspace) {
    await fs.mkdir(path.join(materializedRoot, "state", "workspace"), { recursive: true });
  }
  await fs.mkdir(targetParent);
  await fs.mkdir(path.dirname(includeTarget), { recursive: true });
  await fs.mkdir(journalRoot, { mode: 0o700 });
  await fs.writeFile(archivePath, "verified by mock");
  for (const file of materializedFiles) {
    const filePath = path.join(materializedRoot, ...file.relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, { mode: file.executable ? 0o700 : 0o600 });
  }

  const manifest: VerifiedBackupArchive["manifest"] = {
    schemaVersion: 1,
    artifactType: "continuity",
    createdAt: "2026-07-13T00:00:00.000Z",
    archiveRoot: "continuity",
    runtimeVersion: "2026.7.13",
    platform: process.platform,
    nodeVersion: process.version,
    stateFilePaths: [
      "continuity/payload/state/state/openclaw.sqlite",
      ...(options.claimMarkerPayload
        ? [`continuity/payload/state/${CONTINUITY_RESTORE_CLAIM_MARKER}`]
        : []),
    ],
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
      entryCount: 10,
      archiveSha256: ARCHIVE_SHA,
      manifestSha256: MANIFEST_SHA,
    },
  };
  mocks.verifyBackupArchive.mockResolvedValue(verified);

  const inventory = await Promise.all(
    materializedFiles.map(async (file) => {
      const filePath = path.join(materializedRoot, ...file.relativePath.split("/"));
      const stat = await fs.stat(filePath);
      return {
        archivePath: file.archivePath,
        sha256: await sha256File(filePath),
        size: stat.size,
        executable: file.executable,
      };
    }),
  );
  const receipt = {
    schemaVersion: 1,
    artifactType: "continuity",
    archiveRoot: manifest.archiveRoot,
    archiveSha256: ARCHIVE_SHA,
    manifestSha256: MANIFEST_SHA,
    contentInventory: { version: 1, files: inventory },
    activated: false,
    activationReady: false,
    effectiveArchived: false,
  } as const;
  const receiptRaw = `${JSON.stringify(receipt)}\n`;
  await fs.writeFile(
    path.join(materializedRoot, ".openclaw-continuity-materialization.json"),
    receiptRaw,
  );
  const preview = await planContinuityRestore({
    archive: archivePath,
    materialized: materializedRoot,
    authorize: [stateTarget, includeTarget],
    requireContentInventory: true,
  });
  const request: ManagedRestoreRequest = {
    version: "continuity-restore-execution/v1",
    authority: {
      ownerId: OWNER_ID,
      ownerGeneration: "owner-generation-7",
      holdRevision: 12,
      restoreIdentity: "restore-1",
      executionIncarnationIdentity: EXECUTION_ID,
    },
    source: {
      archivePath,
      archiveSha256: ARCHIVE_SHA,
      manifestSha256: MANIFEST_SHA,
      materializedRoot,
      materializationReceiptSha256: sha256Hex(receiptRaw),
      expectedPlanId: preview.plan.planId,
    },
    policy: {
      authorizedPublicationRoots: [stateTarget, includeTarget],
    },
    journalRoot,
  };
  return {
    request,
    requestRaw: JSON.stringify(request),
    stateTarget,
    includeTarget,
    journalRoot,
    materializedRoot,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("managed continuity restore executor", () => {
  it("assembles one directory root and one file root into an exact committed receipt", async () => {
    const fixture = await makeFixture();

    const result = await backupActivateManagedCommand(runtime, fixture.requestRaw);

    expect(result).toMatchObject({
      ok: true,
      ownerGeneration: "owner-generation-7",
      holdRevision: 12,
      restoreIdentity: "restore-1",
      executionIncarnationIdentity: EXECUTION_ID,
      targetRootCount: 2,
      fileCount: 5,
    });
    await expect(fs.readFile(fixture.includeTarget, "utf8")).resolves.toBe('{"gateway":true}\n');
    await expect(
      fs.readFile(path.join(fixture.stateTarget, "workspace", "AGENTS.md"), "utf8"),
    ).resolves.toBe("workspace\n");
    expect(
      (await fs.stat(path.join(fixture.stateTarget, "workspace", "tool.sh"))).mode & 0o777,
    ).toBe(0o700);
    if (!result.ok) {
      throw new Error("expected successful restore");
    }
    const receiptRaw = await fs.readFile(result.receiptPath, "utf8");
    expect(`sha256:${sha256Hex(receiptRaw)}`).toBe(result.receiptIdentity);
    const replay = await backupActivateManagedCommand(runtime, fixture.requestRaw);
    expect(replay).toEqual(result);
  });

  it("leaves an authorized foreign target untouched and returns quarantine", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(path.dirname(fixture.includeTarget), { recursive: true });
    await fs.writeFile(fixture.includeTarget, "foreign\n");

    const result = await backupActivateManagedCommand(runtime, fixture.requestRaw);

    expect(result).toEqual({
      version: "continuity-restore-execution-result/v1",
      ok: false,
      restoreIdentity: "restore-1",
      executionIncarnationIdentity: EXECUTION_ID,
      phase: "preflight",
      code: "continuity.restore.target_unattributed",
      disposition: "quarantine",
    });
    await expect(fs.readFile(fixture.includeTarget, "utf8")).resolves.toBe("foreign\n");
  });

  it("resumes an identical request after one synced file on the same incarnation", async () => {
    const fixture = await makeFixture();

    await expect(
      executeManagedRestore(fixture.request, {
        afterFileCommitted: (count) => {
          if (count === 1) {
            throw new Error("simulated process interruption");
          }
        },
      }),
    ).rejects.toThrow(/simulated process interruption/);

    const result = await backupActivateManagedCommand(runtime, fixture.requestRaw);
    expect(result).toMatchObject({ ok: true, fileCount: 5, targetRootCount: 2 });
    const replay = await backupActivateManagedCommand(runtime, fixture.requestRaw);
    expect(replay).toEqual(result);
  });

  it("quarantines a changed execution incarnation after publication started", async () => {
    const fixture = await makeFixture();
    await expect(
      executeManagedRestore(fixture.request, {
        afterFileCommitted: () => {
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow(/simulated process interruption/);
    const changed = {
      ...fixture.request,
      authority: {
        ...fixture.request.authority,
        executionIncarnationIdentity: `sha256:${"e".repeat(64)}`,
      },
    };

    const result = await backupActivateManagedCommand(runtime, JSON.stringify(changed));

    expect(result).toMatchObject({
      ok: false,
      phase: "journal",
      code: "continuity.restore.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("rejects unknown request fields before filesystem mutation", async () => {
    const fixture = await makeFixture();
    const parsed = JSON.parse(fixture.requestRaw) as Record<string, unknown>;
    parsed.command = "anything";

    expect(() => parseManagedRestoreRequest(JSON.stringify(parsed))).toThrow(/unknown or missing/);
    await expect(fs.access(fixture.stateTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink inserted into a claimed directory parent", async () => {
    const fixture = await makeFixture();
    const foreignRoot = path.join(path.dirname(fixture.stateTarget), "foreign");
    await fs.mkdir(foreignRoot);

    await expect(
      executeManagedRestore(fixture.request, {
        afterFileCommitted: async (count) => {
          if (count === 1) {
            const workspace = path.join(fixture.stateTarget, "workspace");
            await fs.rm(workspace, { recursive: true });
            await fs.symlink(foreignRoot, workspace, "dir");
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "continuity.restore.target_identity_mismatch",
      disposition: "quarantine",
    });
    await expect(fs.readdir(foreignRoot)).resolves.toEqual([]);
  });

  it("creates and verifies an empty planned directory component", async () => {
    const fixture = await makeFixture({ emptyWorkspace: true });

    const result = await backupActivateManagedCommand(runtime, fixture.requestRaw);

    expect(result).toMatchObject({ ok: true, fileCount: 3, targetRootCount: 2 });
    await expect(fs.stat(path.join(fixture.stateTarget, "workspace"))).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    await fs.mkdir(path.join(fixture.stateTarget, "foreign-empty"));
    const replay = await backupActivateManagedCommand(runtime, fixture.requestRaw);
    expect(replay).toMatchObject({
      ok: false,
      phase: "verify",
      code: "continuity.restore.target_identity_mismatch",
      disposition: "quarantine",
    });
  });

  it("rejects a journal root that overlaps the materialized source", async () => {
    const fixture = await makeFixture();
    const journalRoot = path.join(fixture.materializedRoot, "journal");
    await fs.mkdir(journalRoot, { mode: 0o700 });
    const request = { ...fixture.request, journalRoot };

    const result = await backupActivateManagedCommand(runtime, JSON.stringify(request));

    expect(result).toMatchObject({
      ok: false,
      phase: "preflight",
      code: "continuity.restore.plan_mismatch",
      disposition: "quarantine",
    });
    await expect(fs.readdir(journalRoot)).resolves.toEqual([]);
  });

  it("rejects a journal root whose ancestor aliases the materialized source", async () => {
    const fixture = await makeFixture();
    const journalRoot = path.join(fixture.materializedRoot, "aliased-journal");
    const aliasParent = path.join(path.dirname(fixture.materializedRoot), "materialized-alias");
    await fs.mkdir(journalRoot, { mode: 0o700 });
    await fs.symlink(fixture.materializedRoot, aliasParent, "dir");
    const request = { ...fixture.request, journalRoot: path.join(aliasParent, "aliased-journal") };

    const result = await backupActivateManagedCommand(runtime, JSON.stringify(request));

    expect(result).toMatchObject({
      ok: false,
      phase: "preflight",
      code: "continuity.restore.plan_mismatch",
      disposition: "quarantine",
    });
    await expect(fs.readdir(journalRoot)).resolves.toEqual([]);
  });

  it("returns a typed failure when the journal root is unavailable", async () => {
    const fixture = await makeFixture();
    await fs.rm(fixture.journalRoot, { recursive: true });

    const result = await backupActivateManagedCommand(runtime, fixture.requestRaw);

    expect(result).toEqual({
      version: "continuity-restore-execution-result/v1",
      ok: false,
      restoreIdentity: "restore-1",
      executionIncarnationIdentity: EXECUTION_ID,
      phase: "preflight",
      code: "continuity.restore.plan_mismatch",
      disposition: "quarantine",
    });
  });

  it("rejects legacy payloads that collide with reserved claim evidence", async () => {
    const fixture = await makeFixture({ claimMarkerPayload: true });

    const result = await backupActivateManagedCommand(runtime, fixture.requestRaw);

    expect(result).toMatchObject({
      ok: false,
      phase: "preflight",
      code: "continuity.restore.plan_mismatch",
      disposition: "quarantine",
    });
    await expect(fs.access(fixture.stateTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
