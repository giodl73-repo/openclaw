import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { sanitizeContinuitySqliteSnapshot } from "./sqlite-sanitize.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("continuity SQLite sanitation", () => {
  it("removes credential and reconstructed-state rows only from the copied snapshot", async () => {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "live.sqlite");
    const snapshotPath = path.join(dir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec(`
      PRAGMA secure_delete = OFF;
      CREATE TABLE auth_profile_store (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
      INSERT INTO auth_profile_store VALUES
        ('primary', '{"secret":"AGENT_SECRET_MARKER"}', 1);
      INSERT INTO auth_profile_stores VALUES
        ('main', '{"secret":"GLOBAL_SECRET_MARKER"}', 1);
      INSERT INTO auth_profile_state VALUES
        ('openai:default', '{"cooldownUntil":123}', 1);
      INSERT INTO sessions VALUES ('session-1');
    `);
    source.prepare("VACUUM INTO ?").run(snapshotPath);
    source.close();

    await expect(sanitizeContinuitySqliteSnapshot({ sourcePath, snapshotPath })).resolves.toEqual({
      removedAuthProfileStoreRows: 2,
      removedAuthProfileStateRows: 1,
    });

    const live = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    const snapshot = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
    try {
      expect(live.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get()).toEqual({
        count: 1,
      });
      expect(live.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get()).toEqual({
        count: 1,
      });
      expect(live.prepare("SELECT COUNT(*) AS count FROM auth_profile_state").get()).toEqual({
        count: 1,
      });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get()).toEqual({
        count: 0,
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

    const snapshotBytes = await fs.readFile(snapshotPath);
    expect(snapshotBytes.includes(Buffer.from("AGENT_SECRET_MARKER"))).toBe(false);
    expect(snapshotBytes.includes(Buffer.from("GLOBAL_SECRET_MARKER"))).toBe(false);
    expect((await fs.stat(snapshotPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses the source database through direct, symlink, and hard-link paths", async () => {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "live.sqlite");
    const symlinkPath = path.join(dir, "linked.sqlite");
    const hardLinkPath = path.join(dir, "hard-linked.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_store VALUES ('primary', '{"secret":"still-live"}', 1);
    `);
    source.close();
    await fs.symlink(sourcePath, symlinkPath);
    await fs.link(sourcePath, hardLinkPath);

    for (const snapshotPath of [sourcePath, symlinkPath, hardLinkPath]) {
      await expect(sanitizeContinuitySqliteSnapshot({ sourcePath, snapshotPath })).rejects.toThrow(
        /refuses to modify the source database/,
      );
    }

    const verified = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      expect(verified.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get()).toEqual({
        count: 1,
      });
    } finally {
      verified.close();
    }
  });

  it("refuses snapshots outside an owner-private staging directory", async () => {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "live.sqlite");
    const snapshotDir = path.join(dir, "shared");
    const snapshotPath = path.join(snapshotDir, "snapshot.sqlite");
    await fs.mkdir(snapshotDir, { mode: 0o777 });
    await fs.chmod(snapshotDir, 0o777);
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    source.prepare("VACUUM INTO ?").run(snapshotPath);
    source.close();

    await expect(sanitizeContinuitySqliteSnapshot({ sourcePath, snapshotPath })).rejects.toThrow(
      /snapshot parent must be owner-private/,
    );
  });

  it("sanitizes credential tables using SQLite case-insensitive identifiers", async () => {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "live.sqlite");
    const snapshotPath = path.join(dir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE AUTH_PROFILE_STORE (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO AUTH_PROFILE_STORE VALUES ('primary', '{"secret":"case-variant"}', 1);
    `);
    source.prepare("VACUUM INTO ?").run(snapshotPath);
    source.close();

    await expect(
      sanitizeContinuitySqliteSnapshot({ sourcePath, snapshotPath }),
    ).resolves.toMatchObject({ removedAuthProfileStoreRows: 1 });

    const verified = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
    try {
      expect(verified.prepare("SELECT COUNT(*) AS count FROM AUTH_PROFILE_STORE").get()).toEqual({
        count: 0,
      });
    } finally {
      verified.close();
    }
  });

  it("fails closed when a known credential object is not a table", async () => {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "live.sqlite");
    const snapshotPath = path.join(dir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE hidden_credentials (store_key TEXT, store_json TEXT);
      INSERT INTO hidden_credentials VALUES ('primary', '{"secret":"hidden"}');
      CREATE VIEW auth_profile_store AS
        SELECT store_key, store_json, 1 AS updated_at FROM hidden_credentials;
    `);
    source.prepare("VACUUM INTO ?").run(snapshotPath);
    source.close();

    await expect(sanitizeContinuitySqliteSnapshot({ sourcePath, snapshotPath })).rejects.toThrow(
      /auth_profile_store to be a table/,
    );
  });

  it("rejects triggers that can retain deleted credential values", async () => {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "live.sqlite");
    const snapshotPath = path.join(dir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE retained_values (value TEXT NOT NULL);
      INSERT INTO auth_profile_store VALUES ('primary', '{"secret":"reinserted"}', 1);
      CREATE TRIGGER retain_auth_profile_store
      AFTER DELETE ON auth_profile_store
      BEGIN
        INSERT INTO retained_values VALUES (OLD.store_json);
      END;
    `);
    source.prepare("VACUUM INTO ?").run(snapshotPath);
    source.close();

    await expect(sanitizeContinuitySqliteSnapshot({ sourcePath, snapshotPath })).rejects.toThrow(
      /refuses trigger retain_auth_profile_store on auth_profile_store/,
    );
    expect((await fs.stat(snapshotPath)).mode & 0o777).toBe(0o600);

    const verified = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
    try {
      expect(verified.prepare("SELECT COUNT(*) AS count FROM retained_values").get()).toEqual({
        count: 0,
      });
      expect(verified.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get()).toEqual({
        count: 1,
      });
    } finally {
      verified.close();
    }
  });
});
