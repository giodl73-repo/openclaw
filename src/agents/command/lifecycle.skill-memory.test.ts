import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunEntryTerminal } from "../embedded-agent-runner/run-entry.js";
import type { AgentAttemptLifecycleState } from "./attempt-callbacks.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";
import type { AgentAttemptResult } from "./runtime-loaders.js";

const mocks = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent: mocks.emitAgentEvent }));

describe("agent command lifecycle usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits exact terminal usage on a successful run", () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: true,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const lifecycle = createAgentCommandLifecycle({
      runId: "run-1",
      lifecycleGeneration: () => "generation-1",
      startedAt: 100,
      state,
    });
    const result = {
      meta: { agentMeta: { usage: { input: 12, output: 3, total: 15 } } },
    } as unknown as AgentAttemptResult;
    const terminal: EmbeddedAgentRunEntryTerminal = {
      outcome: buildAgentRunTerminalOutcome({ status: "ok" }),
      metadata: {},
    };

    lifecycle.emitEnd(result, terminal);

    expect(mocks.emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "end",
          usage: { input: 12, output: 3, total: 15 },
        }),
      }),
    );
    expect(state.lifecycleEnded).toBe(true);
  });
});
