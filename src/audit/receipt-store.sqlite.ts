// Shared receipt SQLite store owns durable, cross-agent business outcome records.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Generated, Insertable, Selectable } from "kysely";
import type { AgentToolReceipt } from "../../packages/agent-core/src/types.js";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "../utils.js";

const RECEIPT_STORE_SCHEMA_VERSION = 1;
const RECEIPT_STORE_DIR_MODE = 0o700;
const RECEIPT_STORE_FILE_MODE = 0o600;
const RECEIPT_STORE_BUSY_TIMEOUT_MS = 50;
const RECEIPT_DATA_MAX_BYTES = 256 * 1024;

type ReceiptTable = {
  sequence: Generated<number>;
  receipt_id: string;
  source_id: string;
  payload_sha256: string;
  schema_version: number;
  receipt_type: string;
  receipt_version: number | null;
  occurred_at: number;
  agent_id: string;
  session_id: string;
  session_key: string | null;
  run_id: string;
  invocation_id: string | null;
  skill_name: string | null;
  skill_digest: string | null;
  tool_name: string;
  tool_call_id: string;
  receipt_index: number;
  subject_type: string | null;
  subject_id: string | null;
  data_json: string | null;
};

type ReceiptDatabase = { receipts: ReceiptTable };
type ReceiptRow = Selectable<ReceiptTable>;

type OpenReceiptDatabase = {
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type RecordedAuditReceipt = {
  receiptSchema: "openclaw-audit-receipt";
  schemaVersion: 1;
  sequence: number;
  receiptId: string;
  type: string;
  version?: number;
  occurredAt: number;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  invocationId?: string;
  skillName?: string;
  skillDigest?: string;
  toolName: string;
  toolCallId: string;
  subject?: { type: string; id: string };
  data?: Record<string, unknown>;
};

export type RecordAuditReceiptInput = {
  receipt: AgentToolReceipt;
  receiptIndex: number;
  occurredAt: number;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  invocationId?: string;
  skillName?: string;
  skillDigest?: string;
  toolName: string;
  toolCallId: string;
};

export type AuditReceiptFilters = {
  type?: string;
  agentIds?: string[];
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  invocationId?: string;
  skillName?: string;
  skillDigest?: string;
  toolName?: string;
  toolCallId?: string;
  subjectType?: string;
  subjectId?: string;
  occurredAfter?: number;
  occurredBefore?: number;
};

export type AuditReceiptPage = {
  receipts: RecordedAuditReceipt[];
  nextCursor?: number;
};

type ReceiptStoreOptions = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

const openDatabases = new Map<string, OpenReceiptDatabase>();

function hardenReceiptDatabaseFiles(databasePath: string): void {
  for (const candidate of resolveSqliteDatabaseFilePaths(databasePath)) {
    if (fs.existsSync(candidate)) {
      applyPrivateModeSync(candidate, RECEIPT_STORE_FILE_MODE);
    }
  }
}

export function resolveAuditReceiptStorePath(options: ReceiptStoreOptions = {}): string {
  const configured = options.path ?? options.cfg?.audit?.receipts?.store?.path;
  return configured?.trim()
    ? path.resolve(resolveUserPath(configured.trim(), options.env))
    : path.join(resolveOpenClawStateSqliteDir(options.env), "receipts.sqlite");
}

export function isAuditReceiptStoreEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.audit?.receipts?.enabled !== false;
}

function ensureReceiptSchema(db: DatabaseSync, databasePath: string): void {
  const version = readSqliteUserVersion(db);
  if (version > RECEIPT_STORE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw receipt database ${databasePath} uses schema version ${version}; this runtime supports up to ${RECEIPT_STORE_SCHEMA_VERSION}.`,
    );
  }
  runSqliteImmediateTransactionSync(
    db,
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL UNIQUE,
      payload_sha256 TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      receipt_type TEXT NOT NULL,
      receipt_version INTEGER,
      occurred_at INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT,
      run_id TEXT NOT NULL,
      invocation_id TEXT,
      skill_name TEXT,
      skill_digest TEXT,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      receipt_index INTEGER NOT NULL CHECK (receipt_index >= 0),
      subject_type TEXT,
      subject_id TEXT,
      data_json TEXT,
      CHECK ((subject_type IS NULL) = (subject_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_type_time
      ON receipts(receipt_type, occurred_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_subject_time
      ON receipts(subject_type, subject_id, occurred_at DESC, sequence DESC)
      WHERE subject_type IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_receipts_agent_time
      ON receipts(agent_id, occurred_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_session_time
      ON receipts(session_key, occurred_at DESC, sequence DESC)
      WHERE session_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_receipts_run_time
      ON receipts(run_id, occurred_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_receipts_skill_time
      ON receipts(skill_name, skill_digest, occurred_at DESC, sequence DESC)
      WHERE skill_name IS NOT NULL;
        PRAGMA user_version = ${RECEIPT_STORE_SCHEMA_VERSION};
      `);
    },
    {
      busyTimeoutMs: RECEIPT_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "audit-receipts",
      operationLabel: "schema",
    },
  );
}

function openAuditReceiptDatabase(options: ReceiptStoreOptions = {}): OpenReceiptDatabase {
  const databasePath = resolveAuditReceiptStorePath(options);
  const existing = openDatabases.get(databasePath);
  if (existing?.db.isOpen) {
    return existing;
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: RECEIPT_STORE_DIR_MODE });
  if (!fs.existsSync(databasePath)) {
    fs.closeSync(fs.openSync(databasePath, "a", RECEIPT_STORE_FILE_MODE));
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    applyPrivateModeSync(databasePath, RECEIPT_STORE_FILE_MODE);
    walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: RECEIPT_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "audit-receipts",
      databasePath,
      synchronous: "NORMAL",
    });
    ensureReceiptSchema(db, databasePath);
    hardenReceiptDatabaseFiles(databasePath);
    const opened = { db, path: databasePath, walMaintenance };
    openDatabases.set(databasePath, opened);
    return opened;
  } catch (error) {
    walMaintenance?.close();
    db.close();
    throw error;
  }
}

function parseReceiptData(row: ReceiptRow): Record<string, unknown> | undefined {
  if (!row.data_json) {
    return undefined;
  }
  const parsed = JSON.parse(row.data_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`corrupt audit receipt row ${row.sequence}: data_json is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function rowToRecordedReceipt(row: ReceiptRow): RecordedAuditReceipt {
  const data = parseReceiptData(row);
  return {
    receiptSchema: "openclaw-audit-receipt",
    schemaVersion: 1,
    sequence: row.sequence,
    receiptId: row.receipt_id,
    type: row.receipt_type,
    ...(row.receipt_version === null ? {} : { version: row.receipt_version }),
    occurredAt: row.occurred_at,
    agentId: row.agent_id,
    sessionId: row.session_id,
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    runId: row.run_id,
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.skill_name ? { skillName: row.skill_name } : {}),
    ...(row.skill_digest ? { skillDigest: row.skill_digest } : {}),
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    ...(row.subject_type && row.subject_id
      ? { subject: { type: row.subject_type, id: row.subject_id } }
      : {}),
    ...(data ? { data } : {}),
  };
}

function normalizedPayload(input: RecordAuditReceiptInput): string {
  return stableStringify({
    receipt: input.receipt,
    invocationId: input.invocationId ?? null,
    skillName: input.skillName ?? null,
    skillDigest: input.skillDigest ?? null,
    toolName: input.toolName,
  });
}

function receiptDataJson(receipt: AgentToolReceipt): string | null {
  if (!receipt.data) {
    return null;
  }
  const json = stableStringify(receipt.data);
  if (Buffer.byteLength(json, "utf8") > RECEIPT_DATA_MAX_BYTES) {
    throw new Error(`audit receipt data exceeds ${RECEIPT_DATA_MAX_BYTES} bytes`);
  }
  return json;
}

type PreparedAuditReceipt = {
  dataJson: string | null;
  input: RecordAuditReceiptInput;
  payloadSha256: string;
  receiptId: string;
  sourceId: string;
};

function prepareAuditReceipt(input: RecordAuditReceiptInput): PreparedAuditReceipt {
  if (!Number.isInteger(input.receiptIndex) || input.receiptIndex < 0) {
    throw new Error("audit receipt index must be a non-negative integer");
  }
  const sourceId = sha256Hex(
    JSON.stringify([
      input.agentId,
      input.sessionId,
      input.runId,
      input.toolCallId,
      input.receiptIndex,
    ]),
  );
  return {
    dataJson: receiptDataJson(input.receipt),
    input,
    payloadSha256: sha256Hex(normalizedPayload(input)),
    receiptId: `rcpt_${sourceId}`,
    sourceId,
  };
}

function insertPreparedAuditReceipt(
  database: OpenReceiptDatabase,
  prepared: PreparedAuditReceipt,
): RecordedAuditReceipt {
  const { dataJson, input, payloadSha256, receiptId, sourceId } = prepared;
  const db = getNodeSqliteKysely<ReceiptDatabase>(database.db);
  const values: Insertable<ReceiptTable> = {
    receipt_id: receiptId,
    source_id: sourceId,
    payload_sha256: payloadSha256,
    schema_version: 1,
    receipt_type: input.receipt.type,
    receipt_version: input.receipt.version ?? null,
    occurred_at: input.occurredAt,
    agent_id: input.agentId,
    session_id: input.sessionId,
    session_key: input.sessionKey ?? null,
    run_id: input.runId,
    invocation_id: input.invocationId ?? null,
    skill_name: input.skillName ?? null,
    skill_digest: input.skillDigest ?? null,
    tool_name: input.toolName,
    tool_call_id: input.toolCallId,
    receipt_index: input.receiptIndex,
    subject_type: input.receipt.subject?.type ?? null,
    subject_id: input.receipt.subject?.id ?? null,
    data_json: dataJson,
  };
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("receipts")
      .values(values)
      .onConflict((conflict) => conflict.column("source_id").doNothing()),
  );
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("receipts").selectAll().where("source_id", "=", sourceId),
  );
  if (!row) {
    throw new Error("audit receipt insert did not produce a durable row");
  }
  if (row.payload_sha256 !== payloadSha256) {
    throw new Error("audit receipt source identity was reused with different content");
  }
  return rowToRecordedReceipt(row);
}

/** Records one trusted tool outcome idempotently in the configured shared store. */
export function recordAuditReceipt(
  input: RecordAuditReceiptInput,
  options: ReceiptStoreOptions = {},
): RecordedAuditReceipt {
  const prepared = prepareAuditReceipt(input);
  const database = openAuditReceiptDatabase(options);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => insertPreparedAuditReceipt(database, prepared),
    {
      busyTimeoutMs: RECEIPT_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "audit-receipts",
      operationLabel: "record",
    },
  );
}

/** Records one bounded tool-result batch under a single SQLite write lock. */
export function recordAuditReceiptBatch(
  inputs: RecordAuditReceiptInput[],
  options: ReceiptStoreOptions = {},
): RecordedAuditReceipt[] {
  if (inputs.length === 0) {
    return [];
  }
  const prepared = inputs.map(prepareAuditReceipt);
  const database = openAuditReceiptDatabase(options);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => prepared.map((receipt) => insertPreparedAuditReceipt(database, receipt)),
    {
      busyTimeoutMs: RECEIPT_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "audit-receipts",
      operationLabel: "record-batch",
    },
  );
}

function buildFilteredReceiptQuery(
  db: ReturnType<typeof getNodeSqliteKysely<ReceiptDatabase>>,
  filters: AuditReceiptFilters,
) {
  let query = db.selectFrom("receipts");
  if (filters.type) {
    query = query.where("receipt_type", "=", filters.type);
  }
  if (filters.agentIds) {
    query =
      filters.agentIds.length > 0
        ? query.where("agent_id", "in", filters.agentIds)
        : query.where("sequence", "<", 0);
  }
  if (filters.sessionKey) {
    query = query.where("session_key", "=", filters.sessionKey);
  }
  if (filters.sessionId) {
    query = query.where("session_id", "=", filters.sessionId);
  }
  if (filters.runId) {
    query = query.where("run_id", "=", filters.runId);
  }
  if (filters.invocationId) {
    query = query.where("invocation_id", "=", filters.invocationId);
  }
  if (filters.skillName) {
    query = query.where("skill_name", "=", filters.skillName);
  }
  if (filters.skillDigest) {
    query = query.where("skill_digest", "=", filters.skillDigest);
  }
  if (filters.toolName) {
    query = query.where("tool_name", "=", filters.toolName);
  }
  if (filters.toolCallId) {
    query = query.where("tool_call_id", "=", filters.toolCallId);
  }
  if (filters.subjectType) {
    query = query.where("subject_type", "=", filters.subjectType);
  }
  if (filters.subjectId) {
    query = query.where("subject_id", "=", filters.subjectId);
  }
  if (filters.occurredAfter !== undefined) {
    query = query.where("occurred_at", ">=", filters.occurredAfter);
  }
  if (filters.occurredBefore !== undefined) {
    query = query.where("occurred_at", "<=", filters.occurredBefore);
  }
  return query;
}

/** Resolves one full receipt by its harness-owned identifier. */
export function getAuditReceipt(params: {
  receiptId: string;
  store?: ReceiptStoreOptions;
}): RecordedAuditReceipt | undefined {
  const database = openAuditReceiptDatabase(params.store);
  const db = getNodeSqliteKysely<ReceiptDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("receipts").selectAll().where("receipt_id", "=", params.receiptId),
  );
  return row ? rowToRecordedReceipt(row) : undefined;
}

/** Lists a bounded newest-first page using the store sequence as a stable cursor. */
export function listAuditReceipts(params: {
  filters?: AuditReceiptFilters;
  cursor?: number;
  limit: number;
  store?: ReceiptStoreOptions;
}): AuditReceiptPage {
  const database = openAuditReceiptDatabase(params.store);
  const db = getNodeSqliteKysely<ReceiptDatabase>(database.db);
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit)));
  let query = buildFilteredReceiptQuery(db, params.filters ?? {});
  if (params.cursor !== undefined) {
    query = query.where("sequence", "<", params.cursor);
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query
      .selectAll()
      .orderBy("sequence", "desc")
      .limit(limit + 1),
  ).rows;
  const hasMore = rows.length > limit;
  const receipts = rows.slice(0, limit).map(rowToRecordedReceipt);
  return {
    receipts,
    ...(hasMore && receipts.length > 0
      ? { nextCursor: receipts[receipts.length - 1]?.sequence }
      : {}),
  };
}

/** Counts matching receipts without materializing payloads. */
export function countAuditReceipts(params: {
  filters?: AuditReceiptFilters;
  store?: ReceiptStoreOptions;
}): number {
  const database = openAuditReceiptDatabase(params.store);
  const db = getNodeSqliteKysely<ReceiptDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    buildFilteredReceiptQuery(db, params.filters ?? {}).select((eb) =>
      eb.fn.countAll<number>().as("count"),
    ),
  );
  return row?.count ?? 0;
}

function closeAuditReceiptStores(): void {
  for (const opened of openDatabases.values()) {
    opened.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(opened.db);
    opened.db.close();
  }
  openDatabases.clear();
}

export function closeAuditReceiptStoresForTest(): void {
  closeAuditReceiptStores();
}

registerSqliteCacheExitClose(closeAuditReceiptStores);
