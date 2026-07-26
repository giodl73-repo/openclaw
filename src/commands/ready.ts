import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { CanonicalReadinessResult, ReadinessCondition } from "../readiness/conditions.js";
import { diffReadinessResults, type ReadinessTransitionChange } from "../readiness/transitions.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type ReadyCommandOptions = {
  json?: boolean;
  timeoutMs?: number;
  watch?: boolean;
  intervalMs?: number;
};

type ReadyCommandResult = Omit<
  CanonicalReadinessResult,
  "contractVersion" | "evaluatedAtMs" | "identity"
> &
  Partial<Pick<CanonicalReadinessResult, "contractVersion" | "evaluatedAtMs" | "identity">>;

type ReadyCommandError = {
  ready: false;
  error: {
    reason: "GatewayReadinessUnavailable";
    message: string;
  };
};

type ReadyWatchSignal = "SIGINT" | "SIGTERM";
type ReadyWatchProcess = {
  on(signal: ReadyWatchSignal, handler: () => void): unknown;
  off(signal: ReadyWatchSignal, handler: () => void): unknown;
};
type ReadyWatchObservation =
  | { state: "available"; result: ReadyCommandResult }
  | { state: "unavailable"; error: ReadyCommandError["error"] };
type ReadyWatchChange =
  | ReadinessTransitionChange
  | {
      kind: "availability";
      before: "available" | "unavailable";
      after: "available" | "unavailable";
    }
  | { kind: "error"; before: ReadyCommandError["error"]; after: ReadyCommandError["error"] };
type ReadyWatchEvent = {
  eventVersion: 1;
  event: "snapshot" | "transition";
  observedAtMs: number;
  state: ReadyWatchObservation["state"];
  ready?: boolean;
  changes: ReadyWatchChange[];
  readiness?: ReadyCommandResult;
  error?: ReadyCommandError["error"];
};

const DEFAULT_READY_WATCH_INTERVAL_MS = 2_000;
const READY_WATCH_SIGNALS: readonly ReadyWatchSignal[] = ["SIGINT", "SIGTERM"];
const READY_WATCH_SIGNAL_EXIT_CODES: Record<ReadyWatchSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

function conditionMark(condition: ReadinessCondition): string {
  if (condition.status === "True") {
    return "PASS";
  }
  return condition.requirement === "required" ? "FAIL" : "WARN";
}

function formatReadyResult(result: ReadyCommandResult): string {
  const required = result.conditions.filter((condition) => condition.requirement === "required");
  const requiredPassing = required.filter((condition) => condition.status === "True").length;
  const producer = result.identity?.subjects.find(
    (subject) => subject.ref === result.identity?.producerRef,
  );
  const producerLabel = result.identity
    ? `${result.identity.producerRef}${producer?.id ? ` (${producer.id})` : ""}`
    : "legacy Gateway";
  const lines = [
    `Ready: ${result.ready ? "yes" : "no"}`,
    `Producer: ${producerLabel}`,
    `Required: ${requiredPassing}/${required.length}`,
    `Advisories: ${result.advisories.length}`,
  ];

  if (result.conditions.length > 0) {
    lines.push(
      "",
      renderTable({
        width: getTerminalTableWidth(),
        border: "none",
        columns: [
          { key: "result", header: "RESULT", minWidth: 4 },
          { key: "requirement", header: "CLASS", minWidth: 8 },
          { key: "condition", header: "CONDITION", minWidth: 16 },
          { key: "subject", header: "SUBJECT", minWidth: 16 },
          { key: "reason", header: "REASON", minWidth: 16 },
          { key: "message", header: "DETAIL", flex: true, minWidth: 20 },
        ],
        rows: result.conditions.map((condition) => ({
          result: conditionMark(condition),
          requirement: condition.requirement,
          condition: condition.type,
          subject: condition.subjectRef ?? "legacy",
          reason: condition.reason,
          message: condition.message,
        })),
      }),
    );
  }
  return lines.join("\n");
}

function emitError(runtime: RuntimeEnv, json: boolean, error: ReadyCommandError): void {
  if (json) {
    writeRuntimeJson(runtime, error);
  } else {
    runtime.error("Ready: no");
    runtime.error(`${error.error.reason}: ${error.error.message}`);
  }
  runtime.exit(1);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function diffObservations(
  before: ReadyWatchObservation,
  after: ReadyWatchObservation,
): ReadyWatchChange[] {
  if (before.state !== after.state) {
    return [{ kind: "availability", before: before.state, after: after.state }];
  }
  if (before.state === "unavailable" && after.state === "unavailable") {
    return before.error.reason === after.error.reason &&
      before.error.message === after.error.message
      ? []
      : [{ kind: "error", before: before.error, after: after.error }];
  }
  if (before.state === "available" && after.state === "available") {
    return diffReadinessResults(before.result, after.result);
  }
  return [];
}

function createWatchEvent(params: {
  observation: ReadyWatchObservation;
  previous?: ReadyWatchObservation;
  nowMs: number;
}): ReadyWatchEvent | undefined {
  const changes = params.previous ? diffObservations(params.previous, params.observation) : [];
  if (params.previous && changes.length === 0) {
    return undefined;
  }
  return {
    eventVersion: 1,
    event: params.previous ? "transition" : "snapshot",
    observedAtMs: params.nowMs,
    state: params.observation.state,
    changes,
    ...(params.observation.state === "available"
      ? { ready: params.observation.result.ready, readiness: params.observation.result }
      : { ready: false, error: params.observation.error }),
  };
}

function formatWatchChange(change: ReadyWatchChange): string {
  if (change.kind === "availability") {
    return `availability ${change.before} -> ${change.after}`;
  }
  if (change.kind === "error") {
    return `error ${change.after.reason}: ${change.after.message}`;
  }
  if (change.kind === "ready") {
    return `ready ${change.before ? "yes" : "no"} -> ${change.after ? "yes" : "no"}`;
  }
  if (change.kind === "producer") {
    return `producer ${change.before} -> ${change.after}`;
  }
  if (change.kind === "subject") {
    return `subject ${change.ref} ${change.change}`;
  }
  const condition = change.after ?? change.before;
  const detail = condition ? ` ${condition.status} (${condition.reason})` : "";
  return `condition ${change.subjectRef}/${change.type} ${change.change}${detail}`;
}

function emitWatchEvent(runtime: RuntimeEnv, json: boolean, event: ReadyWatchEvent): void {
  if (json) {
    writeRuntimeJson(runtime, event, 0);
    return;
  }
  const heading = `[${new Date(event.observedAtMs).toISOString()}] ${event.event}`;
  if (event.event === "snapshot") {
    runtime.log(
      event.readiness
        ? `${heading}\n${formatReadyResult(event.readiness)}`
        : `${heading}\nReady: unavailable\n${event.error?.reason}: ${event.error?.message}`,
    );
    return;
  }
  const recoveredResult = event.changes.some(
    (change) =>
      change.kind === "availability" &&
      change.before === "unavailable" &&
      change.after === "available",
  )
    ? event.readiness
    : undefined;
  const outageError = event.changes.some(
    (change) =>
      change.kind === "availability" &&
      change.before === "available" &&
      change.after === "unavailable",
  )
    ? event.error
    : undefined;
  runtime.log(
    `${heading}\n${event.changes.map((change) => `- ${formatWatchChange(change)}`).join("\n")}${
      recoveredResult ? `\n\n${formatReadyResult(recoveredResult)}` : ""
    }${outageError ? `\n\n${outageError.reason}: ${outageError.message}` : ""}`,
  );
}

async function watchReady(params: {
  opts: ReadyCommandOptions;
  runtime: RuntimeEnv;
  callReady: (params: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ReadyCommandResult>;
  process: ReadyWatchProcess;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
}): Promise<void> {
  const controller = new AbortController();
  let stoppedBy: ReadyWatchSignal | undefined;
  const handlers = new Map<ReadyWatchSignal, () => void>();
  for (const signal of READY_WATCH_SIGNALS) {
    const handler = () => {
      stoppedBy ??= signal;
      controller.abort();
    };
    handlers.set(signal, handler);
    params.process.on(signal, handler);
  }

  let previous: ReadyWatchObservation | undefined;
  try {
    while (!controller.signal.aborted) {
      let observation: ReadyWatchObservation;
      try {
        observation = {
          state: "available",
          result: await params.callReady({
            timeoutMs: params.opts.timeoutMs,
            signal: controller.signal,
          }),
        };
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }
        observation = {
          state: "unavailable",
          error: { reason: "GatewayReadinessUnavailable", message: formatErrorMessage(error) },
        };
      }
      const event = createWatchEvent({ observation, previous, nowMs: params.now() });
      if (event) {
        emitWatchEvent(params.runtime, Boolean(params.opts.json), event);
      }
      previous = observation;
      await params.delay(
        params.opts.intervalMs ?? DEFAULT_READY_WATCH_INTERVAL_MS,
        controller.signal,
      );
    }
  } finally {
    for (const [signal, handler] of handlers) {
      params.process.off(signal, handler);
    }
  }
  if (stoppedBy) {
    params.runtime.exit(READY_WATCH_SIGNAL_EXIT_CODES[stoppedBy]);
  }
}

export async function readyCommand(
  opts: ReadyCommandOptions,
  runtime: RuntimeEnv,
  dependencies: {
    callReady?: (params: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }) => Promise<ReadyCommandResult>;
    process?: ReadyWatchProcess;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const callReady =
    dependencies.callReady ??
    (async ({ timeoutMs, signal }) =>
      await callGateway<ReadyCommandResult>({
        method: "ready",
        params: {},
        timeoutMs,
        signal,
      }));

  if (opts.watch) {
    await watchReady({
      opts,
      runtime,
      callReady,
      process: dependencies.process ?? process,
      delay: dependencies.delay ?? delay,
      now: dependencies.now ?? Date.now,
    });
    return;
  }

  let readiness: ReadyCommandResult;
  try {
    readiness = await callReady({ timeoutMs: opts.timeoutMs });
  } catch (error) {
    emitError(runtime, Boolean(opts.json), {
      ready: false,
      error: { reason: "GatewayReadinessUnavailable", message: formatErrorMessage(error) },
    });
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, readiness);
  } else {
    runtime.log(formatReadyResult(readiness));
  }
  if (!readiness.ready) {
    runtime.exit(1);
  }
}
