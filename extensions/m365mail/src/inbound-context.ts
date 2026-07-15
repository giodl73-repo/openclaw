import type { ResolvedM365MailAccount } from "./types.js";

const CHANNEL_ID = "m365mail";

/** Normalized inbound email message handed to the dispatcher. */
export type M365MailInboundMessage = {
  /** Sanitized plain-text body. */
  body: string;
  /** Email conversation/thread id — the session peer. */
  conversationId: string;
  /** Graph message id of the inbound mail, for threaded replies. */
  messageId?: string;
  /** Sender SMTP address (fallback reply target + sender identity). */
  fromAddress: string;
  /** Sender AAD object id, when known. */
  fromId?: string;
  /**
   * An inbound assertion of the configured mailbox identity. The activity may
   * carry object-id and UPN forms; neither can override the trusted account id.
   */
  agentId?: string;
  senderName: string;
  subject?: string;
  accountId: string;
  commandAuthorized: boolean;
};

export function buildM365MailInboundContext<TContext>(params: {
  finalizeInboundContext: (ctx: Record<string, unknown>) => TContext;
  account: ResolvedM365MailAccount;
  msg: M365MailInboundMessage;
  sessionKey: string;
}): TContext {
  const { account, msg, sessionKey } = params;
  const peer = `${CHANNEL_ID}:${msg.conversationId}`;
  return params.finalizeInboundContext({
    Body: msg.body,
    RawBody: msg.body,
    CommandBody: msg.body,
    From: peer,
    To: peer,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: peer,
    ChatType: "direct",
    SenderName: msg.senderName,
    SenderId: msg.fromAddress || msg.fromId || msg.conversationId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: msg.subject || msg.senderName || msg.fromAddress || msg.conversationId,
    Timestamp: Date.now(),
    CommandAuthorized: msg.commandAuthorized,
  });
}
