import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";

type SkillUsageTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
};

/** Records OpenClaw's trusted skill-use facts for one run, then drains before detaching. */
export function attachSkillUsageTrajectoryRecorder(params: {
  recorder: SkillUsageTrajectoryRecorder;
  runId: string;
}): () => Promise<void> {
  let unsubscribe: (() => void) | undefined = onTrustedInternalDiagnosticEvent(
    (event, metadata) => {
      if (!metadata.trusted || event.type !== "skill.used" || event.runId !== params.runId) {
        return;
      }
      params.recorder.recordEvent("skill.used", {
        skillName: event.skillName,
        skillSource: event.skillSource,
        activation: event.activation,
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      });
    },
  );

  return async () => {
    if (!unsubscribe) {
      return;
    }
    await waitForDiagnosticEventsDrained();
    unsubscribe();
    unsubscribe = undefined;
  };
}
