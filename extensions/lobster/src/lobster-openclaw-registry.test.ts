import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawLobsterRegistry,
  type LobsterCommandRegistry,
} from "./lobster-openclaw-registry.js";

async function* input(...items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

async function collect(stream: AsyncIterable<unknown>) {
  const items: unknown[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

function baseRegistry(): LobsterCommandRegistry {
  return {
    get: vi.fn(),
    list: () => ["json", "openclaw.invoke"],
  };
}

function completedRunWaiter() {
  return vi.fn().mockResolvedValue({ status: "ok" as const });
}

describe("embedded OpenClaw Lobster registry", () => {
  it("invokes a policy-filtered OpenClaw tool in the current session", async () => {
    const invoke = vi.fn().mockResolvedValue({ sent: true });
    const registry = createOpenClawLobsterRegistry(baseRegistry(), invoke, completedRunWaiter());
    const command = registry.get("openclaw.invoke");

    const result = await command?.run({
      input: input(),
      args: {
        tool: "message",
        action: "send",
        "args-json": '{"to":"customer@example.com"}',
        "step-id": "notify-customer",
      },
      ctx: {
        env: {
          OPENCLAW_SESSION_KEY: "agent:support:email:case-42",
          OPENCLAW_TASK_FLOW_ID: "flow-42",
        },
      },
    });

    expect(invoke).toHaveBeenCalledWith({
      tool: "message",
      action: "send",
      args: { to: "customer@example.com" },
      idempotencyKey: "lobster:flow-42:notify-customer",
    });
    expect(await collect(result?.output ?? input())).toEqual([{ sent: true }]);
  });

  it("maps pipeline items with distinct stable idempotency keys", async () => {
    const invoke = vi.fn(async ({ args }: { args: Record<string, unknown> }) => ({
      id: args.invoice,
    }));
    const command = createOpenClawLobsterRegistry(baseRegistry(), invoke, completedRunWaiter()).get(
      "clawd.invoke",
    );

    const result = await command?.run({
      input: input("INV-1", "INV-2"),
      args: {
        tool: "billing",
        action: "pay",
        each: true,
        "item-key": "invoice",
        "step-id": "pay-invoice",
      },
      ctx: {
        env: {
          OPENCLAW_SESSION_KEY: "agent:finance:main",
          OPENCLAW_TASK_FLOW_ID: "flow-42",
        },
      },
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: "lobster:flow-42:pay-invoice:0" }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: "lobster:flow-42:pay-invoice:1" }),
    );
    expect(await collect(result?.output ?? input())).toEqual([{ id: "INV-1" }, { id: "INV-2" }]);
  });

  it("runs a managed skill step through sessions_spawn", async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: "accepted",
      runId: "run-child",
      childSessionKey: "agent:main:subagent:verify",
    });
    const waitForRun = vi.fn().mockResolvedValue({
      status: "ok" as const,
      audit: {
        auditSchema: "openclaw-audit-run",
        receipts: [
          {
            type: "customer.verified",
            data: { verificationId: "VER-42" },
          },
        ],
        usage: { total: 321 },
      },
    });
    const command = createOpenClawLobsterRegistry(baseRegistry(), invoke, waitForRun).get(
      "openclaw.skill",
    );

    const result = await command?.run({
      input: input(),
      args: {
        skill: "verify-customer",
        task: "Verify the customer for case 42",
        "token-budget": "12000",
        model: "anthropic/claude-sonnet-4-5",
        "task-name": "verify_customer",
        "step-id": "verify",
        "receipt-type": "customer.verified",
      },
      ctx: { env: { OPENCLAW_TASK_FLOW_ID: "flow-42" } },
    });

    expect(invoke).toHaveBeenCalledWith({
      tool: "sessions_spawn",
      args: {
        task: "Verify the customer for case 42",
        skill: "verify-customer",
        runtime: "subagent",
        mode: "run",
        tokenBudget: 12000,
        model: "anthropic/claude-sonnet-4-5",
        taskName: "verify_customer",
      },
      idempotencyKey: "lobster:flow-42:verify",
    });
    expect(await collect(result?.output ?? input())).toEqual([
      {
        status: "accepted",
        runId: "run-child",
        childSessionKey: "agent:main:subagent:verify",
        audit: {
          auditSchema: "openclaw-audit-run",
          receipts: [
            {
              type: "customer.verified",
              data: { verificationId: "VER-42" },
            },
          ],
          usage: { total: 321 },
        },
        receipt: {
          type: "customer.verified",
          data: { verificationId: "VER-42" },
        },
      },
    ]);
    expect(waitForRun).toHaveBeenCalledWith({
      runId: "run-child",
      sessionKey: "agent:main:subagent:verify",
      timeoutMs: 60_000,
    });
  });

  it("keeps managed skill steps on the current session", async () => {
    const command = createOpenClawLobsterRegistry(
      baseRegistry(),
      vi.fn(),
      completedRunWaiter(),
    ).get("clawd.skill");

    await expect(
      command?.run({
        input: input(),
        args: {
          skill: "verify-customer",
          task: "Verify the customer",
          "session-key": "agent:other:main",
        },
        ctx: { env: {} },
      }),
    ).rejects.toThrow("always uses the current OpenClaw session");
  });

  it("validates managed skill budgets before invoking OpenClaw", async () => {
    const invoke = vi.fn();
    const command = createOpenClawLobsterRegistry(baseRegistry(), invoke, completedRunWaiter()).get(
      "openclaw.skill",
    );

    await expect(
      command?.run({
        input: input(),
        args: { skill: "verify-customer", task: "Verify", "token-budget": true },
        ctx: { env: {} },
      }),
    ).rejects.toThrow("--token-budget must be a positive integer");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects attempts to select another OpenClaw session", async () => {
    const command = createOpenClawLobsterRegistry(
      baseRegistry(),
      vi.fn(),
      completedRunWaiter(),
    ).get("openclaw.invoke");

    await expect(
      command?.run({
        input: input(),
        args: {
          tool: "billing",
          action: "pay",
          "session-key": "agent:finance:main",
        },
        ctx: { env: { OPENCLAW_SESSION_KEY: "agent:support:main" } },
      }),
    ).rejects.toThrow("always uses the current OpenClaw session");
  });

  it("prevents recursive Lobster invocation", async () => {
    const command = createOpenClawLobsterRegistry(
      baseRegistry(),
      vi.fn(),
      completedRunWaiter(),
    ).get("openclaw.invoke");

    await expect(
      command?.run({
        input: input(),
        args: { tool: "lobster", action: "run" },
        ctx: { env: {} },
      }),
    ).rejects.toThrow("cannot recursively invoke the lobster tool");
  });
});
