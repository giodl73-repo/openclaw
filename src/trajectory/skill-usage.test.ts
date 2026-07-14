import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { attachSkillUsageTrajectoryRecorder } from "./skill-usage.js";

afterEach(() => {
  resetDiagnosticEventsForTest();
});

describe("attachSkillUsageTrajectoryRecorder", () => {
  it("records trusted skill use for the selected run", async () => {
    const recordEvent = vi.fn();
    const dispose = attachSkillUsageTrajectoryRecorder({
      recorder: { recordEvent },
      runId: "run-1",
    });

    emitTrustedSkillUsedDiagnosticEvent({
      type: "skill.used",
      runId: "run-1",
      skillName: "payments",
      skillSource: "workspace",
      activation: "read",
      toolName: "read",
      toolCallId: "call-1",
    });
    emitTrustedSkillUsedDiagnosticEvent({
      type: "skill.used",
      runId: "run-2",
      skillName: "inventory",
      skillSource: "bundled",
      activation: "command",
    });

    await dispose();

    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith("skill.used", {
      skillName: "payments",
      skillSource: "workspace",
      activation: "read",
      toolName: "read",
      toolCallId: "call-1",
    });
  });

  it("keeps recording when optional diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const recordEvent = vi.fn();
    const dispose = attachSkillUsageTrajectoryRecorder({
      recorder: { recordEvent },
      runId: "run-1",
    });

    emitTrustedSkillUsedDiagnosticEvent({
      type: "skill.used",
      runId: "run-1",
      skillName: "payments",
      skillSource: "workspace",
      activation: "command",
      toolName: "skills",
    });

    await dispose();

    expect(recordEvent).toHaveBeenCalledWith("skill.used", {
      skillName: "payments",
      skillSource: "workspace",
      activation: "command",
      toolName: "skills",
    });
  });

  it("stops recording after disposal", async () => {
    const recordEvent = vi.fn();
    const dispose = attachSkillUsageTrajectoryRecorder({
      recorder: { recordEvent },
      runId: "run-1",
    });

    await dispose();
    emitTrustedSkillUsedDiagnosticEvent({
      type: "skill.used",
      runId: "run-1",
      skillName: "payments",
      skillSource: "workspace",
      activation: "read",
    });
    await waitForDiagnosticEventsDrained();

    expect(recordEvent).not.toHaveBeenCalled();
  });
});
