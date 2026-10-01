import path from "node:path";
import { expect, vi } from "vitest";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import * as agentEvents from "../../infra/agent-events.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { appendSessionTranscriptMessageByIdentityStrict } from "../../plugin-sdk/session-transcript-runtime.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { buildSessionContext } from "../sessions/session-manager-codec.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import type { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

type StoredAssistant = AssistantMessage & { idempotencyKey: string };

const mocks = vi.hoisted(() => ({
  openContext: vi.fn(),
  append: vi.fn<typeof appendSessionTranscriptMessageByIdentityStrict<StoredAssistant>>(),
  setActive: vi.fn<typeof setActiveEmbeddedRun>(),
  clearActive: vi.fn(),
  emitEvent: vi.fn(),
  buildPrompt: vi.fn<typeof resolveAgentHarnessBeforePromptBuildResult>(),
}));

export { mocks };

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

export const terminalAnchor: TranscriptEntryAnchor = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:test",
  storePath: path.resolve("/test/store"),
  generation: "generation-1",
  entryId: "assistant-1",
  rawSeq: 3,
  effectiveParentId: "user-1",
  activeMessagePosition: 2,
};

export function createHostFixture() {
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
    config: { session: { store: terminalAnchor.storePath } },
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
  const generation = new AbortController();
  return {
    input,
    recorder,
    persistApproved,
    assertActive,
    callbacks,
    committed,
    generation,
  };
}

export function expectReleased(fixture: ReturnType<typeof createHostFixture>) {
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

export function resetHostFixture() {
  vi.resetAllMocks();
  vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(mocks.emitEvent);
  mocks.buildPrompt.mockResolvedValue({
    prompt: "hooked hello",
    developerInstructions: "instructions",
  });
}
