// Projects additive Claw provenance columns that only writable opens can ensure.
import type { DatabaseSync } from "node:sqlite";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";

const columnsBySchema = new WeakMap<SqliteSchemaFacts, Map<string, ReadonlySet<string>>>();

function canSelect(db: DatabaseSync, table: string, projection: string): boolean {
  try {
    db /* sqlite-allow-raw: capability probe for lazily added Claw provenance columns. */
      .prepare(`SELECT ${projection} FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only opens never run the additive column migration, so a same-version
 * database written before a column existed must still answer planning reads.
 * Absent columns project as SQL NULL, which the row parsers already treat as
 * "no recorded provenance".
 */
export function legacySafeColumnProjection(
  db: DatabaseSync,
  table: "claw_installs" | "claw_package_refs",
  columns: readonly string[],
  options: { aliasMissing?: boolean } = {},
): string {
  const missing = (column: string) =>
    options.aliasMissing === false ? "NULL" : `NULL AS ${column}`;
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    let tables = columnsBySchema.get(schema);
    if (!tables) {
      tables = new Map();
      columnsBySchema.set(schema, tables);
    }
    let present = tables.get(table);
    if (!present) {
      const sql = schema.tableSql.get(table);
      present = new Set(
        sql === undefined ? [] : parseSqliteTableDefinition(sql, table).columns.keys(),
      );
      tables.set(table, present);
    }
    return columns.map((column) => (present.has(column) ? column : missing(column))).join(", ");
  }
  const full = columns.join(", ");
  if (canSelect(db, table, full)) {
    return full;
  }
  return columns
    .map((column) => (canSelect(db, table, column) ? column : missing(column)))
    .join(", ");
}
