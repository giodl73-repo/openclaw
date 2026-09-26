import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunFailureSignal } from "./embedded-agent-runner/failure-signal.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

type Harness = ReturnType<typeof createSubscribedSessionHarness>;

async function completeTool(
  harness: Harness,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  error?: string,
  errorCode?: string,
) {
  harness.emit({ type: "tool_execution_start", toolName, toolCallId, args });
  harness.emit({
    type: "tool_execution_end",
    toolName,
    toolCallId,
    isError: error !== undefined,
    result: error
      ? {
          content: [{ type: "text", text: error }],
          details: {
            status: "error",
            error: errorCode ? { code: errorCode, message: error } : error,
          },
        }
      : { content: [{ type: "text", text: "synthetic success" }] },
  });
  await harness.subscription.waitForPendingEvents();
}

async function finish(harness: Harness, reply: boolean) {
  const answer = "I could not apply the edit. Here is the result of my inspection.";
  if (reply) {
    emitMessageStartAndEndForAssistantText({ emit: harness.emit, text: answer });
  }
  harness.emit({ type: "agent_end", messages: [], willRetry: false });
  await harness.subscription.waitForPendingEvents();
  const payloads = buildEmbeddedRunPayloads({
    assistantTexts: harness.subscription.assistantTexts,
    lastAssistant: harness.subscription.getCurrentAttemptAssistant(),
    lastToolError: harness.subscription.getLastToolError(),
    sessionKey: "agent:main:native-error-proof",
  });
  if (reply) {
    expect(harness.subscription.assistantTexts).toEqual([answer]);
    expect(payloads).toEqual([expect.objectContaining({ text: answer })]);
    expect(payloads[0]?.isError).toBeUndefined();
  }
  return payloads;
}

describe("native error policy through subscription and final payloads", () => {
  for (const reply of [false, true]) {
    it.each(["none", "unrelated-success", "failed-read", "recovered-read"] as const)(
      `keeps native error state after %s (assistant reply: ${reply})`,
      async (sequence) => {
        const harness = createSubscribedSessionHarness({
          runId: `native-error-${sequence}-${reply}`,
        });
        const { subscription } = harness;
        try {
          await completeTool(
            harness,
            "edit",
            "edit-failed",
            { path: "/tmp/native-proof.txt" },
            "synthetic edit failure",
          );
          expect(subscription.getLastToolError()).toMatchObject({
            toolName: "edit",
            mutatingAction: true,
            error: "synthetic edit failure",
          });
          if (sequence === "unrelated-success") {
            await completeTool(harness, "read", "read-success", { path: "/tmp/native-proof.txt" });
          }
          if (sequence === "failed-read" || sequence === "recovered-read") {
            await completeTool(
              harness,
              "read",
              "read-failed",
              { path: "/tmp/native-missing.txt" },
              "synthetic read failure",
            );
            expect(subscription.getLastToolError()).toMatchObject({
              toolName: "read",
              mutatingAction: false,
              error: "synthetic read failure",
            });
          }
          if (sequence === "recovered-read") {
            await completeTool(harness, "read", "read-recovered", {
              path: "/tmp/native-proof.txt",
            });
            expect(subscription.getLastToolError()).toBeUndefined();
          } else {
            expect(subscription.getLastToolError()?.toolName).toBe(
              sequence === "failed-read" ? "read" : "edit",
            );
          }
          const payloads = await finish(harness, reply);
          if (!reply) {
            if (sequence === "recovered-read") {
              expect(payloads).toEqual([]);
            } else {
              expect(payloads).toHaveLength(1);
              expect(payloads[0]?.isError).toBe(true);
              expect(payloads[0]?.text).toMatch(
                sequence === "failed-read" ? /read.*failed/i : /edit.*failed/i,
              );
              expect(payloads[0]?.text).not.toContain("synthetic");
            }
          }
        } finally {
          await subscription.waitForPendingEvents();
          subscription.unsubscribe();
        }
      },
    );

    it.each(["SYSTEM_RUN_DENIED", "INVALID_REQUEST"])(
      `keeps fatal cron metadata for %s (assistant reply: ${reply})`,
      async (code) => {
        const harness = createSubscribedSessionHarness({ runId: `native-fatal-${code}-${reply}` });
        const { subscription } = harness;
        try {
          await completeTool(
            harness,
            "edit",
            "edit-failed",
            { path: "/tmp/native-proof.txt" },
            "synthetic edit failure",
          );
          await completeTool(
            harness,
            "exec",
            "exec-denied",
            { command: "rg --files" },
            "synthetic denial",
            code,
          );
          const payloads = await finish(harness, reply);
          expect(subscription.getLastToolError()).toMatchObject({
            toolName: "exec",
            errorCode: code,
          });
          expect(
            resolveEmbeddedRunFailureSignal({
              trigger: "cron",
              lastToolError: subscription.getLastToolError(),
            }),
          ).toMatchObject({
            code,
            kind: "execution_denied",
            fatalForCron: true,
          });
          expect(
            resolveEmbeddedRunFailureSignal({
              trigger: "user",
              lastToolError: subscription.getLastToolError(),
            }),
          ).toBeUndefined();
          if (!reply) {
            expect(payloads).toHaveLength(1);
            expect(payloads[0]?.isError).toBe(true);
          }
        } finally {
          await subscription.waitForPendingEvents();
          subscription.unsubscribe();
        }
      },
    );
  }
});
