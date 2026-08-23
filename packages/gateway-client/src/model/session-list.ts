import type { SessionRow } from "@openclaw/gateway-protocol";
import type {
  ControlModelError,
  ControlModelSessionCatalogQuery,
  ControlModelSessionCatalogSnapshot,
  DeepReadonly,
} from "./catalog.js";

export type ControlModelSessionSummary = Readonly<{
  key: string;
  sessionId: string | null;
  title: string | null;
  kind: "direct" | "group" | "global" | "unknown";
  agentId: string | null;
  boardFace: "chat" | "dashboard" | null;
  isMain: boolean;
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  runStatus: NonNullable<SessionRow["status"]> | "idle";
  updatedAt: number | null;
  createdAt: number | null;
  model: string | null;
  modelProvider: string | null;
  worktree: Readonly<{ id: string; branch: string }> | null;
}>;

export type ControlModelSessionListSnapshot = Readonly<{
  status: ControlModelSessionCatalogSnapshot["status"];
  query: DeepReadonly<ControlModelSessionCatalogQuery>;
  sessions: readonly ControlModelSessionSummary[];
  totalCount: number;
  hasMore: boolean;
  refreshedAt: number | null;
  error: ControlModelError | null;
}>;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sessionTitle(row: DeepReadonly<SessionRow>): string | null {
  return stringOrNull(row.displayName) ?? stringOrNull(row.derivedTitle) ?? stringOrNull(row.label);
}

function sessionUpdatedAt(row: DeepReadonly<SessionRow>): number | null {
  return (
    numberOrNull(row.updatedAt) ??
    numberOrNull(row.lastActivityAt) ??
    numberOrNull(row.lastInteractionAt) ??
    numberOrNull(row.createdAt)
  );
}

function sessionWorktree(row: DeepReadonly<SessionRow>): ControlModelSessionSummary["worktree"] {
  const worktree = row.worktree;
  if (
    !worktree ||
    typeof worktree.id !== "string" ||
    typeof worktree.branch !== "string" ||
    !worktree.id.trim() ||
    !worktree.branch.trim()
  ) {
    return null;
  }
  return Object.freeze({ id: worktree.id.trim(), branch: worktree.branch.trim() });
}

function sessionRunStatus(row: DeepReadonly<SessionRow>): ControlModelSessionSummary["runStatus"] {
  return row.status === "running" ||
    row.status === "done" ||
    row.status === "failed" ||
    row.status === "killed" ||
    row.status === "timeout"
    ? row.status
    : "idle";
}

function sessionSummary(row: DeepReadonly<SessionRow>): ControlModelSessionSummary {
  return Object.freeze({
    key: stringOrNull(row.key) ?? "",
    sessionId: stringOrNull(row.sessionId),
    title: sessionTitle(row),
    kind:
      row.kind === "direct" || row.kind === "group" || row.kind === "global" ? row.kind : "unknown",
    agentId: stringOrNull(row.agentId),
    boardFace: row.boardFace === "chat" || row.boardFace === "dashboard" ? row.boardFace : null,
    isMain: row.isMain === true,
    archived: row.archived === true,
    pinned: row.pinned === true,
    unread: row.unread === true,
    runStatus: sessionRunStatus(row),
    updatedAt: sessionUpdatedAt(row),
    createdAt: numberOrNull(row.createdAt),
    model: stringOrNull(row.model),
    modelProvider: stringOrNull(row.modelProvider),
    worktree: sessionWorktree(row),
  });
}

export function createControlModelSessionListSnapshot(
  catalog: ControlModelSessionCatalogSnapshot,
): ControlModelSessionListSnapshot {
  return Object.freeze({
    status: catalog.status,
    query: catalog.query,
    sessions: Object.freeze(catalog.sessions.map((session) => sessionSummary(session))),
    totalCount: catalog.totalCount,
    hasMore: catalog.hasMore,
    refreshedAt: catalog.refreshedAt,
    error: catalog.error,
  });
}
