import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfigSchema } from "../config/schema.js";
import { createContinuityArchive } from "../continuity/archive-create.js";
import type { ContinuityArchiveObligations } from "../continuity/archive-obligations.js";
import { resolveContinuityArchivePlanFromPaths } from "../continuity/archive-plan.js";
import type { ContinuityArchivePlan } from "../continuity/archive-plan.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
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
  const workspaceDatabasePath = path.join(workspaceDir, "openclaw.sqlite");
  const pluginDatabasePath = path.join(
    stateDir,
    "state",
    "extensions",
    "example",
    "openclaw.sqlite",
  );
  const agentDatabasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
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
    PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
  `);
  database.close();
  await fs.mkdir(path.dirname(agentDatabasePath), { recursive: true });
  const agentDatabase = new sqlite.DatabaseSync(agentDatabasePath);
  agentDatabase.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
  `);
  agentDatabase.close();
  const workspaceDatabase = new sqlite.DatabaseSync(workspaceDatabasePath);
  workspaceDatabase.exec("PRAGMA user_version = 999;");
  workspaceDatabase.close();
  await fs.mkdir(path.dirname(pluginDatabasePath), { recursive: true });
  const pluginDatabase = new sqlite.DatabaseSync(pluginDatabasePath);
  pluginDatabase.exec("PRAGMA user_version = 999;");
  pluginDatabase.close();
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
  return {
    root,
    stateDir,
    configPath,
    databasePath,
    agentDatabasePath,
    pluginDatabasePath,
    workspaceDatabasePath,
    outputPath,
    destination,
    plan,
  };
}

async function rewriteArchive(params: {
  root: string;
  archivePath: string;
  plan: ContinuityArchivePlan;
  name: string;
  mutate: (extractedDirectory: string) => Promise<void>;
}): Promise<string> {
  const extractedDirectory = path.join(params.root, `${params.name}-extracted`);
  const rewrittenArchivePath = path.join(params.root, `${params.name}.tar.gz`);
  await fs.mkdir(extractedDirectory);
  await tar.x({ file: params.archivePath, cwd: extractedDirectory, gzip: true });
  await params.mutate(extractedDirectory);
  await tar.c(
    {
      file: rewrittenArchivePath,
      cwd: extractedDirectory,
      gzip: true,
      portable: true,
    },
    [params.plan.archiveRoot],
  );
  return rewrittenArchivePath;
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
      activationReady: false,
      effectiveArchived: false,
      compatibility: {
        runtimeDecision: "same-or-older",
        platformDecision: "same-platform",
      },
      surfaces: {
        reconstructionPerformed: false,
        externalDependenciesResolved: false,
        transientsCreated: false,
      },
    });
    expect(result.compatibility.sqliteSchemas).toEqual([
      expect.objectContaining({
        kind: "agent-state",
        schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
      expect.objectContaining({
        kind: "other",
        schemaVersion: 999,
        supportedVersion: null,
      }),
      expect.objectContaining({
        kind: "shared-state",
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      }),
    ]);
    expect(result.surfaces.obligations).toMatchObject({
      reconstructed: {
        authProfileRuntimeState: {
          treatment: "safe-empty-default",
          readiness: "non-blocking",
          removedRowCount: 0,
        },
        pluginRuntimeDependencies: {
          treatment: "owner-reinstall",
          readiness: "owner-required",
          omittedTreeCount: 0,
        },
      },
      external: {
        configSecretReferences: { readiness: "owner-required" },
        authProfileCredentials: { credentialRows: 0, oauthCaptured: false },
      },
      ephemeral: {
        runtimeTransients: { treatment: "normal-startup", readiness: "owner-owned" },
      },
    });
    expect(result.components.map((component) => component.kind)).toEqual([
      "config",
      "state",
      "workspace",
    ]);
    expect(result.components.map((component) => component.restoreOrder)).toEqual([0, 1, 2]);
    expect(result.materializedFileCount).toBe(7);
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
      activationReady: boolean;
      archiveSha256: string;
      components: Array<{ id: string }>;
      compatibility: { sqliteSchemas: Array<{ kind: string }> };
      surfaces: { obligations: ContinuityArchiveObligations };
    };
    expect(receipt).toMatchObject({
      activated: false,
      activationReady: false,
      effectiveArchived: false,
      archiveSha256: result.archiveSha256,
    });
    expect(receipt.compatibility.sqliteSchemas).toEqual(result.compatibility.sqliteSchemas);
    expect(receipt.surfaces.obligations).toEqual(result.surfaces.obligations);
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

  it.each([
    ["newer", "9999.0.0", /runtime .* is newer/i],
    ["malformed", "not-a-version", /requires exact semantic versions/i],
  ])(
    "rejects a %s artifact runtime before creating the destination",
    async (_name, runtimeVersion, expectedError) => {
      const fixture = await makeFixture();
      const archivePath = await rewriteArchive({
        root: fixture.root,
        archivePath: fixture.outputPath,
        plan: fixture.plan,
        name: `runtime-${runtimeVersion}`,
        mutate: async (extractedDirectory) => {
          const manifestPath = path.join(
            extractedDirectory,
            fixture.plan.archiveRoot,
            "manifest.json",
          );
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
            runtimeVersion: string;
          };
          manifest.runtimeVersion = runtimeVersion;
          await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        },
      });

      await expect(
        backupMaterializeCommand(
          { log: () => {}, error: () => {}, exit: () => {} },
          { archive: archivePath, destination: fixture.destination },
        ),
      ).rejects.toThrow(expectedError);
      await expect(fs.access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a different artifact platform before creating the destination", async () => {
    const fixture = await makeFixture();
    const archivePath = await rewriteArchive({
      root: fixture.root,
      archivePath: fixture.outputPath,
      plan: fixture.plan,
      name: "platform-mismatch",
      mutate: async (extractedDirectory) => {
        const manifestPath = path.join(
          extractedDirectory,
          fixture.plan.archiveRoot,
          "manifest.json",
        );
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
          platform: string;
        };
        manifest.platform = process.platform === "linux" ? "darwin" : "linux";
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    });

    await expect(
      backupMaterializeCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: archivePath, destination: fixture.destination },
      ),
    ).rejects.toThrow(/does not match this local runtime platform/i);
    await expect(fs.access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["shared", "state/openclaw.sqlite", OPENCLAW_STATE_SCHEMA_VERSION + 1],
    ["agent", "agents/main/agent/openclaw-agent.sqlite", OPENCLAW_AGENT_SCHEMA_VERSION + 1],
  ])("rejects a newer %s core SQLite schema", async (name, relativePath, schemaVersion) => {
    const fixture = await makeFixture();
    const archivePath = await rewriteArchive({
      root: fixture.root,
      archivePath: fixture.outputPath,
      plan: fixture.plan,
      name: `newer-${name}-schema`,
      mutate: async (extractedDirectory) => {
        const databasePath = path.join(
          extractedDirectory,
          ...path.posix.join(fixture.plan.sources.state.archivePath, relativePath).split("/"),
        );
        const sqlite = requireNodeSqlite();
        const database = new sqlite.DatabaseSync(databasePath);
        database.exec(`PRAGMA user_version = ${schemaVersion};`);
        database.close();
      },
    });

    await expect(
      backupMaterializeCommand(
        { log: () => {}, error: () => {}, exit: () => {} },
        { archive: archivePath, destination: fixture.destination },
      ),
    ).rejects.toThrow(/uses newer schema version/i);
    await expect(fs.access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
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
