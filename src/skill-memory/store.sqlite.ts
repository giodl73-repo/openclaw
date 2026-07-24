// Skill Memory stores durable, cross-agent facts about completed work.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Generated, Insertable, Selectable } from "kysely";
import type { AgentToolMemory } from "../../packages/agent-core/src/types.js";
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

const MEMORY_STORE_SCHEMA_VERSION = 1;
const MEMORY_STORE_DIR_MODE = 0o700;
const MEMORY_STORE_FILE_MODE = 0o600;
const MEMORY_STORE_BUSY_TIMEOUT_MS = 50;
const MEMORY_DATA_MAX_BYTES = 256 * 1024;

type MemoryTable = {
  sequence: Generated<number>;
  memory_id: string;
  source_id: string;
  payload_sha256: string;
  schema_version: number;
  memory_type: string;
  memory_version: number | null;
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
  memory_index: number;
  subject_type: string | null;
  subject_id: string | null;
  data_json: string | null;
};

type MemoryDatabase = { memories: MemoryTable };
type MemoryRow = Selectable<MemoryTable>;

type OpenMemoryDatabase = {
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type RecordedSkillMemory = {
  memorySchema: "openclaw-skill-memory";
  schemaVersion: 1;
  sequence: number;
  memoryId: string;
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

export type RecordSkillMemoryInput = {
  memory: AgentToolMemory;
  memoryIndex: number;
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

export type SkillMemoryFilters = {
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

export type SkillMemoryPage = {
  memories: RecordedSkillMemory[];
  nextCursor?: number;
};

type MemoryStoreOptions = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

const openDatabases = new Map<string, OpenMemoryDatabase>();

function hardenMemoryDatabaseFiles(databasePath: string): void {
  for (const candidate of resolveSqliteDatabaseFilePaths(databasePath)) {
    if (fs.existsSync(candidate)) {
      applyPrivateModeSync(candidate, MEMORY_STORE_FILE_MODE);
    }
  }
}

export function resolveSkillMemoryStorePath(options: MemoryStoreOptions = {}): string {
  const configured = options.path ?? options.cfg?.skillMemory?.store?.path;
  return configured?.trim()
    ? path.resolve(resolveUserPath(configured.trim(), options.env))
    : path.join(resolveOpenClawStateSqliteDir(options.env), "skill-memory.sqlite");
}

export function isSkillMemoryStoreEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.skillMemory?.enabled !== false;
}

function ensureMemorySchema(db: DatabaseSync, databasePath: string): void {
  const version = readSqliteUserVersion(db);
  if (version > MEMORY_STORE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw memory database ${databasePath} uses schema version ${version}; this runtime supports up to ${MEMORY_STORE_SCHEMA_VERSION}.`,
    );
  }
  runSqliteImmediateTransactionSync(
    db,
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL UNIQUE,
      payload_sha256 TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      memory_type TEXT NOT NULL,
      memory_version INTEGER,
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
      memory_index INTEGER NOT NULL CHECK (memory_index >= 0),
      subject_type TEXT,
      subject_id TEXT,
      data_json TEXT,
      CHECK ((subject_type IS NULL) = (subject_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type_time
      ON memories(memory_type, occurred_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_subject_time
      ON memories(subject_type, subject_id, occurred_at DESC, sequence DESC)
      WHERE subject_type IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_agent_time
      ON memories(agent_id, occurred_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_session_time
      ON memories(session_key, occurred_at DESC, sequence DESC)
      WHERE session_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_run_time
      ON memories(run_id, occurred_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_memories_skill_time
      ON memories(skill_name, skill_digest, occurred_at DESC, sequence DESC)
      WHERE skill_name IS NOT NULL;
        PRAGMA user_version = ${MEMORY_STORE_SCHEMA_VERSION};
      `);
    },
    {
      busyTimeoutMs: MEMORY_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "skill-memory",
      operationLabel: "schema",
    },
  );
}

function openSkillMemoryDatabase(options: MemoryStoreOptions = {}): OpenMemoryDatabase {
  const databasePath = resolveSkillMemoryStorePath(options);
  const existing = openDatabases.get(databasePath);
  if (existing?.db.isOpen) {
    return existing;
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: MEMORY_STORE_DIR_MODE });
  if (!fs.existsSync(databasePath)) {
    fs.closeSync(fs.openSync(databasePath, "a", MEMORY_STORE_FILE_MODE));
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    applyPrivateModeSync(databasePath, MEMORY_STORE_FILE_MODE);
    walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: MEMORY_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "skill-memory",
      databasePath,
      synchronous: "NORMAL",
    });
    ensureMemorySchema(db, databasePath);
    hardenMemoryDatabaseFiles(databasePath);
    const opened = { db, path: databasePath, walMaintenance };
    openDatabases.set(databasePath, opened);
    return opened;
  } catch (error) {
    walMaintenance?.close();
    db.close();
    throw error;
  }
}

function parseMemoryData(row: MemoryRow): Record<string, unknown> | undefined {
  if (!row.data_json) {
    return undefined;
  }
  const parsed = JSON.parse(row.data_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`corrupt skill memory row ${row.sequence}: data_json is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function rowToRecordedMemory(row: MemoryRow): RecordedSkillMemory {
  const data = parseMemoryData(row);
  return {
    memorySchema: "openclaw-skill-memory",
    schemaVersion: 1,
    sequence: row.sequence,
    memoryId: row.memory_id,
    type: row.memory_type,
    ...(row.memory_version === null ? {} : { version: row.memory_version }),
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

function normalizedPayload(input: RecordSkillMemoryInput): string {
  return stableStringify({
    memory: input.memory,
    invocationId: input.invocationId ?? null,
    skillName: input.skillName ?? null,
    skillDigest: input.skillDigest ?? null,
    toolName: input.toolName,
  });
}

function memoryDataJson(memory: AgentToolMemory): string | null {
  if (!memory.data) {
    return null;
  }
  const json = stableStringify(memory.data);
  if (Buffer.byteLength(json, "utf8") > MEMORY_DATA_MAX_BYTES) {
    throw new Error(`skill memory data exceeds ${MEMORY_DATA_MAX_BYTES} bytes`);
  }
  return json;
}

type PreparedSkillMemory = {
  dataJson: string | null;
  input: RecordSkillMemoryInput;
  payloadSha256: string;
  memoryId: string;
  sourceId: string;
};

function prepareSkillMemory(input: RecordSkillMemoryInput): PreparedSkillMemory {
  if (!Number.isInteger(input.memoryIndex) || input.memoryIndex < 0) {
    throw new Error("skill memory index must be a non-negative integer");
  }
  const sourceId = sha256Hex(
    JSON.stringify([
      input.agentId,
      input.sessionId,
      input.runId,
      input.toolCallId,
      input.memoryIndex,
    ]),
  );
  return {
    dataJson: memoryDataJson(input.memory),
    input,
    payloadSha256: sha256Hex(normalizedPayload(input)),
    memoryId: `smem_${sourceId}`,
    sourceId,
  };
}

function insertPreparedSkillMemory(
  database: OpenMemoryDatabase,
  prepared: PreparedSkillMemory,
): RecordedSkillMemory {
  const { dataJson, input, payloadSha256, memoryId, sourceId } = prepared;
  const db = getNodeSqliteKysely<MemoryDatabase>(database.db);
  const values: Insertable<MemoryTable> = {
    memory_id: memoryId,
    source_id: sourceId,
    payload_sha256: payloadSha256,
    schema_version: 1,
    memory_type: input.memory.type,
    memory_version: input.memory.version ?? null,
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
    memory_index: input.memoryIndex,
    subject_type: input.memory.subject?.type ?? null,
    subject_id: input.memory.subject?.id ?? null,
    data_json: dataJson,
  };
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("memories")
      .values(values)
      .onConflict((conflict) => conflict.column("source_id").doNothing()),
  );
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("memories").selectAll().where("source_id", "=", sourceId),
  );
  if (!row) {
    throw new Error("skill memory insert did not produce a durable row");
  }
  if (row.payload_sha256 !== payloadSha256) {
    throw new Error("skill memory source identity was reused with different content");
  }
  return rowToRecordedMemory(row);
}

/** Remembers one trusted tool fact idempotently in the configured shared store. */
export function recordSkillMemory(
  input: RecordSkillMemoryInput,
  options: MemoryStoreOptions = {},
): RecordedSkillMemory {
  const prepared = prepareSkillMemory(input);
  const database = openSkillMemoryDatabase(options);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => insertPreparedSkillMemory(database, prepared),
    {
      busyTimeoutMs: MEMORY_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "skill-memory",
      operationLabel: "record",
    },
  );
}

/** Records one bounded tool-result batch under a single SQLite write lock. */
export function recordSkillMemoryBatch(
  inputs: RecordSkillMemoryInput[],
  options: MemoryStoreOptions = {},
): RecordedSkillMemory[] {
  if (inputs.length === 0) {
    return [];
  }
  const prepared = inputs.map(prepareSkillMemory);
  const database = openSkillMemoryDatabase(options);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => prepared.map((memory) => insertPreparedSkillMemory(database, memory)),
    {
      busyTimeoutMs: MEMORY_STORE_BUSY_TIMEOUT_MS,
      databaseLabel: "skill-memory",
      operationLabel: "record-batch",
    },
  );
}

function buildFilteredMemoryQuery(
  db: ReturnType<typeof getNodeSqliteKysely<MemoryDatabase>>,
  filters: SkillMemoryFilters,
) {
  let query = db.selectFrom("memories");
  if (filters.type) {
    query = query.where("memory_type", "=", filters.type);
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

/** Resolves one full memory by its harness-owned identifier. */
export function getSkillMemory(params: {
  memoryId: string;
  store?: MemoryStoreOptions;
}): RecordedSkillMemory | undefined {
  const database = openSkillMemoryDatabase(params.store);
  const db = getNodeSqliteKysely<MemoryDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("memories").selectAll().where("memory_id", "=", params.memoryId),
  );
  return row ? rowToRecordedMemory(row) : undefined;
}

/** Lists a bounded newest-first page using the store sequence as a stable cursor. */
export function listSkillMemory(params: {
  filters?: SkillMemoryFilters;
  cursor?: number;
  limit: number;
  store?: MemoryStoreOptions;
}): SkillMemoryPage {
  const database = openSkillMemoryDatabase(params.store);
  const db = getNodeSqliteKysely<MemoryDatabase>(database.db);
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit)));
  let query = buildFilteredMemoryQuery(db, params.filters ?? {});
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
  const memories = rows.slice(0, limit).map(rowToRecordedMemory);
  return {
    memories,
    ...(hasMore && memories.length > 0
      ? { nextCursor: memories[memories.length - 1]?.sequence }
      : {}),
  };
}

/** Counts matching memories without materializing payloads. */
export function countSkillMemory(params: {
  filters?: SkillMemoryFilters;
  store?: MemoryStoreOptions;
}): number {
  const database = openSkillMemoryDatabase(params.store);
  const db = getNodeSqliteKysely<MemoryDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    buildFilteredMemoryQuery(db, params.filters ?? {}).select((eb) =>
      eb.fn.countAll<number>().as("count"),
    ),
  );
  return row?.count ?? 0;
}

function closeSkillMemoryStores(): void {
  for (const opened of openDatabases.values()) {
    opened.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(opened.db);
    opened.db.close();
  }
  openDatabases.clear();
}

export function closeSkillMemoryStoresForTest(): void {
  closeSkillMemoryStores();
}

registerSqliteCacheExitClose(closeSkillMemoryStores);
