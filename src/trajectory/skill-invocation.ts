import type { ExplicitSkillInvocation } from "../skills/types.js";

type SkillInvocationRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
};

function invocationFields(invocation: ExplicitSkillInvocation) {
  return {
    ...invocation,
    activation: invocation.parentInvocationId ? "orchestration" : "command",
    caller: invocation.parentInvocationId ? "skill" : "inbound",
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
