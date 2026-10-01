import type { DatabaseSync } from "node:sqlite";
import { legacySafeColumnProjection } from "./provenance-legacy-columns.js";

export function selectClawBootstrapProvenanceColumns(db: DatabaseSync): string {
  return legacySafeColumnProjection(db, "claw_installs", [
    "bootstrap_source_path",
    "bootstrap_content_digest",
  ]);
}

export function clawBootstrapProvenanceFromRow(row: {
  bootstrap_source_path: string | null;
  bootstrap_content_digest: string | null;
}) {
  return row.bootstrap_source_path && row.bootstrap_content_digest
    ? {
        bootstrap: {
          sourcePath: row.bootstrap_source_path,
          contentDigest: row.bootstrap_content_digest,
        },
      }
    : {};
}
