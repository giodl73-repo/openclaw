import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { backupVerifyCommand, parseBackupManifest } from "../commands/backup-verify.js";
import { buildConfigSchema } from "../config/schema.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createContinuityArchive } from "./archive-create.js";
import { resolveContinuityArchivePlanFromPaths } from "./archive-plan.js";

const tempDirs: string[] = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-create-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(stateDir, "workspace");
  const oauthDir = path.join(stateDir, "credentials");
  const stagingParent = path.join(root, "staging");
  const outputPath = path.join(root, "continuity.tar.gz");
  await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(oauthDir, { recursive: true });
  await fs.writeFile(configPath, `{ gateway: { port: 18789 } }`);
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace");
  await fs.writeFile(path.join(oauthDir, "oauth.json"), "credential");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_stores (
      store_key TEXT PRIMARY KEY,
      store_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO auth_profile_stores VALUES ('main', '{"secret":"LIVE_SECRET"}', 1);
    INSERT INTO sessions VALUES ('session-1');
  `);
  database.close();
  const configRaw = await fs.readFile(configPath, "utf8");
  const plan = resolveContinuityArchivePlanFromPaths({
    stateDir,
    configPath,
    configRaw,
    oauthDir,
    workspaceDirs: [workspaceDir],
    uiHints: buildConfigSchema().uiHints,
    extensionMetadataComplete: true,
    nowMs: 0,
  });
  return { root, outputPath, stagingParent, workspaceDir, plan };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("continuity archive creation", () => {
  it("publishes a verified immutable continuity artifact", async () => {
    const fixture = await makeFixture();

    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });
    const verified = await backupVerifyCommand(
      { log: () => {}, error: () => {}, exit: () => {} },
      { archive: fixture.outputPath },
    );

    expect(created).toMatchObject({
      ok: true,
      archivePath: fixture.outputPath,
      archiveRoot: fixture.plan.archiveRoot,
      archiveSha256: verified.archiveSha256,
      manifestSha256: verified.manifestSha256,
    });
    expect(verified.artifactType).toBe("continuity");
    expect(verified.continuityCapture).toMatchObject({
      targetLevel: "archived",
      eligible: true,
      evidence: {
        oauthExcluded: true,
        credentialStoreRows: 0,
        authProfileStateRows: 0,
      },
    });
    expect(verified.continuityObligations).toMatchObject({
      reconstructed: {
        authProfileRuntimeState: { removedRowCount: 0, readiness: "non-blocking" },
        pluginRuntimeDependencies: { omittedTreeCount: 0, readiness: "owner-required" },
      },
      external: {
        authProfileCredentials: { removedRowCount: 1, credentialRows: 0, oauthCaptured: false },
      },
    });
    expect((await fs.stat(fixture.outputPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(fixture.stagingParent)).toEqual([]);
  });

  it("refuses to overwrite an existing artifact", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(fixture.outputPath, "existing");

    await expect(
      createContinuityArchive({
        plan: fixture.plan,
        outputPath: fixture.outputPath,
        stagingParent: fixture.stagingParent,
      }),
    ).rejects.toThrow(/refusing to overwrite/i);

    expect(await fs.readFile(fixture.outputPath, "utf8")).toBe("existing");
  });

  it("does not treat workspace SQLite files as sanitized OpenClaw state snapshots", async () => {
    const fixture = await makeFixture();
    const workspaceDatabasePath = path.join(fixture.workspaceDir, "project.sqlite");
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(workspaceDatabasePath);
    database.exec(`
      CREATE TABLE auth_profile_stores (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_stores VALUES ('project', '{"notOpenClawAuth":true}', 1);
    `);
    database.close();

    await expect(
      createContinuityArchive({
        plan: fixture.plan,
        outputPath: fixture.outputPath,
        stagingParent: fixture.stagingParent,
      }),
    ).resolves.toMatchObject({
      ok: true,
      continuityCapture: {
        evidence: { sqliteSnapshotCount: 1 },
      },
    });
  });

  it("rejects success-shaped evidence that disagrees with packaged files", async () => {
    const fixture = await makeFixture();
    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });
    const extractedDir = path.join(fixture.root, "extracted");
    const tamperedPath = path.join(fixture.root, "tampered.tar.gz");
    await fs.mkdir(extractedDir);
    await tar.x({ file: fixture.outputPath, cwd: extractedDir, gzip: true });
    const manifestPath = path.join(extractedDir, created.archiveRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      continuityCapture: { evidence: { copiedFileCount: number } };
    };
    manifest.continuityCapture.evidence.copiedFileCount += 1;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await tar.c(
      {
        file: tamperedPath,
        cwd: extractedDir,
        gzip: true,
        portable: true,
      },
      [created.archiveRoot],
    );

    await expect(
      backupVerifyCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: tamperedPath },
      ),
    ).rejects.toThrow(/file count does not match/i);
  });

  it("rejects unknown artifact obligation ownership during verification", async () => {
    const fixture = await makeFixture();
    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });
    const extractedDir = path.join(fixture.root, "unknown-obligation");
    const tamperedPath = path.join(fixture.root, "unknown-obligation.tar.gz");
    await fs.mkdir(extractedDir);
    await tar.x({ file: fixture.outputPath, cwd: extractedDir, gzip: true });
    const manifestPath = path.join(extractedDir, created.archiveRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      continuityObligations: {
        reconstructed: { authProfileRuntimeState: { owner: string } };
      };
    };
    manifest.continuityObligations.reconstructed.authProfileRuntimeState.owner = "runtime";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await tar.c(
      {
        file: tamperedPath,
        cwd: extractedDir,
        gzip: true,
        portable: true,
      },
      [created.archiveRoot],
    );

    await expect(
      backupVerifyCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: tamperedPath },
      ),
    ).rejects.toThrow(/obligation owner/i);
  });

  it("does not let ordinary backups claim continuity obligations", async () => {
    const fixture = await makeFixture();
    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });

    expect(() =>
      parseBackupManifest(
        JSON.stringify({
          schemaVersion: 1,
          artifactType: "backup",
          createdAt: created.createdAt,
          archiveRoot: "backup",
          runtimeVersion: "1.0.0",
          platform: process.platform,
          nodeVersion: process.version,
          assets: [],
          continuityObligations: created.continuityObligations,
        }),
      ),
    ).toThrow(/Ordinary backup artifacts cannot claim continuity capture metadata/);
  });

  it("reopens packaged SQLite snapshots and rejects credential-row tampering", async () => {
    const fixture = await makeFixture();
    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });
    const extractedDir = path.join(fixture.root, "sqlite-tamper");
    const tamperedPath = path.join(fixture.root, "sqlite-tampered.tar.gz");
    await fs.mkdir(extractedDir);
    await tar.x({ file: fixture.outputPath, cwd: extractedDir, gzip: true });
    const manifestPath = path.join(extractedDir, created.archiveRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      assets: Array<{ kind: string; archivePath: string }>;
    };
    const statePath = manifest.assets.find((asset) => asset.kind === "state")?.archivePath;
    expect(statePath).toBeTruthy();
    const databasePath = path.join(
      extractedDir,
      ...`${statePath}/state/openclaw.sqlite`.split("/"),
    );
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    database
      .prepare("INSERT INTO auth_profile_stores VALUES (?, ?, ?)")
      .run("tampered", '{"secret":"RESTORED_SECRET"}', 2);
    database.close();
    await tar.c(
      {
        file: tamperedPath,
        cwd: extractedDir,
        gzip: true,
        portable: true,
      },
      [created.archiveRoot],
    );

    await expect(
      backupVerifyCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: tamperedPath },
      ),
    ).rejects.toThrow(/left 1 row in auth_profile_stores/i);
  });

  it("rejects unlisted SQLite files injected beneath the state asset", async () => {
    const fixture = await makeFixture();
    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });
    const extractedDir = path.join(fixture.root, "unlisted-sqlite");
    const tamperedPath = path.join(fixture.root, "unlisted-sqlite.tar.gz");
    await fs.mkdir(extractedDir);
    await tar.x({ file: fixture.outputPath, cwd: extractedDir, gzip: true });
    const manifestPath = path.join(extractedDir, created.archiveRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      assets: Array<{ kind: string; archivePath: string }>;
      continuityCapture: { evidence: { copiedFileCount: number } };
    };
    const statePath = manifest.assets.find((asset) => asset.kind === "state")?.archivePath;
    expect(statePath).toBeTruthy();
    const injectedPath = path.join(extractedDir, ...`${statePath}/injected.sqlite`.split("/"));
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(injectedPath);
    database.exec(`
      CREATE TABLE auth_profile_stores (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_stores VALUES ('injected', '{"secret":"INJECTED"}', 1);
    `);
    database.close();
    manifest.continuityCapture.evidence.copiedFileCount += 1;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await tar.c(
      {
        file: tamperedPath,
        cwd: extractedDir,
        gzip: true,
        portable: true,
      },
      [created.archiveRoot],
    );

    await expect(
      backupVerifyCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: tamperedPath },
      ),
    ).rejects.toThrow(/state and SQLite inventories/i);
  });

  it("rejects listed SQLite sidecars beneath the state asset", async () => {
    const fixture = await makeFixture();
    const created = await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });
    const extractedDir = path.join(fixture.root, "sqlite-sidecar");
    const tamperedPath = path.join(fixture.root, "sqlite-sidecar.tar.gz");
    await fs.mkdir(extractedDir);
    await tar.x({ file: fixture.outputPath, cwd: extractedDir, gzip: true });
    const manifestPath = path.join(extractedDir, created.archiveRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      assets: Array<{ kind: string; archivePath: string }>;
      stateFilePaths: string[];
      continuityCapture: { evidence: { copiedFileCount: number } };
    };
    const statePath = manifest.assets.find((asset) => asset.kind === "state")?.archivePath;
    expect(statePath).toBeTruthy();
    const sidecarPath = `${statePath}/injected.sqlite-wal`;
    await fs.writeFile(path.join(extractedDir, ...sidecarPath.split("/")), "injected");
    manifest.stateFilePaths.push(sidecarPath);
    manifest.continuityCapture.evidence.copiedFileCount += 1;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await tar.c(
      {
        file: tamperedPath,
        cwd: extractedDir,
        gzip: true,
        portable: true,
      },
      [created.archiveRoot],
    );

    await expect(
      backupVerifyCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: tamperedPath },
      ),
    ).rejects.toThrow(/state and SQLite inventories/i);
  });

  it("bounds selected config and SQLite extraction bytes during verification", async () => {
    const fixture = await makeFixture();
    await createContinuityArchive({
      plan: fixture.plan,
      outputPath: fixture.outputPath,
      stagingParent: fixture.stagingParent,
      nowMs: 0,
    });

    await expect(
      backupVerifyCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: fixture.outputPath, maxContentBytes: 1 },
      ),
    ).rejects.toThrow(/content exceeds the 1-byte limit/i);
  });
});
