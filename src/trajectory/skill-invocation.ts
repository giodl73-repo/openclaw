import type { ExplicitSkillInvocation } from "../skills/types.js";

type SkillInvocationRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
};

function invocationFields(invocation: ExplicitSkillInvocation) {
  const caller = invocation.parentInvocationId
    ? "skill"
    : invocation.parentRunId
      ? "agent"
      : "inbound";
  return {
    ...invocation,
    activation:
      invocation.parentInvocationId || invocation.parentRunId ? "orchestration" : "command",
    caller,
  } as const;
}

export function recordSkillInvocationStarted(
  recorder: SkillInvocationRecorder | null | undefined,
  invocation: ExplicitSkillInvocation | undefined,
): void {
  if (invocation) {
    recorder?.recordEvent("skill.invocation.started", invocationFields(invocation));
  }
}

export function recordSkillInvocationCompleted(
  recorder: SkillInvocationRecorder | null | undefined,
  invocation: ExplicitSkillInvocation | undefined,
  status: "success" | "error" | "interrupted",
): void {
  if (invocation) {
    recorder?.recordEvent("skill.invocation.completed", {
      ...invocationFields(invocation),
      status,
    });
  }
}
