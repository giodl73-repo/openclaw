import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { sendMailReply } from "./graph.js";
import { buildM365MailInboundContext, type M365MailInboundMessage } from "./inbound-context.js";
import { getM365MailRuntime } from "./runtime.js";
import { buildM365MailInboundSessionKey } from "./session-key.js";
import type { ResolvedM365MailAccount } from "./types.js";

const CHANNEL_ID = "m365mail";

type M365MailChannelLog = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

function resolveM365MailInboundRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedM365MailAccount;
  conversationId: string;
}) {
  const rt = getM365MailRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: params.conversationId,
    },
  });
  return {
    rt,
    route,
    sessionKey: buildM365MailInboundSessionKey({
      agentId: route.agentId,
      accountId: params.account.accountId,
      conversationId: params.conversationId,
      identityLinks: params.cfg.session?.identityLinks,
    }),
  };
}

/**
 * Dispatch one inbound email turn.
 *
 * Email is a single-message medium, so reply blocks streamed by the agent are
 * buffered and sent as ONE Graph reply once the turn settles, rather than one
 * email per block.
 */
export async function dispatchM365MailInboundTurn(params: {
  account: ResolvedM365MailAccount;
  msg: M365MailInboundMessage;
  log?: M365MailChannelLog;
}): Promise<null> {
  const rt = getM365MailRuntime();
  const currentCfg = rt.config.loadConfig();

  const resolved = resolveM365MailInboundRoute({
    cfg: currentCfg,
    account: params.account,
    conversationId: params.msg.conversationId,
  });
  const msgCtx = buildM365MailInboundContext({
    finalizeInboundContext: resolved.rt.channel.reply.finalizeInboundContext,
    account: params.account,
    msg: params.msg,
    sessionKey: resolved.sessionKey,
  });

  const replyChunks: string[] = [];
  await resolved.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg: currentCfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; body?: string }) => {
        const text = payload.text ?? payload.body;
        if (text) {
          replyChunks.push(text);
        }
      },
      onReplyStart: () => {
        params.log?.info?.(`Agent reply started for conversation ${params.msg.conversationId}`);
      },
    },
  });

  const replyText = replyChunks.join("\n\n").trim();
  if (!replyText) {
    return null;
  }

  await sendMailReply({
    ctx: { account: params.account, agentId: params.msg.agentId },
    text: replyText,
    messageId: params.msg.messageId,
    toAddress: params.msg.fromAddress,
    subject: params.msg.subject,
  });
  params.log?.info?.(`Reply sent for conversation ${params.msg.conversationId}`);

  return null;
}
