/**
 * Microsoft Graph mail client.
 *
 * The m365mail owner prepares exact Graph URL, identity, body, credential-slot,
 * and response semantics before either the legacy transparent proxy or a hosted
 * provider-request dispatcher performs physical I/O.
 */

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  acceptM365MailGraphResponseV1,
  prepareM365MailGraphRequestV1,
  M365MailGraphRequestError,
  type M365MailGraphOperationV1,
} from "./graph-request.js";
import type { ResolvedM365MailAccount } from "./types.js";

const GRAPH_REQUEST_TIMEOUT_MS = 30_000;

export interface M365MailGraphContext {
  account: ResolvedM365MailAccount;
  /**
   * Optional inbound assertion of the agent mailbox identity. It must match the
   * trusted account identity and can never override it.
   */
  agentId?: string;
  /** Optional bearer token for the legacy non-brokered mode. */
  token?: string;
}

async function graphRequest(params: {
  ctx: M365MailGraphContext;
  operation: M365MailGraphOperationV1;
}): Promise<void> {
  const { account, token } = params.ctx;
  if (!account.brokered && !token) {
    throw new M365MailGraphRequestError(
      "credential-missing",
      "Non-brokered Microsoft Graph mail requires an explicit bearer token",
    );
  }
  const prepared = prepareM365MailGraphRequestV1({
    context: {
      account,
      ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
    },
    operation: params.operation,
  });
  const headers = new Headers(prepared.headers);
  if (!account.brokered && token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const init: RequestInit = {
    method: prepared.method,
    headers,
    body: prepared.body ? Uint8Array.from(prepared.body) : undefined,
  };

  if (account.brokered) {
    // The external host captures this exact allowlisted Graph URL through its transparent
    // RFC2544 sinkhole. A DNS-based SSRF guard would reject that trusted route
    // before the broker can inject the owner credential.
    const response = await fetch(prepared.url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
    });
    await acceptM365MailGraphResponseV1(response, prepared.responsePolicy);
    return;
  }

  const result = await fetchWithSsrFGuard({
    url: prepared.url,
    init,
    auditContext: "m365mail-graph",
    timeoutMs: GRAPH_REQUEST_TIMEOUT_MS,
    requireHttps: true,
    maxRedirects: 0,
  });
  try {
    await acceptM365MailGraphResponseV1(result.response, prepared.responsePolicy);
  } finally {
    await result.release();
  }
}

function normalizeReplySubject(subject?: string): string {
  const trimmed = subject?.trim();
  if (!trimmed) {
    return "Re:";
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Reply to an inbound email.
 *
 * Prefers a threaded reply against the original Graph message id. Falls back to
 * a fresh `sendMail` to the sender address when no message id is available.
 */
export async function sendMailReply(params: {
  ctx: M365MailGraphContext;
  text: string;
  messageId?: string;
  toAddress?: string;
  subject?: string;
}): Promise<void> {
  if (params.messageId) {
    await graphRequest({
      ctx: params.ctx,
      operation: {
        kind: "reply",
        messageId: params.messageId,
        text: params.text,
      },
    });
    return;
  }
  if (!params.toAddress) {
    throw new Error("m365mail: cannot reply - neither messageId nor sender address is available");
  }
  await sendNewMail({
    ctx: params.ctx,
    text: params.text,
    toAddress: params.toAddress,
    subject: normalizeReplySubject(params.subject),
  });
}

/** Send a brand-new email (used for proactive outbound and pairing notices). */
export async function sendNewMail(params: {
  ctx: M365MailGraphContext;
  text: string;
  toAddress: string;
  subject: string;
}): Promise<void> {
  await graphRequest({
    ctx: params.ctx,
    operation: {
      kind: "send",
      text: params.text,
      toAddress: params.toAddress,
      subject: params.subject,
    },
  });
}
