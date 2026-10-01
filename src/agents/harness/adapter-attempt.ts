import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type { NormalizedUsage } from "../usage.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

export type AgentHarnessAdapterEvent =
  | { type: "text"; text: string; reasoning?: boolean }
  | { type: "tool"; toolCallId?: string; name: string; text: string; failed: boolean };

/** An ordinary external turn, not a replacement for native steering or compaction. */
export type AgentHarnessTurnAdapter = {
  prepare(context: {
    signal: AbortSignal;
    assertActive: () => void;
    agentId: string;
    sessionKey: string;
    entries: SessionEntry[];
  }): Promise<{
    /** Native continuity determines the suffix; the host still owns transcript admission. */
    replayAfterIndex: number;
    includeBootstrap: boolean;
    run(turn: {
      admissionEntryId: string;
      prompt: string;
      developerInstructions: string | undefined;
      previousMessages: EmbeddedRunAttemptResult["messagesSnapshot"];
      eventGate: { open: boolean };
      markSubmitted: () => void;
      emit: (event: AgentHarnessAdapterEvent) => Promise<void>;
    }): Promise<{
      cancelled: boolean;
      permissionDenied: boolean;
      assistantIdempotencyKey: string;
      /** Read ancillary usage after the host records the authoritative native outcome. */
      readUsage: () => Promise<NormalizedUsage | undefined>;
    }>;
  }>;
};

export type AgentHarnessAdapterAttemptParams = {
  input: AgentHarnessAttemptParamsV2;
  harnessId: string;
  label: string;
  generationSignal: AbortSignal;
  adapter: AgentHarnessTurnAdapter;
};

export async function runAgentHarnessAdapterAttempt(
  params: AgentHarnessAdapterAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  // Keep transcript and runner dependencies out of other adapters' SDK startup path.
  const runtime = await import("./adapter-attempt-runtime.js");
  return await runtime.runAgentHarnessAdapterAttempt(params);
}
