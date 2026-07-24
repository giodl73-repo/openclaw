import { describe, expect, it } from "vitest";
import {
  collectToolSkillMemory,
  isTrajectorySkillMemory,
  MAX_SKILL_MEMORY_PER_TOOL_RESULT,
} from "./skill-memory.js";
import type { TrajectoryEvent } from "./types.js";

describe("collectToolSkillMemory", () => {
  it("collects successful memories that can be filtered by business type", () => {
    const { memories } = collectToolSkillMemory({
      toolCallId: "call-1",
      toolName: "payments.authorize",
      isError: false,
      result: {
        memories: [
          {
            type: "inventory.sent",
            subject: { type: "shipment", id: "ship-1" },
          },
          {
            type: "payment.authorized",
            version: 1,
            subject: { type: "invoice", id: "inv-123" },
            data: { authorizationCode: "auth-456" },
          },
        ],
      },
    });

    expect(memories.filter((memory) => memory.type === "payment.authorized")).toEqual([
      {
        type: "payment.authorized",
        version: 1,
        subject: { type: "invoice", id: "inv-123" },
        data: { authorizationCode: "auth-456" },
        toolCallId: "call-1",
        toolName: "payments.authorize",
      },
    ]);
  });

  it("does not record failed tool results", () => {
    expect(
      collectToolSkillMemory({
        toolCallId: "call-1",
        toolName: "payments.authorize",
        isError: true,
        result: { memories: [{ type: "payment.authorized" }] },
      }),
    ).toEqual({ memories: [], omittedCandidateCount: 0 });
  });

  it("drops an entire memory when any producer field is malformed", () => {
    expect(
      collectToolSkillMemory({
        toolCallId: "call-2",
        toolName: "inventory.send",
        isError: false,
        result: {
          memories: [
            null,
            { type: "" },
            { type: " inventory.sent ", version: 0, subject: { type: "shipment" } },
          ],
        },
      }),
    ).toEqual({ memories: [], omittedCandidateCount: 0 });
  });

  it("bounds memory candidates admitted from one tool result", () => {
    const collected = collectToolSkillMemory({
      toolCallId: "call-many",
      toolName: "inventory.send",
      isError: false,
      result: {
        memories: Array.from({ length: MAX_SKILL_MEMORY_PER_TOOL_RESULT + 3 }, (_, index) => ({
          type: `inventory.sent.${index}`,
        })),
      },
    });

    expect(collected.memories).toHaveLength(MAX_SKILL_MEMORY_PER_TOOL_RESULT);
    expect(collected.omittedCandidateCount).toBe(3);
  });
});

describe("isTrajectorySkillMemory", () => {
  const memoryEvent: TrajectoryEvent = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    type: "skill.memory.remembered",
    ts: "2026-07-13T12:00:00.000Z",
    seq: 1,
    sessionId: "session-1",
    data: {
      type: "payment.authorized",
      memoryId: "smem_1",
    },
  };

  it("matches any valid memory when no business type is requested", () => {
    expect(isTrajectorySkillMemory(memoryEvent)).toBe(true);
  });

  it("filters memories by exact business type", () => {
    expect(isTrajectorySkillMemory(memoryEvent, "payment.authorized")).toBe(true);
    expect(isTrajectorySkillMemory(memoryEvent, "inventory.sent")).toBe(false);
  });

  it("rejects non-memory and untyped events", () => {
    expect(isTrajectorySkillMemory({ ...memoryEvent, type: "tool.result" })).toBe(false);
    expect(
      isTrajectorySkillMemory({
        ...memoryEvent,
        data: { data: { authorizationCode: "auth-456" } },
      }),
    ).toBe(false);
  });
});
