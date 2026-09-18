import { describe, expect, it } from "vitest";
import { activatedConversation, messageIds } from "./conversation.test-harness.js";

describe("Control Model chat.send acknowledgments", () => {
  it("retains acknowledgment facts and projects terminal sends without acknowledging them", async () => {
    const { harness, model, conversation } = await activatedConversation();
    harness.queue("chat.send", {
      runId: "run-1",
      status: "started",
      messageSeq: 7,
      stopReason: "ignored-on-success",
      serverTiming: { receivedToAckMs: 12, loadSessionMs: 3, prepareAttachmentsMs: "nope" },
    });
    await expect(
      conversation.send({ message: "hello", idempotencyKey: "idem-1" }),
    ).resolves.toEqual({
      runId: "run-1",
      status: "started",
      idempotencyKey: "idem-1",
      stopReason: "ignored-on-success",
      messageSeq: 7,
      serverTiming: { receivedToAckMs: 12, loadSessionMs: 3 },
    });
    expect(conversation.getSnapshot().messages[0]).toMatchObject({ pending: true, runId: "run-1" });

    // A restart keeps the input retryable under its original idempotency key.
    harness.queue("chat.send", { runId: "run-2", status: "timeout", stopReason: "restart" });
    await expect(
      conversation.send({ message: "restarted", idempotencyKey: "idem-2" }),
    ).resolves.toMatchObject({ status: "timeout", stopReason: "restart" });
    expect(conversation.getSnapshot().messages[1]).toMatchObject({
      pending: true,
      runId: "idem-2",
    });

    // A rejected input is removed instead of being rekeyed to its run.
    harness.queue("chat.send", { runId: "run-3", status: "error" });
    await expect(
      conversation.send({ message: "rejected", idempotencyKey: "idem-3" }),
    ).resolves.toMatchObject({ status: "error" });
    expect(messageIds(conversation.getSnapshot())).toHaveLength(2);
    model.dispose();
  });
});
