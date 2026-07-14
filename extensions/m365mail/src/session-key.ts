import { buildAgentSessionKey } from "openclaw/plugin-sdk/core";

const CHANNEL_ID = "m365mail";

/**
 * Build the agent session key for an inbound email.
 *
 * The email **conversationId** is the session peer id, so every reply in the
 * same mail thread maps to one persistent agent session — mirroring how the
 * msteams provider keys a conversation, but for mail threads.
 */
export function buildM365MailInboundSessionKey(params: {
  agentId: string;
  accountId: string;
  conversationId: string;
  identityLinks?: Record<string, string[]>;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind: "direct", id: params.conversationId },
    dmScope: "per-account-channel-peer",
    identityLinks: params.identityLinks,
  });
}
