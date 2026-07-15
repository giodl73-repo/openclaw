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

describe("embedded OpenClaw Lobster registry", () => {
  it("invokes a policy-filtered OpenClaw tool in the current session", async () => {
    const invoke = vi.fn().mockResolvedValue({ sent: true });
    const registry = createOpenClawLobsterRegistry(baseRegistry(), invoke);
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
    const command = createOpenClawLobsterRegistry(baseRegistry(), invoke).get("clawd.invoke");

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

  it("rejects attempts to select another OpenClaw session", async () => {
    const command = createOpenClawLobsterRegistry(baseRegistry(), vi.fn()).get("openclaw.invoke");

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
    const command = createOpenClawLobsterRegistry(baseRegistry(), vi.fn()).get("openclaw.invoke");

    await expect(
      command?.run({
        input: input(),
        args: { tool: "lobster", action: "run" },
        ctx: { env: {} },
      }),
    ).rejects.toThrow("cannot recursively invoke the lobster tool");
  });
});
