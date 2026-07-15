import type { SessionRegarding } from "../config/sessions/types.js";
import { summarizeTrajectoryAuditRuns, type TrajectoryAuditRunSummary } from "./audit-run.js";
import { matchesTrajectoryAuditReceipt } from "./audit.js";
import type { TrajectoryEvent } from "./types.js";

export type TrajectoryAuditThreadSummary = {
  auditSchema: "openclaw-audit-thread";
  schemaVersion: 1;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  regarding?: SessionRegarding;
  firstEventAt?: string;
  lastEventAt?: string;
  outcomes: Array<{ type: string; count: number }>;
  businessEvents: Array<{
    type: "audit.receipt" | "session.regarding.changed";
    ts: string;
    runId?: string;
    data?: Record<string, unknown>;
  }>;
  runs: TrajectoryAuditRunSummary[];
};

function readOutcomeCounts(events: TrajectoryEvent[]): TrajectoryAuditThreadSummary["outcomes"] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!matchesTrajectoryAuditReceipt(event)) {
      continue;
    }
    const type = String(event.data?.type).trim();
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
}

function readBusinessEvents(
  events: TrajectoryEvent[],
): TrajectoryAuditThreadSummary["businessEvents"] {
  return events.flatMap((event) => {
    if (event.type !== "session.regarding.changed" && !matchesTrajectoryAuditReceipt(event)) {
      return [];
    }
    return [
      {
        type: event.type as "audit.receipt" | "session.regarding.changed",
        ts: event.ts,
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.data ? { data: event.data } : {}),
      },
    ];
  });
}

function compareThreadEvents(left: TrajectoryEvent, right: TrajectoryEvent): number {
  const byTimestamp = left.ts.localeCompare(right.ts);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  const bySession = left.sessionId.localeCompare(right.sessionId);
  if (bySession !== 0) {
    return bySession;
  }
  const bySource = left.source.localeCompare(right.source);
  if (bySource !== 0) {
    return bySource;
  }
  const bySequence = (left.sourceSeq ?? left.seq) - (right.sourceSeq ?? right.seq);
  if (bySequence !== 0) {
    return bySequence;
  }
  const byTrace = left.traceId.localeCompare(right.traceId);
  return byTrace !== 0 ? byTrace : left.type.localeCompare(right.type);
}

/** Reconstructs one durable business thread from existing session and trajectory facts. */
export function summarizeTrajectoryAuditThread(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  regarding?: SessionRegarding;
  events: TrajectoryEvent[];
}): TrajectoryAuditThreadSummary {
  const events = params.events.toSorted(compareThreadEvents);
  const firstEventAt = events[0]?.ts;
  const lastEventAt = events.at(-1)?.ts;
  return {
    auditSchema: "openclaw-audit-thread",
    schemaVersion: 1,
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.regarding ? { regarding: params.regarding } : {}),
    ...(firstEventAt ? { firstEventAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
    outcomes: readOutcomeCounts(events),
    businessEvents: readBusinessEvents(events),
    runs: summarizeTrajectoryAuditRuns(events),
  };
}
