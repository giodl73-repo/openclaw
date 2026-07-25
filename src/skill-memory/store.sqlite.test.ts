import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSkillMemoryStoresForTest,
  countSkillMemory,
  getSkillMemory,
  listSkillMemory,
  recordSkillMemory,
  recordSkillMemoryBatch,
  resolveSkillMemoryStorePath,
} from "./store.sqlite.js";

describe("shared Skill Memory store", () => {
  let tempDir: string;
  let databasePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-memory-"));
    databasePath = path.join(tempDir, "shared", "skill-memory.sqlite");
  });

  afterEach(() => {
    closeSkillMemoryStoresForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function record(params: {
    agentId: string;
    memoryIndex?: number;
    memoryType: string;
    subject?: { type: string; id: string };
    data?: Record<string, unknown>;
  }) {
    return recordSkillMemory(
      {
        memory: {
          type: params.memoryType,
          ...(params.subject ? { subject: params.subject } : {}),
          ...(params.data ? { data: params.data } : {}),
        },
        memoryIndex: params.memoryIndex ?? 0,
        occurredAt: 1_700_000_000_000 + (params.memoryIndex ?? 0),
        agentId: params.agentId,
        sessionId: `session-${params.agentId}`,
        sessionKey: `agent:${params.agentId}:email:thread:customer-1`,
        runId: `run-${params.agentId}`,
        toolName: "business_action",
        toolCallId: `call-${params.agentId}`,
      },
      { path: databasePath },
    );
  }

  it("stores and filters remembered facts shared by multiple agents", () => {
    record({
      agentId: "support",
      memoryType: "case.resolved",
      subject: { type: "case", id: "CAS-1042" },
    });
    record({
      agentId: "billing",
      memoryType: "payment.authorized",
      subject: { type: "invoice", id: "INV-1042" },
      data: { authorizationCode: "AUTH-9482" },
    });

    expect(
      listSkillMemory({
        filters: { type: "payment.authorized" },
        limit: 10,
        store: { path: databasePath },
      }).memories,
    ).toEqual([
      expect.objectContaining({
        memorySchema: "openclaw-skill-memory",
        type: "payment.authorized",
        agentId: "billing",
        subject: { type: "invoice", id: "INV-1042" },
        data: { authorizationCode: "AUTH-9482" },
      }),
    ]);
    expect(
      countSkillMemory({
        filters: { subjectType: "case", subjectId: "CAS-1042" },
        store: { path: databasePath },
      }),
    ).toBe(1);
    const [payment] = listSkillMemory({
      filters: { type: "payment.authorized" },
      limit: 1,
      store: { path: databasePath },
    }).memories;
    expect(getSkillMemory({ memoryId: payment!.memoryId, store: { path: databasePath } })).toEqual(
      payment,
    );
  });

  it("pages stably and treats an empty agent filter as no agents", () => {
    record({ agentId: "support", memoryIndex: 0, memoryType: "case.resolved" });
    record({ agentId: "support", memoryIndex: 1, memoryType: "case.resolved" });
    record({ agentId: "support", memoryIndex: 2, memoryType: "case.resolved" });

    const first = listSkillMemory({ limit: 2, store: { path: databasePath } });
    const second = listSkillMemory({
      cursor: first.nextCursor,
      limit: 2,
      store: { path: databasePath },
    });

    expect(first.memories.map((memory) => memory.sequence)).toEqual([3, 2]);
    expect(first.nextCursor).toBe(2);
    expect(second.memories.map((memory) => memory.sequence)).toEqual([1]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      listSkillMemory({
        filters: { agentIds: [] },
        limit: 10,
        store: { path: databasePath },
      }).memories,
    ).toEqual([]);
  });

  it("deduplicates replay of the same trusted source", () => {
    const first = record({
      agentId: "support",
      memoryType: "case.resolved",
      data: { first: 1, second: 2 },
    });
    const replay = record({
      agentId: "support",
      memoryType: "case.resolved",
      data: { second: 2, first: 1 },
    });

    expect(replay.memoryId).toBe(first.memoryId);
    expect(countSkillMemory({ store: { path: databasePath } })).toBe(1);
  });

  it("rejects changed content under the same trusted source identity", () => {
    record({ agentId: "support", memoryType: "case.resolved" });

    expect(() => record({ agentId: "support", memoryType: "case.closed" })).toThrow(
      "source identity was reused with different content",
    );
  });

  it("records a tool-result batch atomically", () => {
    record({ agentId: "support", memoryIndex: 0, memoryType: "case.resolved" });
    const base = {
      occurredAt: 1_700_000_000_100,
      agentId: "support",
      sessionId: "session-support",
      sessionKey: "agent:support:email:thread:customer-1",
      runId: "run-support",
      toolName: "business_action",
      toolCallId: "call-support",
    };

    expect(() =>
      recordSkillMemoryBatch(
        [
          { ...base, memory: { type: "customer.notified" }, memoryIndex: 1 },
          { ...base, memory: { type: "case.closed" }, memoryIndex: 0 },
        ],
        { path: databasePath },
      ),
    ).toThrow("source identity was reused with different content");
    expect(countSkillMemory({ store: { path: databasePath } })).toBe(1);
  });

  it("rejects oversized batch payloads before opening the database", () => {
    expect(() =>
      recordSkillMemoryBatch(
        [
          {
            memory: { type: "case.resolved", data: { evidence: "x".repeat(256 * 1024) } },
            memoryIndex: 0,
            occurredAt: 1_700_000_000_000,
            agentId: "support",
            sessionId: "session-support",
            runId: "run-support",
            toolName: "business_action",
            toolCallId: "call-support",
          },
        ],
        { path: databasePath },
      ),
    ).toThrow("skill memory data exceeds");
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("resolves an operator-configured SQLite path", () => {
    expect(
      resolveSkillMemoryStorePath({
        cfg: {
          skillMemory: { store: { type: "sqlite", path: databasePath } },
        },
      }),
    ).toBe(path.resolve(databasePath));
  });
});
