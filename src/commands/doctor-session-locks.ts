import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import {
  cleanStaleLockFiles,
  type SessionLockInspection,
  type SessionLockOwnerProcessArgsReader,
} from "../agents/session-write-lock.js";
import { resolveStateDir } from "../config/paths.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const SESSION_LOCKS_CHECK_ID = "core/doctor/session-locks";

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "unknown";
  }
  return ageMs <= 0 ? "0s" : (formatDurationCompact(ageMs) ?? "unknown");
}

function formatLockLine(lock: SessionLockInspection): string {
  const pidStatus =
    lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
  const ageStatus = `age=${formatAge(lock.ageMs)}`;
  const staleStatus = lock.stale
    ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})`
    : "stale=no";
  const removedStatus = lock.removed ? " [removed]" : "";
  return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}

export type SessionLockHealthFinding = {
  checkId: typeof SESSION_LOCKS_CHECK_ID;
  message: string;
  staleCount: number;
  fixHint: string;
};

export async function collectSessionLockHealth(params?: {
  shouldRepair?: boolean;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<{
  locks: SessionLockInspection[];
  staleCount: number;
  removedCount: number;
  noteLines: string[];
}> {
  const shouldRepair = params?.shouldRepair === true;
  const staleMs = params?.staleMs ?? DEFAULT_STALE_MS;
  const sessionDirs = await resolveAgentSessionDirs(resolveStateDir(params?.env ?? process.env));

  if (sessionDirs.length === 0) {
    return { locks: [], staleCount: 0, removedCount: 0, noteLines: [] };
  }

  const allLocks: SessionLockInspection[] = [];
  for (const sessionsDir of sessionDirs) {
    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs,
      removeStale: shouldRepair,
      readOwnerProcessArgs: params?.readOwnerProcessArgs,
    });
    allLocks.push(...result.locks);
  }

  if (allLocks.length === 0) {
    return { locks: [], staleCount: 0, removedCount: 0, noteLines: [] };
  }

  const staleCount = allLocks.filter((lock) => lock.stale).length;
  const removedCount = allLocks.filter((lock) => lock.removed).length;
  const lines: string[] = [
    `- Found ${allLocks.length} session lock file${allLocks.length === 1 ? "" : "s"}.`,
    ...allLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath)).map(formatLockLine),
  ];

  if (staleCount > 0 && !shouldRepair) {
    lines.push(`- ${staleCount} lock file${staleCount === 1 ? " is" : "s are"} stale.`);
    lines.push('- Run "openclaw doctor --fix" to remove stale lock files automatically.');
  }
  if (shouldRepair && removedCount > 0) {
    lines.push(
      `- Removed ${removedCount} stale session lock file${removedCount === 1 ? "" : "s"}.`,
    );
  }

  return { locks: allLocks, staleCount, removedCount, noteLines: lines };
}

export async function detectSessionLockHealthFindings(params?: {
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<readonly SessionLockHealthFinding[]> {
  const result = await collectSessionLockHealth({
    env: params?.env,
    staleMs: params?.staleMs,
    readOwnerProcessArgs: params?.readOwnerProcessArgs,
  });
  if (result.staleCount === 0) {
    return [];
  }
  return [
    {
      checkId: SESSION_LOCKS_CHECK_ID,
      staleCount: result.staleCount,
      message: result.noteLines.join("\n"),
      fixHint: 'Run "openclaw doctor --fix" to remove stale lock files automatically.',
    },
  ];
}

export async function repairSessionLockHealthFindings(params?: {
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const result = await collectSessionLockHealth({
    shouldRepair: true,
    env: params?.env,
    staleMs: params?.staleMs,
    readOwnerProcessArgs: params?.readOwnerProcessArgs,
  });
  return {
    changes:
      result.removedCount > 0
        ? [
            `Removed ${result.removedCount} stale session lock file${
              result.removedCount === 1 ? "" : "s"
            }.`,
          ]
        : [],
    warnings: [],
  };
}

export async function noteSessionLockHealth(params?: {
  shouldRepair?: boolean;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}) {
  try {
    const result = await collectSessionLockHealth(params);
    if (result.noteLines.length > 0) {
      note(result.noteLines.join("\n"), "Session locks");
    }
  } catch (err) {
    note(`- Failed to inspect session lock files: ${String(err)}`, "Session locks");
  }
}
