import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { runAgentHarnessAdapterAttempt, type AgentHarnessTurnAdapter } from "./adapter-attempt.js";
import {
  createHostFixture,
  expectReleased,
  mocks,
  resetHostFixture,
  terminalAnchor,
} from "./adapter-attempt.test-support.js";

type PreparedAdapter = Awaited<ReturnType<AgentHarnessTurnAdapter["prepare"]>>;
type Turn = Parameters<PreparedAdapter["run"]>[0];
type Outcome = Awaited<ReturnType<PreparedAdapter["run"]>>;

const outcome: Outcome = {
  cancelled: false,
  permissionDenied: false,
  assistantIdempotencyKey: "turn-1:assistant",
  readUsage: async () => ({ input: 4, output: 2, total: 6 }),
};

function createFixture() {
  const host = createHostFixture();
  const { input, generation } = host;
  const run = vi.fn<PreparedAdapter["run"]>(async (turn) => {
    turn.markSubmitted();
    await turn.emit({ type: "text", text: "answer" });
    return outcome;
  });
  const prepare = vi.fn<AgentHarnessTurnAdapter["prepare"]>(async () => ({
    replayAfterIndex: -1,
    includeBootstrap: false,
    run,
  }));
  const execute = () =>
    runAgentHarnessAdapterAttempt({
      input,
      harnessId: "fake-adapter",
      label: "Fake adapter",
      generationSignal: generation.signal,
      adapter: { prepare },
    });
  return {
    ...host,
    run,
    prepare,
    execute,
  };
}

beforeEach(() => {
  resetHostFixture();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runAgentHarnessAdapterAttempt", () => {
  it("awaits admission, streams output, and commits one authoritative assistant after settlement", async () => {
    const f = createFixture();
    const admitting = createDeferred<void>();
    const admit = createDeferred<void>();
    const persist = f.persistApproved.getMockImplementation()!;
    f.persistApproved.mockImplementation(async (params) => {
      admitting.resolve();
      await admit.promise;
      return persist(params);
    });
    const streaming = createDeferred<Turn>();
    const settle = createDeferred<void>();
    f.run.mockImplementation(async (turn) => {
      turn.markSubmitted();
      await turn.emit({ type: "text", text: "thinking", reasoning: true });
      await turn.emit({ type: "text", text: "hello " });
      await turn.emit({ type: "text", text: "world" });
      await turn.emit({
        type: "tool",
        toolCallId: "tool-1",
        name: "lookup",
        text: "running",
        failed: false,
      });
      await turn.emit({
        type: "tool",
        toolCallId: "tool-1",
        name: "lookup",
        text: "done",
        failed: false,
      });
      streaming.resolve(turn);
      await settle.promise;
      return outcome;
    });
    const attempt = f.execute();
    await awaitGateBeforeSettlement(admitting.promise, attempt, "admission was skipped");
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.recorder.markSentToProvider).not.toHaveBeenCalled();
    admit.resolve();
    const turn = await awaitGateBeforeSettlement(
      streaming.promise,
      attempt,
      "streaming was skipped",
    );
    expect(f.persistApproved).toHaveBeenCalledExactlyOnceWith({ expectedSessionId: "session-1" });
    expect(turn).toMatchObject({
      admissionEntryId: "user-1",
      prompt: "hooked hello",
      developerInstructions: "instructions",
    });
    expect(turn.previousMessages).toEqual([
      { role: "user", content: "previous turn", timestamp: 1 },
    ]);
    expect(f.recorder.markSentToProvider).toHaveBeenCalledOnce();
    expect(f.callbacks.onExecutionStarted).toHaveBeenCalledOnce();
    expect(f.callbacks.onAssistantMessageStart).toHaveBeenCalledOnce();
    expect(f.callbacks.onPartialReply.mock.calls).toEqual([
      [{ text: "hello " }],
      [{ text: "hello world" }],
    ]);
    expect(f.callbacks.onReasoningStream).toHaveBeenCalledExactlyOnceWith({ text: "thinking" });
    expect(mocks.emitEvent).toHaveBeenCalledTimes(2);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.setActive.mock.calls[0]?.[1].isStreaming()).toBe(true);
    settle.resolve();
    const result = await attempt;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.append.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      updateMode: "inline",
    });
    expect(f.committed).toEqual([
      expect.objectContaining({
        idempotencyKey: outcome.assistantIdempotencyKey,
        content: [
          { type: "thinking", thinking: "thinking" },
          { type: "text", text: "hello world" },
        ],
      }),
    ]);
    expect(result.lastAssistant).toBe(f.committed[0]);
    expect(result.messagesSnapshot.at(-1)).toBe(f.committed[0]);
    expect(result).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: outcome.assistantIdempotencyKey,
      contextEngineTerminalAnchor: terminalAnchor,
    });
    expect(mocks.openContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      { cwd: f.input.workspaceDir, through: terminalAnchor },
    );
    expect(result.toolMetas).toEqual([
      { toolName: "lookup", toolCallId: "tool-1", meta: "done", isError: false },
    ]);
    expect(turn.eventGate.open).toBe(false);
    await expect(turn.emit({ type: "text", text: "late" })).rejects.toThrow("attempt is closed");
    expect(f.callbacks.onPartialReply).toHaveBeenCalledTimes(2);
    expectReleased(f);
  });

  it("rejects an unpersisted input before adapter execution", async () => {
    const f = createFixture();
    f.persistApproved.mockResolvedValue(undefined);
    const result = await f.execute();
    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        message: "Agent adapter input was not admitted to its transcript",
      }),
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expectReleased(f);
  });

  it.each([true, false])(
    "preserves native cancellation=%s and denial text when usage fails",
    async (cancelled) => {
      const f = createFixture();
      const failure = new Error("usage unavailable");
      f.run.mockImplementation(async (turn) => {
        turn.markSubmitted();
        return {
          ...outcome,
          cancelled,
          permissionDenied: true,
          readUsage: async () => {
            throw failure;
          },
        };
      });
      const result = await f.execute();
      expect(result.terminal).toEqual(
        cancelled
          ? { kind: "aborted", source: "external" }
          : { kind: "failed", source: "prompt", error: failure },
      );
      expect(result.assistantTexts).toEqual([
        "Fake adapter could not complete this turn because permission was not granted.",
      ]);
      expect(mocks.append).not.toHaveBeenCalled();
      expectReleased(f);
    },
  );

  it.each(["prepare", "run"] as const)(
    "releases the active run and timer after %s fails",
    async (phase) => {
      const f = createFixture();
      const failure = new Error(`${phase} failed`);
      if (phase === "prepare") {
        f.prepare.mockRejectedValue(failure);
      } else {
        f.run.mockImplementation(async (turn) => {
          turn.markSubmitted();
          await turn.emit({ type: "text", text: "partial" });
          throw failure;
        });
      }
      const result = await f.execute();
      expect(result.terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
      expect(mocks.append).not.toHaveBeenCalled();
      if (phase === "prepare") {
        expect(f.run).not.toHaveBeenCalled();
        expect(f.persistApproved).not.toHaveBeenCalled();
      } else {
        expect(f.run.mock.calls[0]?.[0].eventGate.open).toBe(false);
      }
      expectReleased(f);
    },
  );

  it.each(["abort", "timeout"] as const)(
    "gates late output on %s and retains ownership until the adapter settles",
    async (reason) => {
      const f = createFixture();
      const running = createDeferred<Turn>();
      const settle = createDeferred<void>();
      f.run.mockImplementation(async (turn) => {
        turn.markSubmitted();
        await turn.emit({ type: "text", text: "partial" });
        running.resolve(turn);
        await settle.promise;
        return { ...outcome, cancelled: true };
      });
      let finished = false;
      const attempt = f.execute().then((result) => {
        finished = true;
        return result;
      });
      const turn = await awaitGateBeforeSettlement(
        running.promise,
        attempt,
        "adapter did not start",
      );
      if (reason === "abort") {
        f.generation.abort();
      } else {
        await vi.advanceTimersByTimeAsync(f.input.timeoutMs);
      }
      expect(f.prepare.mock.calls[0]?.[0].signal.aborted).toBe(true);
      expect(turn.eventGate.open).toBe(false);
      await expect(turn.emit({ type: "text", text: "late" })).rejects.toThrow();
      await expect(
        turn.emit({ type: "tool", name: "late-tool", text: "late", failed: false }),
      ).rejects.toThrow();
      expect(f.callbacks.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: "partial" });
      expect(f.callbacks.onToolResult).not.toHaveBeenCalled();
      expect(finished).toBe(false);
      expect(mocks.clearActive).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(f.callbacks.onAttemptTimeout).toHaveBeenCalledTimes(reason === "timeout" ? 1 : 0);
      settle.resolve();
      const result = await attempt;
      expect(result.terminal).toMatchObject({ kind: reason === "timeout" ? "timeout" : "aborted" });
      expect(result.assistantTexts).toEqual(["partial"]);
      expect(f.committed).toEqual([
        expect.objectContaining({
          stopReason: "aborted",
          content: [{ type: "text", text: "partial" }],
        }),
      ]);
      expectReleased(f);
    },
  );

  it("rechecks authority at the persistence boundary after awaited work", async () => {
    const f = createFixture();
    const atCommit = createDeferred<void>();
    const commit = createDeferred<void>();
    const append = mocks.append.getMockImplementation()!;
    mocks.append.mockImplementation(async (params) => {
      atCommit.resolve();
      await commit.promise;
      return append(params);
    });
    const attempt = f.execute();
    await awaitGateBeforeSettlement(atCommit.promise, attempt, "commit was skipped");
    const revoked = new Error("host authority revoked");
    f.assertActive.mockImplementation(() => {
      throw revoked;
    });
    commit.resolve();
    const result = await attempt;
    expect(result.terminal).toEqual({ kind: "failed", source: "prompt", error: revoked });
    expect(f.committed).toEqual([]);
    expect(result.assistantTranscriptOwned).toBeUndefined();
    expect(result.contextEngineTerminalAnchor).toBeUndefined();
    expectReleased(f);
  });

  it("rejects prompt-hook tool restrictions before submitting the adapter", async () => {
    const f = createFixture();
    mocks.buildPrompt.mockResolvedValue({
      prompt: "restricted",
      developerInstructions: "",
      toolsAllow: [],
    });
    const result = await f.execute();
    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        message: "Fake adapter cannot enforce this prompt-hook tool restriction",
      }),
    });
    expect(f.persistApproved).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.recorder.markSentToProvider).not.toHaveBeenCalled();
    expect(f.callbacks.onExecutionStarted).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expectReleased(f);
  });
});
