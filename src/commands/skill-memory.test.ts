import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../skill-memory/store.sqlite.js", () => ({
  countSkillMemory: mocks.count,
  getSkillMemory: mocks.get,
  listSkillMemory: mocks.list,
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));

import { skillMemoryCommand } from "./skill-memory.js";

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

const paymentMemory = {
  memorySchema: "openclaw-skill-memory" as const,
  schemaVersion: 1 as const,
  sequence: 8,
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

describe("memories command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists exact remembered facts with session correlation", async () => {
    mocks.list.mockReturnValue({ memories: [paymentMemory], nextCursor: 8 });
    const runtime = createRuntime();

    await skillMemoryCommand(
      { type: "payment.authorized", agent: "billing,support", limit: "25" },
      runtime,
    );

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { type: "payment.authorized", agentIds: ["billing", "support"] },
        limit: 25,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("payment.authorized"));
    expect(runtime.log).toHaveBeenCalledWith("More memories: --cursor 8");
  });

  it("counts without loading memory payloads", async () => {
    mocks.count.mockReturnValue(12);
    const runtime = createRuntime();

    await skillMemoryCommand({ type: "case.resolved", count: true }, runtime);

    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { type: "case.resolved" } }),
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("12");
  });

  it("gets full evidence by memory id", async () => {
    mocks.get.mockReturnValue(paymentMemory);
    const runtime = createRuntime();

    await skillMemoryCommand({ id: "smem_payment" }, runtime);

    expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ memoryId: "smem_payment" }));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("AUTH-9482"));
  });
});
