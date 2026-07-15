import { beforeEach, describe, expect, it, vi } from "vitest";
import type { M365MailInboundMessage } from "./inbound-context.js";
import { dispatchM365MailInboundTurn } from "./inbound-turn.js";
import { setM365MailRuntime } from "./runtime.js";
import type { ResolvedM365MailAccount } from "./types.js";

type SendMailReply = typeof import("./graph.js").sendMailReply;
type MockWithCalls<TArgs extends readonly unknown[]> = { mock: { calls: TArgs[] } };
type RouteArgs = {
  cfg: { session?: { identityLinks?: unknown } };
  channel: string;
  accountId: string;
  peer: { kind: string; id: string };
};
type ReplyBlock = { text?: string; body?: string };

function firstMockCall<TArgs extends readonly unknown[]>(
  mock: MockWithCalls<TArgs>,
  label: string,
): TArgs {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

// Isolate the dispatcher's own logic (route/session resolve → buffer reply
// blocks → single Graph reply) by mocking only the Graph egress. The runtime
// store, session-key builder, and inbound-context builder all run for real so
// the test exercises the actual wiring, not a re-implementation of it.
const sendMailReply = vi.fn<SendMailReply>(async () => {});
vi.mock("./graph.js", () => ({
  sendMailReply: (params: Parameters<SendMailReply>[0]) => sendMailReply(params),
}));

const ACCOUNT: ResolvedM365MailAccount = {
  accountId: "default",
  enabled: true,
  brokered: true,
  graphBaseUrl: "https://graph.microsoft.com/v1.0",
  agentId: "00000000-0000-0000-0000-0000000000aa",
  webhookPath: "/m365mail/webhook",
  dmPolicy: "open",
  allowedSenders: [],
  allowCrossTenant: false,
  rateLimitPerMinute: 30,
  botName: "TestAgent",
};

const MSG: M365MailInboundMessage = {
  body: "hello agent",
  conversationId: "thread-42",
  messageId: "msg-42",
  fromAddress: "sender@contoso.com",
  agentId: "00000000-0000-0000-0000-0000000000bb",
  senderName: "Sender",
  subject: "Re: status",
  accountId: "default",
  commandAuthorized: true,
};

/**
 * Build a fake PluginRuntime whose reply dispatcher invokes `deliver` with the
 * supplied block payloads (and `onReplyStart` once), so the test can drive the
 * buffering path deterministically. `finalizeInboundContext` echoes its input so
 * the assembled context is observable, and `resolveAgentRoute` returns a fixed
 * agent id.
 */
function installFakeRuntime(blocks: ReplyBlock[]) {
  const resolveAgentRoute = vi.fn<(args: RouteArgs) => { agentId: string }>(() => ({
    agentId: "agent-1",
  }));
  const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
    async (args: {
      dispatcherOptions: {
        deliver: (p: ReplyBlock) => Promise<void> | void;
        onReplyStart?: () => void;
      };
    }) => {
      args.dispatcherOptions.onReplyStart?.();
      for (const block of blocks) {
        await args.dispatcherOptions.deliver(block);
      }
    },
  );
  const runtime = {
    config: { loadConfig: () => ({ session: { identityLinks: undefined } }) },
    channel: {
      routing: { resolveAgentRoute },
      reply: { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setM365MailRuntime(runtime as any);
  return { resolveAgentRoute, finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher };
}

describe("dispatchM365MailInboundTurn", () => {
  beforeEach(() => {
    sendMailReply.mockClear();
  });

  it("buffers streamed reply blocks into ONE Graph reply for the mail thread", async () => {
    installFakeRuntime([{ text: "first block" }, { body: "second block" }]);

    const result = await dispatchM365MailInboundTurn({ account: ACCOUNT, msg: MSG });

    expect(result).toBeNull();
    // Email is single-message: exactly one Graph reply, not one per block.
    expect(sendMailReply).toHaveBeenCalledTimes(1);
    const [call] = firstMockCall(sendMailReply, "sendMailReply");
    // Blocks joined with a blank line and trimmed.
    expect(call.text).toBe("first block\n\nsecond block");
    expect(call.messageId).toBe("msg-42");
    expect(call.toAddress).toBe("sender@contoso.com");
    expect(call.subject).toBe("Re: status");
    // The reply self-addresses via the inbound activity's agent id (preferred
    // over the env-seeded account id).
    expect(call.ctx.agentId).toBe(MSG.agentId);
  });

  it("prefers payload.text over payload.body when both are present", async () => {
    installFakeRuntime([{ text: "chosen", body: "ignored" }]);

    await dispatchM365MailInboundTurn({ account: ACCOUNT, msg: MSG });

    expect(sendMailReply).toHaveBeenCalledTimes(1);
    const [call] = firstMockCall(sendMailReply, "sendMailReply");
    expect(call.text).toBe("chosen");
  });

  it("sends no Graph reply when the agent produced no reply blocks", async () => {
    installFakeRuntime([]);

    const result = await dispatchM365MailInboundTurn({ account: ACCOUNT, msg: MSG });

    expect(result).toBeNull();
    expect(sendMailReply).not.toHaveBeenCalled();
  });

  it("sends no Graph reply when reply blocks are whitespace-only", async () => {
    installFakeRuntime([{ text: "   " }, { text: "\n" }]);

    await dispatchM365MailInboundTurn({ account: ACCOUNT, msg: MSG });

    expect(sendMailReply).not.toHaveBeenCalled();
  });

  it("resolves the agent route for the inbound conversation id", async () => {
    const { resolveAgentRoute } = installFakeRuntime([{ text: "ok" }]);

    await dispatchM365MailInboundTurn({ account: ACCOUNT, msg: MSG });

    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
    const [routeArgs] = firstMockCall(resolveAgentRoute, "resolveAgentRoute");
    expect(routeArgs.channel).toBe("m365mail");
    expect(routeArgs.accountId).toBe("default");
    expect(routeArgs.peer).toEqual({ kind: "direct", id: "thread-42" });
  });

  it("logs turn start and reply-sent when a log sink is provided", async () => {
    installFakeRuntime([{ text: "ok" }]);
    const info = vi.fn<(...args: unknown[]) => void>();

    await dispatchM365MailInboundTurn({ account: ACCOUNT, msg: MSG, log: { info } });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("Agent reply started"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Reply sent"));
  });
});
