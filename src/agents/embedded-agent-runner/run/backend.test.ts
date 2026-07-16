import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryAuditReceipt } from "../../../trajectory/audit.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  collectAttemptToolAuditReceipts: vi.fn(),
  recordAuditReceipt: vi.fn(),
  runAgentHarnessAttempt: vi.fn(),
}));

vi.mock("../../../audit/receipt-store.sqlite.js", () => ({
  isAuditReceiptStoreEnabled: vi.fn(() => true),
  recordAuditReceipt: mocks.recordAuditReceipt,
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
    const receipt = {
      type: "invoice.sent",
      toolName: "send_invoice",
      toolCallId: "call-1",
    } as TrajectoryAuditReceipt;
    const recordEvent = vi.fn();
    const flush = vi.fn();
    const onAgentToolResult = vi.fn();
    const result = {} as EmbeddedRunAttemptResult;
    const params = {
      agentId: "support",
      sessionId: "session-1",
      sessionKey: "agent:support:email:thread:case-1",
      runId: "run-1",
      explicitSkillInvocation: {
        invocationId: "invocation-1",
        commandName: "invoice-customer",
        skillName: "customer-billing",
        skillDigest: `sha256:${"a".repeat(64)}`,
      },
      onAgentToolResult,
      trajectoryRecorder: { recordEvent, flush },
    } as unknown as EmbeddedRunAttemptParams;
    mocks.collectAttemptToolAuditReceipts.mockReturnValue([receipt]);
    mocks.recordAuditReceipt.mockReturnValue({
      receiptId: "rcpt-1",
      receiptType: "invoice.sent",
      toolName: "send_invoice",
      toolCallId: "call-1",
      invocationId: "invocation-1",
      skillName: "customer-billing",
      skillDigest: `sha256:${"a".repeat(64)}`,
    });
    mocks.runAgentHarnessAttempt.mockImplementation(
      async (attemptParams: EmbeddedRunAttemptParams) => {
        attemptParams.onAgentToolResult?.(event);
        return result;
      },
    );

    await expect(runEmbeddedAttemptWithBackend(params)).resolves.toBe(result);

    expect(mocks.collectAttemptToolAuditReceipts).toHaveBeenCalledWith({ event });
    expect(mocks.recordAuditReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt,
        receiptIndex: 0,
        agentId: "support",
        sessionId: "session-1",
        sessionKey: "agent:support:email:thread:case-1",
        runId: "run-1",
        invocationId: "invocation-1",
        skillName: "customer-billing",
        skillDigest: `sha256:${"a".repeat(64)}`,
      }),
      { cfg: undefined },
    );
    expect(recordEvent).toHaveBeenCalledWith("audit.receipt.recorded", {
      receiptId: "rcpt-1",
      type: "invoice.sent",
      toolName: "send_invoice",
      toolCallId: "call-1",
      invocationId: "invocation-1",
      skillName: "customer-billing",
      skillDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledWith(event);
  });
});
