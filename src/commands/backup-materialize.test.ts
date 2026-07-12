import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfigSchema } from "../config/schema.js";
import { createContinuityArchive } from "../continuity/archive-create.js";
import { resolveContinuityArchivePlanFromPaths } from "../continuity/archive-plan.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { backupMaterializeCommand } from "./backup-materialize.js";

const tempDirs: string[] = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-materialize-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(stateDir, "workspace");
  const oauthDir = path.join(stateDir, "credentials");
  const outputPath = path.join(root, "continuity.tar.gz");
  const destination = path.join(root, "offline-root");
  await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(oauthDir, { recursive: true });
  await fs.writeFile(configPath, `{ gateway: { port: 18789 } }`);
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace");
  await fs.writeFile(path.join(workspaceDir, "tool.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
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
  await createContinuityArchive({
    plan,
    outputPath,
    stagingParent: path.join(root, "staging"),
    nowMs: 0,
  });
  return { root, stateDir, configPath, databasePath, outputPath, destination, plan };
}

function materializedPath(params: {
  destination: string;
  archiveRoot: string;
  archivePath: string;
}): string {
  const payloadRoot = path.posix.join(params.archiveRoot, "payload");
  const relativePath = path.posix.relative(payloadRoot, params.archivePath);
  return path.join(params.destination, ...relativePath.split("/"));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("backupMaterializeCommand", () => {
  it("materializes continuity components in declared order into a clean offline root", async () => {
    const fixture = await makeFixture();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const result = await backupMaterializeCommand(runtime, {
      archive: fixture.outputPath,
      destination: fixture.destination,
    });

    expect(result).toMatchObject({
      ok: true,
      destination: fixture.destination,
      archiveRoot: fixture.plan.archiveRoot,
      activated: false,
      effectiveArchived: false,
    });
    expect(result.components.map((component) => component.kind)).toEqual([
      "config",
      "state",
      "workspace",
    ]);
    expect(result.components.map((component) => component.restoreOrder)).toEqual([0, 1, 2]);
    expect(result.materializedFileCount).toBe(4);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("does not establish effective Archived"),
    );

    const configAsset = fixture.plan.sources.config[0]!;
    await expect(
      fs.readFile(
        materializedPath({
          destination: fixture.destination,
          archiveRoot: fixture.plan.archiveRoot,
          archivePath: configAsset.archivePath,
        }),
        "utf8",
      ),
    ).resolves.toBe(`{ gateway: { port: 18789 } }`);
    const materializedDatabasePath = materializedPath({
      destination: fixture.destination,
      archiveRoot: fixture.plan.archiveRoot,
      archivePath: path.posix.join(fixture.plan.sources.state.archivePath, "state/openclaw.sqlite"),
    });
    const sqlite = requireNodeSqlite();
    const materializedDatabase = new sqlite.DatabaseSync(materializedDatabasePath, {
      readOnly: true,
    });
    expect(
      materializedDatabase.prepare("SELECT COUNT(*) AS count FROM sessions").get(),
    ).toMatchObject({ count: 1 });
    expect(
      materializedDatabase.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get(),
    ).toMatchObject({ count: 0 });
    materializedDatabase.close();
    const liveDatabase = new sqlite.DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(
      liveDatabase.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get(),
    ).toMatchObject({ count: 1 });
    liveDatabase.close();
    await expect(
      fs.access(
        materializedPath({
          destination: fixture.destination,
          archiveRoot: fixture.plan.archiveRoot,
          archivePath: path.posix.join(
            fixture.plan.sources.state.archivePath,
            "credentials/oauth.json",
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const workspaceAsset = fixture.plan.sources.workspaces[0]!;
    const materializedToolPath = materializedPath({
      destination: fixture.destination,
      archiveRoot: fixture.plan.archiveRoot,
      archivePath: path.posix.join(workspaceAsset.archivePath, "tool.sh"),
    });
    expect((await fs.stat(materializedToolPath)).mode & 0o777).toBe(0o700);
    const receipt = JSON.parse(await fs.readFile(result.receiptPath, "utf8")) as {
      activated: boolean;
      effectiveArchived: boolean;
      archiveSha256: string;
      components: Array<{ id: string }>;
    };
    expect(receipt).toMatchObject({
      activated: false,
      effectiveArchived: false,
      archiveSha256: result.archiveSha256,
    });
    expect(receipt.components.map((component) => component.id)).toEqual(
      result.components.map((component) => component.id),
    );
    await expect(
      fs.access(path.join(fixture.destination, ".openclaw-materialize-incomplete")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite an existing destination", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(fixture.destination);
    await fs.writeFile(path.join(fixture.destination, "sentinel"), "keep");

    await expect(
      backupMaterializeCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: fixture.outputPath, destination: fixture.destination },
      ),
    ).rejects.toThrow(/destination already exists/i);

    await expect(fs.readFile(path.join(fixture.destination, "sentinel"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("rejects a destination nested inside a captured live source before mutation", async () => {
    const fixture = await makeFixture();
    const nestedDestination = path.join(fixture.stateDir, "offline-root");

    await expect(
      backupMaterializeCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: fixture.outputPath, destination: nestedDestination },
      ),
    ).rejects.toThrow(/outside every captured source/i);

    await expect(fs.access(nestedDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("canonicalizes manifest source aliases before destination overlap checks", async () => {
    const fixture = await makeFixture();
    const extractedDirectory = path.join(fixture.root, "aliased-manifest");
    const tamperedArchivePath = path.join(fixture.root, "aliased-source.tar.gz");
    const stateAlias = path.join(fixture.root, "state-alias");
    await fs.symlink(fixture.stateDir, stateAlias, "dir");
    await fs.mkdir(extractedDirectory);
    await tar.x({ file: fixture.outputPath, cwd: extractedDirectory, gzip: true });
    const manifestPath = path.join(extractedDirectory, fixture.plan.archiveRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      assets: Array<{ kind: string; sourcePath: string }>;
    };
    const stateAsset = manifest.assets.find((asset) => asset.kind === "state");
    expect(stateAsset).toBeTruthy();
    stateAsset!.sourcePath = stateAlias;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await tar.c(
      {
        file: tamperedArchivePath,
        cwd: extractedDirectory,
        gzip: true,
        portable: true,
      },
      [fixture.plan.archiveRoot],
    );
    const nestedDestination = path.join(fixture.stateDir, "offline-root");

    await expect(
      backupMaterializeCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: tamperedArchivePath, destination: nestedDestination },
      ),
    ).rejects.toThrow(/outside every captured source/i);

    await expect(fs.access(nestedDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
