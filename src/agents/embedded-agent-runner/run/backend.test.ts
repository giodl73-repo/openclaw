import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryAuditReceipt } from "../../../trajectory/audit.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  collectAttemptToolAuditReceipts: vi.fn(),
  runAgentHarnessAttempt: vi.fn(),
}));

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: mocks.runAgentHarnessAttempt,
}));

vi.mock("./attempt-audit-receipts.js", () => ({
  collectAttemptToolAuditReceipts: mocks.collectAttemptToolAuditReceipts,
}));

import { runEmbeddedAttemptWithBackend } from "./backend.js";

describe("runEmbeddedAttemptWithBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records receipts at the shared harness boundary", async () => {
    const event = {
      toolCallId: "call-1",
      toolName: "send_invoice",
      result: { details: { audit: [] } },
      isError: false,
    };
    const receipt = { type: "invoice.sent" } as TrajectoryAuditReceipt;
    const recordEvent = vi.fn();
    const flush = vi.fn();
    const onAgentToolResult = vi.fn();
    const result = {} as EmbeddedRunAttemptResult;
    const params = {
      agentId: "support",
      onAgentToolResult,
      trajectoryRecorder: { recordEvent, flush },
    } as unknown as EmbeddedRunAttemptParams;
    mocks.collectAttemptToolAuditReceipts.mockReturnValue([receipt]);
    mocks.runAgentHarnessAttempt.mockImplementation(
      async (attemptParams: EmbeddedRunAttemptParams) => {
        attemptParams.onAgentToolResult?.(event);
        return result;
      },
    );

    await expect(runEmbeddedAttemptWithBackend(params)).resolves.toBe(result);

    expect(mocks.collectAttemptToolAuditReceipts).toHaveBeenCalledWith({ event });
    expect(recordEvent).toHaveBeenCalledWith("audit.receipt", { ...receipt });
    expect(flush).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledWith(event);
  });
});
