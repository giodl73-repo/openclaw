import type { CommandPolicyEvidence, CommandPolicyEvidenceRecord } from "./policy-evidence.js";

export type CommandRuntimeDrift = {
  readonly schemaVersion: 1;
  readonly comparisonKind: "openclaw-command-inventory";
  readonly scopeChanged: boolean;
  readonly added: readonly CommandPolicyEvidenceRecord[];
  readonly removed: readonly CommandPolicyEvidenceRecord[];
  readonly changed: readonly {
    readonly before: CommandPolicyEvidenceRecord;
    readonly after: CommandPolicyEvidenceRecord;
  }[];
};

function comparableRecord(record: CommandPolicyEvidenceRecord): string {
  return JSON.stringify(record, Object.keys(record).toSorted());
}

function comparableScope(scope: CommandPolicyEvidence["scope"]): string {
  return JSON.stringify(scope);
}

/** Compares two OpenClaw-observed inventory snapshots without inferring policy compliance. */
export function compareCommandRuntimeEvidence(
  before: CommandPolicyEvidence,
  after: CommandPolicyEvidence,
): CommandRuntimeDrift {
  const beforeById = new Map(before.records.map((record) => [record.id, record]));
  const afterById = new Map(after.records.map((record) => [record.id, record]));
  const added = after.records.filter((record) => !beforeById.has(record.id));
  const removed = before.records.filter((record) => !afterById.has(record.id));
  const changed = before.records.flatMap((beforeRecord) => {
    const afterRecord = afterById.get(beforeRecord.id);
    return afterRecord && comparableRecord(beforeRecord) !== comparableRecord(afterRecord)
      ? [{ before: beforeRecord, after: afterRecord }]
      : [];
  });
  return {
    schemaVersion: 1,
    comparisonKind: "openclaw-command-inventory",
    scopeChanged: comparableScope(before.scope) !== comparableScope(after.scope),
    added,
    removed,
    changed,
  };
}
