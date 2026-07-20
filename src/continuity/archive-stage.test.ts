import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfigSchema } from "../config/schema.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveContinuityArchivePlanFromPaths } from "./archive-plan.js";
import { stageContinuityArchivePlan } from "./archive-stage.js";

const tempDirs: string[] = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-stage-test-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(stateDir, "workspace");
  const oauthDir = path.join(stateDir, "credentials");
  const configPath = path.join(stateDir, "openclaw.json");
  const stagingParent = path.join(root, "staging");
  await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(oauthDir, { recursive: true });
  await fs.writeFile(configPath, `{ gateway: { port: 18789 } }`);
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace");
  await fs.writeFile(path.join(oauthDir, "oauth.json"), "credential");
  await fs.writeFile(path.join(stateDir, "settings.json"), "{}");
  return { root, stateDir, workspaceDir, oauthDir, configPath, stagingParent };
}

function createStateDatabase(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_stores (
      store_key TEXT PRIMARY KEY,
      store_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE auth_profile_state (
      profile_key TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO auth_profile_stores VALUES ('main', '{"secret":"LIVE_SECRET"}', 1);
    INSERT INTO auth_profile_state VALUES ('profile', '{"cooldownUntil":123}', 1);
    INSERT INTO sessions VALUES ('session-1');
  `);
  database.close();
}

async function createPlan(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  const configRaw = await fs.readFile(fixture.configPath, "utf8");
  return resolveContinuityArchivePlanFromPaths({
    stateDir: fixture.stateDir,
    configPath: fixture.configPath,
    configRaw,
    oauthDir: fixture.oauthDir,
    workspaceDirs: [fixture.workspaceDir],
    uiHints: buildConfigSchema().uiHints,
    extensionMetadataComplete: true,
    nowMs: 0,
  });
}

function stagedPath(stagingDir: string, archivePath: string): string {
  return path.join(stagingDir, ...archivePath.split("/"));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("continuity archive staging", () => {
  it("stages separated sources and sanitized SQLite snapshots without mutating live state", async () => {
    const fixture = await makeFixture();
    const databasePath = path.join(fixture.stateDir, "state", "openclaw.sqlite");
    createStateDatabase(databasePath);
    const plan = await createPlan(fixture);

    const staged = await stageContinuityArchivePlan({
      plan,
      stagingParent: fixture.stagingParent,
    });

    const stagedDatabasePath = path.join(
      stagedPath(staged.stagingDir, plan.sources.state.archivePath),
      "state",
      "openclaw.sqlite",
    );
    const sqlite = requireNodeSqlite();
    const live = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    const snapshot = new sqlite.DatabaseSync(stagedDatabasePath, { readOnly: true });
    try {
      expect(live.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get()).toEqual({
        count: 1,
      });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get()).toEqual({
        count: 0,
      });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM auth_profile_state").get()).toEqual({
        count: 0,
      });
      expect(snapshot.prepare("SELECT id FROM sessions").get()).toEqual({ id: "session-1" });
    } finally {
      live.close();
      snapshot.close();
    }

    await expect(
      fs.access(stagedPath(staged.stagingDir, plan.sources.config[0]!.archivePath)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(stagedPath(staged.stagingDir, plan.sources.workspaces[0]!.archivePath)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(stagedPath(staged.stagingDir, plan.sources.state.archivePath), "credentials"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(staged.evidence).toMatchObject({
      oauthExcluded: true,
      legacyDeliveryQueueCount: 0,
      legacyTranscriptCount: 0,
      sqliteSnapshotCount: 1,
      removedAuthProfileStoreRows: 1,
      removedAuthProfileStateRows: 1,
      credentialStoreRows: 0,
      authProfileStateRows: 0,
    });
    expect((await fs.stat(staged.stagingDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(stagedDatabasePath)).mode & 0o777).toBe(0o600);
  });

  it("replaces the canonical global SQLite symlink with a regular sanitized snapshot", async () => {
    const fixture = await makeFixture();
    const databaseTargetPath = path.join(fixture.root, "global.sqlite");
    const databasePath = path.join(fixture.stateDir, "state", "openclaw.sqlite");
    createStateDatabase(databaseTargetPath);
    await fs.symlink(databaseTargetPath, databasePath);
    const plan = await createPlan(fixture);

    const staged = await stageContinuityArchivePlan({
      plan,
      stagingParent: fixture.stagingParent,
    });

    const stagedDatabasePath = path.join(
      stagedPath(staged.stagingDir, plan.sources.state.archivePath),
      "state",
      "openclaw.sqlite",
    );
    const stagedStat = await fs.lstat(stagedDatabasePath);
    expect(stagedStat.isFile()).toBe(true);
    expect(stagedStat.isSymbolicLink()).toBe(false);
  });

  it("rejects config changes after classification and removes incomplete staging", async () => {
    const fixture = await makeFixture();
    const plan = await createPlan(fixture);
    await fs.writeFile(fixture.configPath, `{ gateway: { port: 18888 } }`);

    await expect(
      stageContinuityArchivePlan({
        plan,
        stagingParent: fixture.stagingParent,
      }),
    ).rejects.toThrow(/config changed after classification/);

    expect(await fs.readdir(fixture.stagingParent)).toEqual([]);
  });

  it("rejects a legacy delivery queue entry that appears after planning", async () => {
    const fixture = await makeFixture();
    const plan = await createPlan(fixture);
    const queueDir = path.join(fixture.stateDir, "delivery-queue");
    await fs.mkdir(queueDir);
    await fs.writeFile(path.join(queueDir, "pending.json"), "{}\n");

    await expect(
      stageContinuityArchivePlan({
        plan,
        stagingParent: fixture.stagingParent,
      }),
    ).rejects.toThrow(/Legacy delivery queue input appeared/);

    expect(await fs.readdir(fixture.stagingParent)).toEqual([]);
  });

  it("omits and counts each installed plugin dependency tree once", async () => {
    const fixture = await makeFixture();
    const plan = await createPlan(fixture);
    const dependencyTree = path.join(fixture.stateDir, "extensions", "example", "node_modules");
    await fs.mkdir(path.join(dependencyTree, "package-a"), { recursive: true });
    await fs.writeFile(path.join(dependencyTree, "package-a", "index.js"), "module.exports = {};");

    const staged = await stageContinuityArchivePlan({
      plan,
      stagingParent: fixture.stagingParent,
    });

    expect(staged.evidence.omittedPluginDependencyTreeCount).toBe(1);
    await expect(
      fs.access(
        path.join(
          stagedPath(staged.stagingDir, plan.sources.state.archivePath),
          "extensions",
          "example",
          "node_modules",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects staging beneath a source before creating any live-state path", async () => {
    const fixture = await makeFixture();
    const plan = await createPlan(fixture);
    const stagingParent = path.join(fixture.stateDir, "continuity-staging");

    await expect(
      stageContinuityArchivePlan({
        plan,
        stagingParent,
      }),
    ).rejects.toThrow(/staging must be outside every capture source/);

    await expect(fs.access(stagingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinks instead of producing an artifact retrieval would refuse", async () => {
    const fixture = await makeFixture();
    const plan = await createPlan(fixture);
    await fs.symlink(
      path.join(fixture.stateDir, "settings.json"),
      path.join(fixture.stateDir, "link"),
    );

    await expect(
      stageContinuityArchivePlan({
        plan,
        stagingParent: fixture.stagingParent,
      }),
    ).rejects.toThrow(/refuses symbolic links/);
  });

  it("rejects hard links that could alias excluded credential bytes", async () => {
    const fixture = await makeFixture();
    const plan = await createPlan(fixture);
    await fs.link(
      path.join(fixture.oauthDir, "oauth.json"),
      path.join(fixture.stateDir, "credential-alias.json"),
    );

    await expect(
      stageContinuityArchivePlan({
        plan,
        stagingParent: fixture.stagingParent,
      }),
    ).rejects.toThrow(/refuses hard-linked files/);
  });
});
