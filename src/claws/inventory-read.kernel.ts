import type { DatabaseSync } from "node:sqlite";
import { sql as kyselySql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { rowToRef as cronRef } from "./cron.js";
import { rowToRef as mcpRef } from "./mcp.js";
import { rowToPackageRef } from "./package-extension-provenance.js";
import { legacySafeColumnProjection } from "./provenance-legacy-columns.js";
import { rowToRecord } from "./provenance.js";
import { rowToWorkspaceFile, type PersistedClawWorkspaceFile } from "./workspace.js";

/** The read worker supplies an admitted connection, including supported additive-column gaps. */
export function readClawInventoryInDatabase(db: DatabaseSync) {
  const sql = getNodeSqliteKysely<DB>(db);
  const installs = executeSqliteQuerySync(
    db,
    sql.selectFrom("claw_installs").selectAll().orderBy("agent_id"),
  ).rows;
  return {
    installs: installs.map(rowToRecord),
    packages: executeSqliteQuerySync(
      db,
      sql
        .selectFrom("claw_package_refs")
        .select([
          "schema_version",
          "agent_id",
          "claw_name",
          "package_kind",
          "package_source",
          "package_ref",
          "package_version",
          "package_integrity",
          "package_status",
          "relationship",
          "origin",
          "independent_owner",
          "installed_at_ms",
          "updated_at_ms",
        ])
        .select(
          (
            [
              "extension_id",
              "extension_format",
              "extension_detected_format",
              "extension_mapped_json",
              "extension_unavailable_json",
              "extension_adapter_identity",
            ] as const
          ).map((column) =>
            kyselySql
              .raw<string | null>(
                legacySafeColumnProjection(db, "claw_package_refs", [column], {
                  aliasMissing: false,
                }),
              )
              .as(column),
          ),
        )
        .orderBy("agent_id")
        .orderBy("package_kind")
        .orderBy("package_ref"),
    ).rows.map(rowToPackageRef),
    workspaceFiles: executeSqliteQuerySync(
      db,
      sql.selectFrom("claw_workspace_files").selectAll().orderBy("agent_id").orderBy("target_path"),
    ).rows.map((row) =>
      // Inventory preserves stored versions for diagnostics; retry admission validates them.
      rowToWorkspaceFile(row, row.schema_version as PersistedClawWorkspaceFile["schemaVersion"]),
    ),
    mcpServers: executeSqliteQuerySync(
      db,
      sql.selectFrom("claw_mcp_server_refs").selectAll().orderBy("agent_id").orderBy("name"),
    ).rows.map(mcpRef),
    cronJobs: executeSqliteQuerySync(
      db,
      sql.selectFrom("claw_cron_refs").selectAll().orderBy("agent_id").orderBy("manifest_id"),
    ).rows.map(cronRef),
  };
}

export type ClawInventory = ReturnType<typeof readClawInventoryInDatabase>;
