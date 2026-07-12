import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";

const AUTH_PROFILE_STORE_TABLES = ["auth_profile_store", "auth_profile_stores"] as const;
const AUTH_PROFILE_STATE_TABLE = "auth_profile_state";

export type ContinuitySqliteSanitizeResult = {
  removedAuthProfileStoreRows: number;
  removedAuthProfileStateRows: number;
};

type FileIdentity = {
  dev: number;
  ino: number;
};

async function assertPrivateSnapshotParent(snapshotPath: string): Promise<void> {
  const parentPath = path.dirname(path.resolve(snapshotPath));
  const [parentStat, canonicalParent] = await Promise.all([
    fs.lstat(parentPath),
    fs.realpath(parentPath),
  ]);
  if (!parentStat.isDirectory() || canonicalParent !== parentPath) {
    throw new Error("Continuity SQLite snapshot parent must be a real directory");
  }
  if (process.platform !== "win32") {
    const getuid = process.getuid;
    if ((parentStat.mode & 0o077) !== 0 || (getuid && parentStat.uid !== getuid())) {
      throw new Error("Continuity SQLite snapshot parent must be owner-private");
    }
  }
}

function resolveTableRowCount(db: DatabaseSync, tableName: string): number {
  const schema = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE")
    .get(tableName) as { type?: unknown } | undefined;
  if (!schema) {
    return 0;
  }
  if (schema.type !== "table") {
    throw new Error(`Continuity sanitation requires ${tableName} to be a table`);
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get() as
    | { count?: unknown }
    | undefined;
  if (typeof row?.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
    throw new Error(`Continuity sanitation could not count ${tableName}`);
  }
  return row.count;
}

function deleteTableRows(db: DatabaseSync, tableName: string): number {
  const count = resolveTableRowCount(db, tableName);
  if (count > 0) {
    db.prepare(`DELETE FROM "${tableName}"`).run();
  }
  return count;
}

function assertNoCredentialTableTriggers(db: DatabaseSync): void {
  const trigger = db
    .prepare(
      `SELECT name, tbl_name
       FROM sqlite_master
       WHERE type = 'trigger'
         AND (
           tbl_name = ? COLLATE NOCASE
           OR tbl_name = ? COLLATE NOCASE
           OR tbl_name = ? COLLATE NOCASE
         )
       LIMIT 1`,
    )
    .get(...AUTH_PROFILE_STORE_TABLES, AUTH_PROFILE_STATE_TABLE) as
    | { name?: unknown; tbl_name?: unknown }
    | undefined;
  if (trigger) {
    throw new Error(
      `Continuity sanitation refuses trigger ${String(trigger.name)} on ${String(trigger.tbl_name)}`,
    );
  }
}

function assertCredentialRowsRemoved(db: DatabaseSync): void {
  for (const tableName of [...AUTH_PROFILE_STORE_TABLES, AUTH_PROFILE_STATE_TABLE]) {
    const count = resolveTableRowCount(db, tableName);
    if (count > 0) {
      throw new Error(
        `Continuity sanitation left ${count} row${count === 1 ? "" : "s"} in ${tableName}`,
      );
    }
  }
}

async function assertDistinctSnapshot(params: {
  sourcePath: string;
  snapshotPath: string;
}): Promise<FileIdentity> {
  const [sourcePath, snapshotPath] = await Promise.all([
    fs.realpath(params.sourcePath),
    fs.realpath(params.snapshotPath),
  ]);
  const [sourceStat, snapshotStat] = await Promise.all([
    fs.stat(sourcePath),
    fs.stat(snapshotPath),
  ]);
  if (!sourceStat.isFile() || !snapshotStat.isFile()) {
    throw new Error("Continuity SQLite sanitation requires regular source and snapshot files");
  }
  if (
    sourcePath === snapshotPath ||
    (sourceStat.dev === snapshotStat.dev && sourceStat.ino === snapshotStat.ino)
  ) {
    throw new Error("Continuity SQLite sanitation refuses to modify the source database");
  }
  return { dev: snapshotStat.dev, ino: snapshotStat.ino };
}

async function assertSnapshotIdentity(snapshotPath: string, expected: FileIdentity): Promise<void> {
  const snapshotStat = await fs.stat(snapshotPath);
  if (snapshotStat.dev !== expected.dev || snapshotStat.ino !== expected.ino) {
    throw new Error("Continuity SQLite snapshot changed before sanitation");
  }
}

/**
 * Remove credential-bearing rows only from an already-created SQLite snapshot.
 * The snapshot must be staged in an owner-private directory. The source path
 * rejects accidental live-database aliases, including hard links and symlinks.
 */
export async function sanitizeContinuitySqliteSnapshot(params: {
  sourcePath: string;
  snapshotPath: string;
}): Promise<ContinuitySqliteSanitizeResult> {
  await assertPrivateSnapshotParent(params.snapshotPath);
  const snapshotIdentity = await assertDistinctSnapshot(params);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const snapshotHandle = await fs.open(params.snapshotPath, fsConstants.O_RDWR | noFollow);
  const sqlite = requireNodeSqlite();
  try {
    const openedStat = await snapshotHandle.stat();
    if (openedStat.dev !== snapshotIdentity.dev || openedStat.ino !== snapshotIdentity.ino) {
      throw new Error("Continuity SQLite snapshot changed before permission hardening");
    }
    await snapshotHandle.chmod(0o600);

    const snapshot = new sqlite.DatabaseSync(params.snapshotPath, { allowExtension: true });
    let transactionOpen = false;
    let removedAuthProfileStoreRows = 0;
    let removedAuthProfileStateRows = 0;
    try {
      // Opening is non-mutating; recheck the path identity before the first SQL
      // write so a replaced path cannot redirect sanitation to the live source.
      await assertSnapshotIdentity(params.snapshotPath, snapshotIdentity);
      await loadSqliteVecExtension({ db: snapshot });
      snapshot.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      assertNoCredentialTableTriggers(snapshot);
      for (const tableName of AUTH_PROFILE_STORE_TABLES) {
        removedAuthProfileStoreRows += deleteTableRows(snapshot, tableName);
      }
      removedAuthProfileStateRows = deleteTableRows(snapshot, AUTH_PROFILE_STATE_TABLE);
      assertCredentialRowsRemoved(snapshot);
      snapshot.exec("COMMIT");
      transactionOpen = false;
      snapshot.exec("VACUUM");
    } catch (error) {
      if (transactionOpen) {
        try {
          snapshot.exec("ROLLBACK");
        } catch (rollbackError) {
          const sanitationMessage = error instanceof Error ? error.message : String(error);
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(
            `Continuity SQLite sanitation failed (${sanitationMessage}); rollback also failed: ${rollbackMessage}`,
            { cause: rollbackError },
          );
        }
      }
      throw error;
    } finally {
      snapshot.close();
    }

    const verified = new sqlite.DatabaseSync(params.snapshotPath, { readOnly: true });
    try {
      assertCredentialRowsRemoved(verified);
    } finally {
      verified.close();
    }
    return {
      removedAuthProfileStoreRows,
      removedAuthProfileStateRows,
    };
  } finally {
    await snapshotHandle.close();
  }
}
