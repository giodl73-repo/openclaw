import { SpanStatusCode } from "@opentelemetry/api";
import type { DiagnosticsMetrics } from "./service-metrics.js";
import type { DiagnosticsTraceRuntime } from "./service-traces.js";

const SUBAGENT_OUTCOMES = new Set(["ok", "error", "timeout", "killed", "reset", "deleted"]);
const SUBAGENT_REASONS = new Set([
  "session-delete",
  "session-reset",
  "spawn-failed",
  "subagent-complete",
  "subagent-error",
  "subagent-killed",
]);
const SUBAGENT_TARGET_KINDS = new Set(["subagent", "acp"]);
const ERROR_OUTCOMES = new Set(["error", "timeout", "killed"]);

export type SubagentEndedTelemetryEvent = {
  targetKind: string;
  reason: string;
  endedAt?: number;
  outcome?: string;
};

function boundedValue(value: string | undefined, allowed: Set<string>): string {
  return value && allowed.has(value) ? value : "unknown";
}

export function createSubagentEndedRecorder(params: {
  metrics: DiagnosticsMetrics;
  metricsEnabled: boolean;
  traces: DiagnosticsTraceRuntime;
  tracesEnabled: boolean;
}) {
  return (event: SubagentEndedTelemetryEvent) => {
    const outcome = boundedValue(event.outcome, SUBAGENT_OUTCOMES);
    const attributes = {
      "openclaw.subagent.outcome": outcome,
      "openclaw.subagent.reason": boundedValue(event.reason, SUBAGENT_REASONS),
      "openclaw.subagent.target_kind": boundedValue(event.targetKind, SUBAGENT_TARGET_KINDS),
    };
    if (params.metricsEnabled) {
      params.metrics.subagentEndedCounter.add(1, attributes);
    }
    if (!params.tracesEnabled) {
      return;
    }
    const endedAt =
      typeof event.endedAt === "number" && Number.isFinite(event.endedAt)
        ? event.endedAt
        : Date.now();
    const span = params.traces.spanWithDuration("openclaw.subagent.ended", attributes, 0, {
      endTimeMs: endedAt,
    });
    if (ERROR_OUTCOMES.has(outcome)) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
    }
    span.end(endedAt);
  };
}
