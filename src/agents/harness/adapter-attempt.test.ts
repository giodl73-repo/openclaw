import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { appendSessionTranscriptMessageByIdentityStrict } from "../../plugin-sdk/session-transcript-runtime.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { buildSessionContext } from "../sessions/session-manager-codec.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { runAgentHarnessAdapterAttempt, type AgentHarnessTurnAdapter } from "./adapter-attempt.js";
import type { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

type PreparedAdapter = Awaited<ReturnType<AgentHarnessTurnAdapter["prepare"]>>;
type Turn = Parameters<PreparedAdapter["run"]>[0];
type Outcome = Awaited<ReturnType<PreparedAdapter["run"]>>;
type StoredAssistant = AssistantMessage & { idempotencyKey: string };

const mocks = vi.hoisted(() => ({
  openContext: vi.fn(),
  append: vi.fn<typeof appendSessionTranscriptMessageByIdentityStrict<StoredAssistant>>(),
  setActive: vi.fn<typeof setActiveEmbeddedRun>(),
  clearActive: vi.fn(),
  emitEvent: vi.fn(),
  buildPrompt: vi.fn<typeof resolveAgentHarnessBeforePromptBuildResult>(),
}));

vi.mock("../../config/sessions/paths.js", () => ({ resolveStorePath: () => "/test/store" }));
vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent: mocks.emitEvent }));
// This module defines the strict append operation; do not mock the harness SDK barrel.
vi.mock("../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendSessionTranscriptMessageByIdentityStrict: mocks.append,
}));
vi.mock("../bootstrap-files.js", () => ({ resolveBootstrapContextForRun: vi.fn() }));
vi.mock("../embedded-agent-runner/runs.js", () => ({
  setActiveEmbeddedRun: mocks.setActive,
  clearActiveEmbeddedRun: mocks.clearActive,
}));
vi.mock("../sessions/session-manager.js", async () => {
  const codec = await import("../sessions/session-manager-codec.js");
  return {
    buildSessionContext: codec.buildSessionContext,
    SessionManager: { openModelContextAsync: mocks.openContext },
  };
});
vi.mock("./prompt-compaction-hook-helpers.js", () => ({
  resolveAgentHarnessBeforePromptBuildResult: mocks.buildPrompt,
}));

const terminalAnchor: TranscriptEntryAnchor = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:test",
  storePath: "/test/store",
  generation: "generation-1",
  entryId: "assistant-1",
  rawSeq: 3,
  effectiveParentId: "user-1",
  activeMessagePosition: 2,
};
const outcome: Outcome = {
  cancelled: false,
  permissionDenied: false,
  assistantIdempotencyKey: "turn-1:assistant",
  readUsage: async () => ({ input: 4, output: 2, total: 6 }),
};

function createFixture() {
  const user = { role: "user" as const, content: "hello", timestamp: 1 };
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "previous-user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { ...user, content: "previous turn" },
    },
    {
      type: "message",
      id: "user-1",
      parentId: "previous-user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: user,
    },
  ];
  let persisted = false;
  const persistApproved = vi.fn<UserTurnTranscriptRecorder["persistApproved"]>(async () => {
    persisted = true;
    return undefined;
  });
  const recorder = {
    message: user,
    resolveMessage: async () => user,
    getAdmissionReceipt: () =>
      persisted
        ? {
            ...terminalAnchor,
            entryId: "user-1",
            rawSeq: 2,
            effectiveParentId: "previous-user",
            activeMessagePosition: 1,
            logicalTurnId: "turn-1",
            role: "user" as const,
          }
        : undefined,
    markSentToProvider: vi.fn(),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    hasPersisted: () => persisted,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  } satisfies UserTurnTranscriptRecorder;
  const assertActive = vi.fn();
  const callbacks = {
    onAssistantMessageStart: vi.fn(),
    onAgentEvent: vi.fn(),
    onPartialReply: vi.fn(),
    onReasoningStream: vi.fn(),
    onToolResult: vi.fn(),
    onExecutionStarted: vi.fn(),
    onAttemptTimeout: vi.fn(),
  };
  const input: AgentHarnessAttemptParamsV2 = {
    agentId: "main",
    sessionId: terminalAnchor.sessionId,
    sessionKey: terminalAnchor.sessionKey,
    sessionFile: "/test/session.jsonl",
    workspaceDir: "/test/workspace",
    runId: "run-1",
    prompt: "hello",
    timeoutMs: 1_000,
    provider: "fixture",
    modelId: "fixture-model",
    model: makeProviderModelFixture({
      id: "fixture-model",
      provider: "fixture",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
    }),
    // External adapters must not reach the embedded runner's auth or model registry.
    get authStorage(): never {
      throw new Error("Unexpected embedded auth access");
    },
    get modelRegistry(): never {
      throw new Error("Unexpected embedded model registry access");
    },
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    userTurnTranscriptRecorder: recorder,
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive,
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async ({ params }) => ({ blocked: false, params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
    ...callbacks,
  };
  const committed: StoredAssistant[] = [];
  mocks.openContext.mockImplementation(async () => ({
    getBranch: () => entries,
    buildSessionContext: () => ({
      messages: [...buildSessionContext(entries).messages, ...committed],
    }),
  }));
  mocks.append.mockImplementation(async (params) => {
    const message = params.prepareMessageAfterIdempotencyCheck
      ? params.prepareMessageAfterIdempotencyCheck(params.message)
      : params.message;
    if (!message) {
      return { kind: "suppressed" };
    }
    committed.push(message);
    return {
      kind: "result",
      result: {
        appended: true,
        message,
        anchor: terminalAnchor,
        messageId: terminalAnchor.entryId,
      },
    };
  });
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
  const generation = new AbortController();
  const execute = () =>
    runAgentHarnessAdapterAttempt({
      input,
      harnessId: "fake-adapter",
      label: "Fake adapter",
      generationSignal: generation.signal,
      adapter: { prepare },
    });
  return {
    input,
    recorder,
    persistApproved,
    assertActive,
    callbacks,
    committed,
    run,
    prepare,
    generation,
    execute,
  };
}

function expectReleased(fixture: ReturnType<typeof createFixture>) {
  const activeRun = mocks.setActive.mock.calls[0]?.[1];
  expect(activeRun).toBeDefined();
  expect(mocks.clearActive).toHaveBeenCalledExactlyOnceWith(
    fixture.input.sessionId,
    activeRun,
    fixture.input.sessionKey,
    fixture.input.sessionFile,
  );
  expect(activeRun?.isStreaming()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.buildPrompt.mockResolvedValue({
    prompt: "hooked hello",
    developerInstructions: "instructions",
  });
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
