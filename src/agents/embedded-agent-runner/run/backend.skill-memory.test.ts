import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  record: vi.fn(),
  runAttempt: vi.fn(),
  getRun: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../skill-memory/store.sqlite.js", () => ({
  isSkillMemoryStoreEnabled: mocks.enabled,
  recordSkillMemoryBatch: mocks.record,
}));
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: mocks.runAttempt,
}));
vi.mock("../../subagent-registry.js", () => ({
  getSubagentRunByRunId: mocks.getRun,
}));
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn } }));

import { runEmbeddedAttemptWithBackend } from "./backend.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const recordedPayment = {
  memorySchema: "openclaw-skill-memory" as const,
  schemaVersion: 1 as const,
  sequence: 1,
  memoryId: "smem_payment",
  type: "payment.authorized",
  occurredAt: 1_700_000_000_000,
  agentId: "billing",
  sessionId: "session-billing",
  sessionKey: "agent:billing:email:thread:42",
  runId: "run-billing",
  toolName: "authorize_payment",
  toolCallId: "call-payment",
  subject: { type: "invoice", id: "INV-1042" },
  data: { authorizationCode: "AUTH-9482" },
};

function createParams(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "billing",
    config: {},
    runId: "run-billing",
    sessionId: "session-billing",
    sessionKey: "agent:billing:email:thread:42",
    ...overrides,
  } as unknown as EmbeddedRunAttemptParams;
}

describe("embedded backend memory composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.getRun.mockReturnValue(undefined);
    mocks.record.mockReturnValue([recordedPayment]);
    mocks.runAttempt.mockImplementation(async (params: EmbeddedRunAttemptParams) => {
      params.onAgentToolResult?.({
        toolCallId: "call-payment",
        toolName: "authorize_payment",
        result: {
          content: [{ type: "text", text: "authorized" }],
          details: {},
          memories: [
            {
              type: "payment.authorized",
              subject: { type: "invoice", id: "INV-1042" },
              data: { authorizationCode: "AUTH-9482" },
            },
          ],
        },
        isError: false,
      });
      return {} as never;
    });
  });

  it("records trusted correlation and only a bounded trajectory reference", async () => {
    const trajectoryRecorder = { recordEvent: vi.fn() };

    await runEmbeddedAttemptWithBackend(createParams({ trajectoryRecorder }));

    expect(mocks.record).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          agentId: "billing",
          sessionId: "session-billing",
          sessionKey: "agent:billing:email:thread:42",
          runId: "run-billing",
          toolName: "authorize_payment",
          toolCallId: "call-payment",
          memory: expect.objectContaining({ type: "payment.authorized" }),
        }),
      ],
      { cfg: {} },
    );
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "skill.memory.remembered",
      expect.objectContaining({ memoryId: "smem_payment", type: "payment.authorized" }),
    );
    expect(trajectoryRecorder.recordEvent.mock.calls[0]?.[1]).not.toHaveProperty("data");
  });

  it("adds managed skill identity owned by the child run registry", async () => {
    mocks.getRun.mockReturnValue({
      managedSkill: {
        invocationId: "skill-payment",
        skillName: "authorize-payment",
        skillDigest: "sha256:abc",
      },
    });

    await runEmbeddedAttemptWithBackend(createParams());

    expect(mocks.record).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          invocationId: "skill-payment",
          skillName: "authorize-payment",
          skillDigest: "sha256:abc",
        }),
      ],
      { cfg: {} },
    );
  });

  it("contains recording failure without changing the tool observation", async () => {
    const onAgentToolResult = vi.fn();
    mocks.record.mockImplementation(() => {
      throw new Error("store locked");
    });

    await runEmbeddedAttemptWithBackend(createParams({ onAgentToolResult }));

    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("store locked"));
  });

  it("records at most one bounded batch and reports overflow", async () => {
    mocks.record.mockReturnValue([]);
    mocks.runAttempt.mockImplementation(async (params: EmbeddedRunAttemptParams) => {
      params.onAgentToolResult?.({
        toolCallId: "call-many",
        toolName: "authorize_payment",
        result: {
          memories: Array.from({ length: 19 }, (_, index) => ({
            type: `payment.authorized.${index}`,
          })),
        },
        isError: false,
      });
      return {} as never;
    });

    await runEmbeddedAttemptWithBackend(createParams());

    expect(mocks.record.mock.calls[0]?.[0]).toHaveLength(16);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("ignored 3"));
  });
});
