// Reusable contract tests for ACP runtime turn adapters.
import { describe, expect, it } from "vitest";
import type { AcpRuntimeEvent, AcpRuntimeTurn, AcpRuntimeTurnResult } from "./acp-runtime.js";

export type AcpRuntimeTurnContractScenario = {
  events: AcpRuntimeEvent[];
  promptStarted?: Promise<void>;
  requestId: string;
  result: AcpRuntimeTurnResult;
};

export type AcpRuntimeTurnContractHarness = {
  turn: AcpRuntimeTurn;
  cancelCalls: Array<{ reason?: string } | undefined>;
  closeStreamCalls: Array<{ reason?: string } | undefined>;
};

export type AcpRuntimeTurnContractFactory = (
  scenario: AcpRuntimeTurnContractScenario,
) => AcpRuntimeTurnContractHarness | Promise<AcpRuntimeTurnContractHarness>;

async function collectEvents(events: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const collected: AcpRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** Installs the shared behavioral contract for an adapter's modern startTurn boundary. */
export function installAcpRuntimeTurnContractSuite(params: {
  name: string;
  createHarness: AcpRuntimeTurnContractFactory;
}): void {
  describe(`${params.name} ACP runtime turn contract`, () => {
    it("preserves request identity, event order, and the authoritative completed result", async () => {
      const scenario: AcpRuntimeTurnContractScenario = {
        requestId: "contract-completed",
        events: [
          { type: "text_delta", text: "hello" },
          { type: "status", text: "working" },
          { type: "tool_call", text: "read file", toolCallId: "tool-1" },
        ],
        result: { status: "completed", stopReason: "end_turn" },
      };
      const { turn } = await params.createHarness(scenario);

      expect(turn.requestId).toBe(scenario.requestId);
      await expect(collectEvents(turn.events)).resolves.toEqual(scenario.events);
      await expect(turn.result).resolves.toEqual(scenario.result);
    });

    it("keeps terminal failure separate from streamed events", async () => {
      const scenario: AcpRuntimeTurnContractScenario = {
        requestId: "contract-failed",
        events: [{ type: "text_delta", text: "partial" }],
        result: {
          status: "failed",
          error: { message: "backend disconnected", code: "ACP_TURN_FAILED", retryable: true },
        },
      };
      const { turn } = await params.createHarness(scenario);

      await expect(collectEvents(turn.events)).resolves.toEqual(scenario.events);
      await expect(turn.result).resolves.toEqual(scenario.result);
    });

    it("exposes prompt submission readiness", async () => {
      let markPromptStarted: (() => void) | undefined;
      const promptStarted = new Promise<void>((resolve) => {
        markPromptStarted = resolve;
      });
      const scenario: AcpRuntimeTurnContractScenario = {
        requestId: "contract-prompt-started",
        promptStarted,
        events: [],
        result: { status: "completed" },
      };
      const { turn } = await params.createHarness(scenario);
      let observed = false;
      void turn.promptStarted?.then(() => {
        observed = true;
      });

      await Promise.resolve();
      expect(turn.promptStarted).toBeDefined();
      expect(observed).toBe(false);
      markPromptStarted?.();
      await turn.promptStarted;
      expect(observed).toBe(true);
    });

    it("forwards cancellation with its reason", async () => {
      const scenario: AcpRuntimeTurnContractScenario = {
        requestId: "contract-cancel",
        events: [],
        result: { status: "cancelled", stopReason: "user-request" },
      };
      const harness = await params.createHarness(scenario);

      await harness.turn.cancel({ reason: "user-request" });

      expect(harness.cancelCalls).toEqual([{ reason: "user-request" }]);
    });

    it("forwards early stream closure with its reason", async () => {
      const scenario: AcpRuntimeTurnContractScenario = {
        requestId: "contract-close-stream",
        events: [],
        result: { status: "completed" },
      };
      const harness = await params.createHarness(scenario);

      await harness.turn.closeStream({ reason: "consumer-stopped" });

      expect(harness.closeStreamCalls).toEqual([{ reason: "consumer-stopped" }]);
    });
  });
}
