// Session regarding trajectory events reuse the bounded SQLite runtime recorder.
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import type { SessionRegarding } from "../config/sessions/types.js";
import { createTrajectoryRuntimeRecorder } from "../trajectory/runtime.js";

export type SessionRegardingTransition = {
  action: "set" | "replace" | "clear";
  previous?: SessionRegardingReceipt;
  regarding?: SessionRegardingReceipt;
};

export type SessionRegardingReceipt = Omit<SessionRegarding, "key"> & {
  reference?: string;
};

function toRegardingReceipt(regarding: SessionRegarding): SessionRegardingReceipt {
  const { key, ...identity } = regarding;
  return key ? { ...identity, reference: key } : identity;
}

function isSameRegarding(
  left: SessionRegarding | undefined,
  right: SessionRegarding | undefined,
): boolean {
  return (
    left?.system === right?.system &&
    left?.type === right?.type &&
    left?.id === right?.id &&
    left?.key === right?.key
  );
}

export function resolveSessionRegardingTransition(
  previous: SessionRegarding | undefined,
  regarding: SessionRegarding | undefined,
): SessionRegardingTransition | null {
  if (isSameRegarding(previous, regarding)) {
    return null;
  }
  if (!previous && regarding) {
    return { action: "set", regarding: toRegardingReceipt(regarding) };
  }
  if (previous && !regarding) {
    return { action: "clear", previous: toRegardingReceipt(previous) };
  }
  return {
    action: "replace",
    previous: previous ? toRegardingReceipt(previous) : undefined,
    regarding: regarding ? toRegardingReceipt(regarding) : undefined,
  };
}

export async function recordSessionRegardingTransition(params: {
  actor: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  previous?: SessionRegarding;
  regarding?: SessionRegarding;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<boolean> {
  const transition = resolveSessionRegardingTransition(params.previous, params.regarding);
  if (!transition) {
    return false;
  }
  const recorder = createTrajectoryRuntimeRecorder({
    env: params.env,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: formatSqliteSessionFileMarker({
      agentId: params.agentId,
      sessionId: params.sessionId,
      storePath: params.storePath,
    }),
  });
  if (!recorder) {
    return false;
  }
  recorder.recordEvent("session.regarding.changed", {
    actor: params.actor,
    ...transition,
  });
  await recorder.flush();
  return true;
}
