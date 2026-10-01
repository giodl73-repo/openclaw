import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "openclaw/plugin-sdk/acp-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostFixture,
  expectReleased,
  mocks,
  resetHostFixture,
  terminalAnchor,
} from "../src/agents/harness/adapter-attempt.test-support.js";
import { awaitGateBeforeSettlement, createDeferred } from "./helpers/promise.js";

// Register the host boundary mocks before the extension loads the real SDK modules.
const { runAcpHarnessAttempt } = await import("../extensions/acpx/test-api.js");
type CompleteAcpRuntime = Parameters<typeof runAcpHarnessAttempt>[0]["runtime"];

// Only the native runtime and host boundaries are faked. The extension's test entry
// composes the real host executor and stream consumer.
function createFixture(events: AsyncIterable<AcpRuntimeEvent>) {
  const host = createHostFixture();
  const promptStarted = createDeferred<void>();
  const result = createDeferred<AcpRuntimeTurnResult>();
  const starting = createDeferred<Parameters<CompleteAcpRuntime["startTurn"]>[0]>();
  const handle = {
    sessionKey: "agent:main:harness:acp-fixture:session-1",
    backend: "acpx",
    runtimeSessionName: "native-session-1",
  };
  const cancel = vi.fn(async () => {});
  const closeStream = vi.fn(async () => {});
  const startTurn = vi.fn<CompleteAcpRuntime["startTurn"]>((input) => {
    starting.resolve(input);
    return {
      requestId: input.requestId,
      promptStarted: promptStarted.promise,
      events,
      result: result.promise,
      cancel,
      closeStream,
    };
  });
  const runtime = {
    ensureSession: vi.fn(async () => handle),
    startTurn,
    runTurn() {
      throw new Error("Unexpected legacy runTurn");
    },
    getStatus: vi.fn<CompleteAcpRuntime["getStatus"]>(async () => ({ summary: "live" })),
    setModel: vi.fn<CompleteAcpRuntime["setModel"]>(async () => {}),
    findSession: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => {}),
    getCapabilities: vi.fn(async () => ({ controls: [] })),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    doctor: vi.fn(async () => ({ ok: true, message: "controlled runtime" })),
    prepareFreshSession: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies CompleteAcpRuntime;
  const execute = () =>
    runAcpHarnessAttempt({
      input: host.input,
      runtime,
      agent: "native-test-agent",
      harnessId: "acp-fixture",
      label: "ACP test",
      command: ["unused-native-command"],
      generationSignal: host.generation.signal,
    });
  return { ...host, runtime, promptStarted, result, starting, closeStream, execute };
}

beforeEach(() => {
  resetHostFixture();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runAcpHarnessAttempt host integration", () => {
  it("waits for native submission readiness and commits streamed output only after settlement", async () => {
    const emit = createDeferred<void>();
    const drained = createDeferred<void>();
    const f = createFixture(
      (async function* (): AsyncGenerator<AcpRuntimeEvent> {
        await emit.promise;
        yield { type: "text_delta", stream: "thought", text: "thinking" };
        yield { type: "text_delta", text: "hello " };
        yield { type: "text_delta", text: "world" };
        yield { type: "tool_call", toolCallId: "tool-1", title: "lookup", text: "done" };
        drained.resolve();
      })(),
    );
    const submitted = createDeferred<void>();
    f.callbacks.onExecutionStarted.mockImplementation(() => submitted.resolve());
    const attempt = f.execute();
    const turn = await awaitGateBeforeSettlement(
      f.starting.promise,
      attempt,
      "native turn skipped",
    );
    expect(f.persistApproved).toHaveBeenCalledExactlyOnceWith({ expectedSessionId: "session-1" });
    expect(f.runtime.ensureSession).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionKey: "agent:main:harness:acp-fixture:session-1",
      agent: "native-test-agent",
      agentCommand: ["unused-native-command"],
      mode: "persistent",
      bridgeSession: { agentId: "main", sessionKey: f.input.sessionKey, native: true },
      cwd: f.input.workspaceDir,
    });
    expect(f.runtime.setModel).toHaveBeenCalledExactlyOnceWith({
      handle: turn.handle,
      model: f.input.modelId,
      signal: turn.signal,
      assertActive: expect.any(Function),
    });
    expect(turn.requestId).toMatch(/^user-1:acp:.+/);
    expect(turn.text).toBe(
      'Conversation instructions:\ninstructions\n\nConversation context before this turn:\n[{"role":"user","content":"previous turn","timestamp":1}]\n\nCurrent turn:\nhooked hello',
    );
    expect(f.recorder.markSentToProvider).not.toHaveBeenCalled();
    expect(f.callbacks.onExecutionStarted).not.toHaveBeenCalled();
    expect(mocks.setActive.mock.calls[0]?.[1].isStreaming()).toBe(false);
    expect(mocks.append).not.toHaveBeenCalled();

    f.promptStarted.resolve();
    await awaitGateBeforeSettlement(submitted.promise, attempt, "submission readiness ignored");
    expect(f.recorder.markSentToProvider).toHaveBeenCalledOnce();
    expect(f.callbacks.onExecutionStarted).toHaveBeenCalledOnce();
    expect(mocks.setActive.mock.calls[0]?.[1].isStreaming()).toBe(true);
    emit.resolve();
    await awaitGateBeforeSettlement(drained.promise, attempt, "native output skipped");
    expect(f.callbacks.onPartialReply.mock.calls).toEqual([
      [{ text: "hello " }],
      [{ text: "hello world" }],
    ]);
    expect(f.callbacks.onReasoningStream).toHaveBeenCalledExactlyOnceWith({ text: "thinking" });
    expect(f.callbacks.onAssistantMessageStart).toHaveBeenCalledOnce();
    expect(f.callbacks.onToolResult).toHaveBeenCalledExactlyOnceWith({ text: "done" });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.clearActive).not.toHaveBeenCalled();
    f.result.resolve({ status: "completed", stopReason: "end_turn" });
    // Flush only the consumer's zero-delay terminal drain, not the host deadline.
    await vi.advanceTimersByTimeAsync(0);
    const result = await attempt;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(f.committed).toEqual([
      expect.objectContaining({
        idempotencyKey: `${turn.requestId}:acp:assistant`,
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "thinking" },
          { type: "text", text: "hello world" },
        ],
      }),
    ]);
    expect(result).toMatchObject({
      agentHarnessId: "acp-fixture",
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: `${turn.requestId}:acp:assistant`,
      contextEngineTerminalAnchor: terminalAnchor,
      toolMetas: [{ toolName: "lookup", toolCallId: "tool-1", meta: "done", isError: false }],
      replayMetadata: { replaySafe: false },
    });
    expect(result.lastAssistant).toBe(f.committed[0]);
    expect(result.messagesSnapshot.at(-1)).toBe(f.committed[0]);
    expectReleased(f);
  });

  it.each(["abort", "timeout"] as const)(
    "suppresses late native output on %s and retains ownership through native settlement",
    async (reason) => {
      const partial = createDeferred<void>();
      const late = createDeferred<void>();
      const drained = createDeferred<void>();
      const f = createFixture(
        (async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "text_delta", text: "partial" };
          partial.resolve();
          await late.promise;
          yield { type: "text_delta", text: "late" };
          yield { type: "tool_call", title: "late-tool", text: "late" };
          drained.resolve();
        })(),
      );
      f.promptStarted.resolve();
      let finished = false;
      const attempt = f.execute().then((result) => {
        finished = true;
        return result;
      });
      const turn = await awaitGateBeforeSettlement(
        f.starting.promise,
        attempt,
        "native turn skipped",
      );
      await awaitGateBeforeSettlement(partial.promise, attempt, "partial output skipped");
      if (reason === "abort") {
        f.generation.abort();
      } else {
        await vi.advanceTimersByTimeAsync(f.input.timeoutMs);
      }
      expect(turn.signal?.aborted).toBe(true);
      late.resolve();
      await awaitGateBeforeSettlement(drained.promise, attempt, "late output was not drained");
      expect(f.callbacks.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: "partial" });
      expect(f.callbacks.onToolResult).not.toHaveBeenCalled();
      expect(mocks.emitEvent).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      expect(mocks.clearActive).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(f.runtime.getStatus).toHaveBeenCalledOnce();
      expect(f.callbacks.onAttemptTimeout).toHaveBeenCalledTimes(reason === "timeout" ? 1 : 0);

      f.result.resolve({ status: "cancelled", stopReason: "cancel" });
      await vi.advanceTimersByTimeAsync(0);
      const result = await attempt;
      expect(result.terminal).toMatchObject({ kind: reason === "timeout" ? "timeout" : "aborted" });
      expect(f.closeStream).toHaveBeenCalledExactlyOnceWith({ reason: "turn-result-cancelled" });
      expect(f.runtime.getStatus).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledOnce();
      expect(f.committed).toEqual([
        expect.objectContaining({
          idempotencyKey: `${turn.requestId}:acp:assistant`,
          stopReason: "aborted",
          content: [{ type: "text", text: "partial" }],
        }),
      ]);
      expect(result.assistantTexts).toEqual(["partial"]);
      expect(result.toolMetas).toEqual([]);
      expectReleased(f);
    },
  );

  it("reports native failure after partial output without committing an assistant", async () => {
    const drained = createDeferred<void>();
    const f = createFixture(
      (async function* (): AsyncGenerator<AcpRuntimeEvent> {
        yield { type: "text_delta", text: "partial" };
        drained.resolve();
      })(),
    );
    f.promptStarted.resolve();
    const attempt = f.execute();
    await awaitGateBeforeSettlement(drained.promise, attempt, "partial output skipped");
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.clearActive).not.toHaveBeenCalled();
    f.result.resolve({
      status: "failed",
      error: { code: "ACP_TURN_FAILED", message: "native backend failed" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await attempt;
    expect(result.terminal).toMatchObject({
      kind: "failed",
      source: "prompt",
      error: expect.objectContaining({ code: "ACP_TURN_FAILED", message: "native backend failed" }),
    });
    expect(result.assistantTexts).toEqual(["partial"]);
    expect(f.closeStream).toHaveBeenCalledExactlyOnceWith({ reason: "turn-result-failed" });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(f.committed).toEqual([]);
    expect(result.assistantTranscriptOwned).toBeUndefined();
    expect(result.lastAssistant).toBeUndefined();
    expectReleased(f);
  });

  it("does not mark an unsubmitted cancelled turn as sent when readiness arrives after settlement", async () => {
    const f = createFixture((async function* (): AsyncGenerator<AcpRuntimeEvent> {})());
    const attempt = f.execute();
    const turn = await awaitGateBeforeSettlement(
      f.starting.promise,
      attempt,
      "native turn skipped",
    );
    f.generation.abort();
    expect(turn.signal?.aborted).toBe(true);
    f.result.resolve({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    const result = await attempt;
    f.promptStarted.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.terminal).toEqual({ kind: "aborted", source: "external" });
    expect(result.replayMetadata).toMatchObject({ replaySafe: true });
    expect(f.recorder.markSentToProvider).not.toHaveBeenCalled();
    expect(f.callbacks.onExecutionStarted).not.toHaveBeenCalled();
    expect(f.callbacks.onPartialReply).not.toHaveBeenCalled();
    expectReleased(f);
  });
});
