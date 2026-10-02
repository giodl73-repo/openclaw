import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentHarnessAdapterAttempt } from "../src/agents/harness/adapter-attempt.js";
import {
  createHostFixture,
  expectReleased,
  mocks,
  resetHostFixture,
} from "../src/agents/harness/adapter-attempt.test-support.js";
import type { SessionEntry } from "../src/agents/sessions/session-manager-types.js";
import { awaitGateBeforeSettlement, createDeferred } from "./helpers/promise.js";

const { createCopilotFaultPeer, createCopilotOrdinaryTurnAdapterForTest } =
  await import("../extensions/copilot/test-api.js");

const peers: Array<Awaited<ReturnType<typeof createCopilotFaultPeer>>> = [];

beforeEach(() => {
  resetHostFixture();
  // JSON-RPC dispatch uses setImmediate; only the host deadline runs on the fake clock.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const peer of peers.splice(0)) {
    await peer.close();
  }
  vi.useRealTimers();
});

async function createFixture(
  prompt?: string,
  peerOptions?: Parameters<typeof createCopilotFaultPeer>[0],
) {
  const host = createHostFixture(prompt);
  const peer = await createCopilotFaultPeer(peerOptions);
  peers.push(peer);
  const adapter = createCopilotOrdinaryTurnAdapterForTest({
    client: peer.client,
    model: "proof-model",
    workspaceDir: host.input.workspaceDir,
  });
  const execute = () =>
    runAgentHarnessAdapterAttempt({
      input: host.input,
      harnessId: "copilot-text-proof",
      label: "Copilot text proof",
      generationSignal: host.generation.signal,
      adapter,
    });
  return { ...host, peer, execute };
}

function finish(peer: Awaited<ReturnType<typeof createCopilotFaultPeer>>, text: string) {
  peer.emit("assistant.message", { messageId: "reply", content: text });
  peer.emit("session.idle", {});
}

describe("Copilot SDK adapter through the OpenClaw host", () => {
  it("creates no native session when the host rejects transcript admission", async () => {
    const f = await createFixture();
    f.persistApproved.mockResolvedValue(undefined);
    expect((await f.execute()).terminal.kind).toBe("failed");
    expect(f.peer.methods).toEqual([]);
    expectReleased(f);
  });

  it("streams once, waits for native idle and detach, then commits through the host", async () => {
    const f = await createFixture();
    const streamed = createDeferred<void>();
    f.callbacks.onPartialReply.mockImplementation(() => streamed.resolve());
    const attempt = f.execute();
    await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
    expect(f.persistApproved).toHaveBeenCalledOnce();
    const create = f.peer.requests.find((request) => request.method === "session.create");
    expect(create?.params).toMatchObject({
      model: "proof-model",
      availableTools: [],
      enableSkills: false,
      enableConfigDiscovery: false,
      infiniteSessions: { enabled: false },
      systemMessage: { mode: "replace", content: "instructions" },
    });
    const send = f.peer.requests.find((request) => request.method === "session.send");
    expect(send?.params.prompt).toContain('"content":"previous turn"');
    expect(send?.params.prompt).toContain("Current turn:\nhooked hello");
    f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: "answer" });
    await awaitGateBeforeSettlement(streamed.promise, attempt, "SDK delta not delivered");
    expect(mocks.append).not.toHaveBeenCalled();
    expect(f.peer.methods).not.toContain("session.detach");
    finish(f.peer, "answer");
    await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.clearActive).not.toHaveBeenCalled();
    f.peer.releaseDetach();
    const result = await attempt;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.assistantTexts).toEqual(["answer"]);
    expect(f.callbacks.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: "answer" });
    expect(f.recorder.markSentToProvider).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(result.assistantTranscriptOwned).toBe(true);
    expectReleased(f);
  });

  it.each(["abort", "timeout"] as const)(
    "%s suppresses late output but retains ownership until native idle and detach",
    async (reason) => {
      const f = await createFixture();
      const partial = createDeferred<void>();
      f.callbacks.onPartialReply.mockImplementation(() => partial.resolve());
      const attempt = f.execute();
      await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
      f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: "partial" });
      await awaitGateBeforeSettlement(partial.promise, attempt, "partial output skipped");
      if (reason === "abort") {
        f.generation.abort();
      } else {
        await vi.advanceTimersByTimeAsync(f.input.timeoutMs);
      }
      await awaitGateBeforeSettlement(f.peer.aborting, attempt, "SDK abort skipped");
      expect(mocks.clearActive).not.toHaveBeenCalled();
      expect(f.peer.methods).not.toContain("session.detach");
      f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: " late" });
      finish(f.peer, "partial late");
      await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
      expect(mocks.append).not.toHaveBeenCalled();
      f.peer.releaseDetach();
      const result = await attempt;
      expect(result.terminal.kind).toBe(reason === "abort" ? "aborted" : "timeout");
      expect(result.assistantTexts).toEqual(["partial"]);
      expect(f.callbacks.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: "partial" });
      expect(mocks.append).toHaveBeenCalledOnce();
      expectReleased(f);
    },
  );

  it.each(["abort", "timeout"] as const)(
    "%s reaches the SDK before send acknowledgement without releasing host ownership",
    async (reason) => {
      const f = await createFixture(undefined, { holdSend: true });
      const partial = createDeferred<void>();
      f.callbacks.onPartialReply.mockImplementation(() => partial.resolve());
      const attempt = f.execute();
      try {
        await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
        f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: "partial" });
        await awaitGateBeforeSettlement(partial.promise, attempt, "partial output skipped");
        if (reason === "abort") {
          f.generation.abort();
        } else {
          await vi.advanceTimersByTimeAsync(f.input.timeoutMs);
        }
        // A round trip behind the abort observes dispatch without waiting on a wall clock.
        await f.peer.client.ping("abort dispatch barrier");
        expect(f.peer.methods.filter((method) => method === "session.abort")).toHaveLength(1);
        expect(mocks.clearActive).not.toHaveBeenCalled();
        expect(mocks.append).not.toHaveBeenCalled();
        expect(f.peer.methods).not.toContain("session.detach");
        f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: " late" });
        finish(f.peer, "partial late");
        await f.peer.client.ping("native idle barrier");
        expect(mocks.clearActive).not.toHaveBeenCalled();
        expect(f.peer.methods).not.toContain("session.detach");
        f.peer.releaseSend();
        await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
        expect(mocks.clearActive).not.toHaveBeenCalled();
        expect(mocks.append).not.toHaveBeenCalled();
        f.peer.releaseDetach();
        const result = await attempt;
        expect(result.terminal.kind).toBe(reason === "abort" ? "aborted" : "timeout");
        expect(result.assistantTexts).toEqual(["partial"]);
        expect(f.callbacks.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: "partial" });
        expect(f.recorder.markSentToProvider).toHaveBeenCalledOnce();
        expect(mocks.append).toHaveBeenCalledOnce();
        expectReleased(f);
      } finally {
        f.peer.releaseSend();
        finish(f.peer, "partial late");
        f.peer.releaseDetach();
        await attempt;
      }
    },
  );

  it.each([false, true])(
    "defers cancellation until native receipt or acknowledgement (missing user event=%s)",
    async (skipUserMessage) => {
      const f = await createFixture(undefined, {
        holdSend: true,
        holdSendTrace: true,
        skipUserMessage,
      });
      const attempt = f.execute();
      try {
        await awaitGateBeforeSettlement(
          f.peer.tracingSend,
          attempt,
          "SDK trace preparation skipped",
        );
        f.generation.abort();
        await f.peer.client.ping("pre-dispatch barrier");
        expect(f.peer.methods).not.toContain("session.send");
        expect(f.peer.methods).not.toContain("session.abort");
        expect(mocks.clearActive).not.toHaveBeenCalled();
        f.peer.releaseSendTrace();
        await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
        if (skipUserMessage) {
          await f.peer.client.ping("unacknowledged submission barrier");
          expect(f.peer.methods).not.toContain("session.abort");
          f.peer.releaseSend();
        }
        await awaitGateBeforeSettlement(f.peer.aborting, attempt, "pending abort not forwarded");
        f.peer.releaseSend();
        await f.peer.client.ping("abort acknowledgement barrier");
        expect(f.peer.methods.filter((method) => method === "session.abort")).toHaveLength(1);
        expect(f.peer.methods).not.toContain("session.detach");
        expect(mocks.append).not.toHaveBeenCalled();
        expect(mocks.clearActive).not.toHaveBeenCalled();
        finish(f.peer, "late");
        await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
        f.peer.releaseDetach();
        const result = await attempt;
        expect(result.terminal.kind).toBe("aborted");
        expect(result.assistantTexts).toEqual([]);
        expect(f.callbacks.onPartialReply).not.toHaveBeenCalled();
        expect(f.recorder.markSentToProvider).toHaveBeenCalledOnce();
        expectReleased(f);
      } finally {
        f.peer.releaseSendTrace();
        f.peer.releaseSend();
        finish(f.peer, "late");
        f.peer.releaseDetach();
        await attempt;
      }
    },
  );

  it("retains native idle before send acknowledgement without a user notification", async () => {
    const f = await createFixture(undefined, { holdSend: true, skipUserMessage: true });
    const attempt = f.execute();
    try {
      await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
      finish(f.peer, "answer");
      await f.peer.client.ping("native idle barrier");
      expect(f.peer.methods).not.toContain("session.detach");
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.clearActive).not.toHaveBeenCalled();
      f.peer.releaseSend();
      await awaitGateBeforeSettlement(f.peer.detaching, attempt, "pre-ack idle was lost");
      expect(mocks.append).not.toHaveBeenCalled();
      f.peer.releaseDetach();
      const result = await attempt;
      expect(result.terminal.kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["answer"]);
      expect(mocks.append).toHaveBeenCalledOnce();
      expectReleased(f);
    } finally {
      f.peer.releaseSend();
      finish(f.peer, "answer");
      f.peer.releaseDetach();
      await attempt;
    }
  });

  it("keeps native errors as failures and awaits detach without committing success", async () => {
    const f = await createFixture();
    const attempt = f.execute();
    await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
    f.peer.emit("session.error", { errorType: "provider", message: "provider failed" });
    await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
    expect(mocks.clearActive).not.toHaveBeenCalled();
    f.peer.releaseDetach();
    expect((await attempt).terminal).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ message: "provider failed" }),
    });
    expect(mocks.append).not.toHaveBeenCalled();
    expectReleased(f);
  });

  it.each(["provider", "send", "output"] as const)(
    "preserves the %s failure when detach also fails",
    async (source) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const message = `${source} failed`;
      const f = await createFixture(undefined, {
        sendError: source === "send" ? message : undefined,
        detachError: "detach failed",
      });
      const outputError = new Error(message);
      if (source === "output") {
        f.callbacks.onPartialReply.mockRejectedValue(outputError);
      }
      const attempt = f.execute();
      try {
        await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
        if (source === "provider") {
          f.peer.emit("session.error", { errorType: "provider", message });
        } else if (source === "output") {
          f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: "partial" });
          await awaitGateBeforeSettlement(f.peer.aborting, attempt, "SDK abort skipped");
          finish(f.peer, "partial");
        }
        await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
        expect(mocks.clearActive).not.toHaveBeenCalled();
        expect(mocks.append).not.toHaveBeenCalled();
        f.peer.releaseDetach();
        const result = await attempt;
        expect(result.terminal).toMatchObject({
          kind: "failed",
          error: expect.objectContaining({ message }),
        });
        if (source === "output" && result.terminal.kind === "failed") {
          expect(result.terminal.error).toBe(outputError);
        }
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          "[copilot-text-adapter] disconnect failed after primary error",
          expect.objectContaining({ message: "detach failed" }),
        );
        expect(mocks.append).not.toHaveBeenCalled();
        expectReleased(f);
      } finally {
        finish(f.peer, "partial");
        f.peer.releaseDetach();
        await attempt;
        warning.mockRestore();
      }
    },
  );

  it("fails without committing an otherwise successful turn when detach fails", async () => {
    const f = await createFixture(undefined, { detachError: "detach failed" });
    const attempt = f.execute();
    try {
      await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
      finish(f.peer, "answer");
      await awaitGateBeforeSettlement(f.peer.detaching, attempt, "SDK detach skipped");
      expect(mocks.clearActive).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      f.peer.releaseDetach();
      expect((await attempt).terminal).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: "detach failed" }),
      });
      expect(mocks.append).not.toHaveBeenCalled();
      expectReleased(f);
    } finally {
      f.peer.releaseDetach();
      await attempt;
    }
  });

  it("unwinds a stopped SDK transport on cancellation without waiting forever for native idle", async () => {
    const f = await createFixture();
    const partial = createDeferred<void>();
    f.callbacks.onPartialReply.mockImplementation(() => partial.resolve());
    const attempt = f.execute();
    await awaitGateBeforeSettlement(f.peer.sent, attempt, "SDK submission skipped");
    f.peer.emit("assistant.message_delta", { messageId: "reply", deltaContent: "partial" });
    await awaitGateBeforeSettlement(partial.promise, attempt, "partial output skipped");
    await f.peer.disconnectTransport();
    f.generation.abort();
    expect((await attempt).terminal.kind).toBe("aborted");
    expect(mocks.append).not.toHaveBeenCalled();
    expectReleased(f);
  });

  it("replays host history once into a fresh SDK session for the follow-up turn", async () => {
    const first = await createFixture();
    const attempt = first.execute();
    await awaitGateBeforeSettlement(first.peer.sent, attempt, "first SDK submission skipped");
    finish(first.peer, "FIRST_ANSWER");
    first.peer.releaseDetach();
    const result = await attempt;
    expect(result.terminal.kind).toBe("ok");
    expectReleased(first);

    resetHostFixture();
    const second = await createFixture("SECOND_QUESTION");
    mocks.buildPrompt.mockResolvedValue({
      prompt: "SECOND_QUESTION",
      developerInstructions: "instructions",
    });
    const history = result.messagesSnapshot;
    const entries: SessionEntry[] = history.map((message, index) => ({
      type: "message",
      id: `history-${index}`,
      parentId: index === 0 ? null : `history-${index - 1}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    }));
    entries.push({
      type: "message",
      id: "user-1",
      parentId: `history-${entries.length - 1}`,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "SECOND_QUESTION", timestamp: 2 },
    });
    mocks.openContext.mockImplementation(async () => ({
      getBranch: () => entries,
      buildSessionContext: () => ({ messages: [...history, ...second.committed] }),
    }));
    const followup = second.execute();
    await awaitGateBeforeSettlement(second.peer.sent, followup, "follow-up SDK submission skipped");
    const prompt = second.peer.requests.find((request) => request.method === "session.send")?.params
      .prompt;
    const expectedHistory = history.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new Error("Expected text conversation history");
      }
      return { role: message.role, content: message.content };
    });
    expect(prompt).toBe(
      `Conversation context before this turn:\n${JSON.stringify(expectedHistory)}\n\nCurrent turn:\nSECOND_QUESTION`,
    );
    expect(
      second.peer.requests.find((request) => request.method === "session.create")?.params.sessionId,
    ).not.toBe(
      first.peer.requests.find((request) => request.method === "session.create")?.params.sessionId,
    );
    finish(second.peer, "SECOND_ANSWER");
    second.peer.releaseDetach();
    expect((await followup).assistantTexts).toEqual(["SECOND_ANSWER"]);
    expect(second.committed).toHaveLength(1);
    expectReleased(second);
  });
});
