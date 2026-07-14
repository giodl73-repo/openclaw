import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { M365MailGraphContext } from "./graph.js";
import { sendMailReply, sendNewMail } from "./graph.js";
import type { ResolvedM365MailAccount } from "./types.js";

function makeAccount(overrides: Partial<ResolvedM365MailAccount> = {}): ResolvedM365MailAccount {
  return {
    accountId: "default",
    enabled: true,
    brokered: true,
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
    agentId: "agent-oid",
    webhookPath: "/webhook/m365mail",
    dmPolicy: "open",
    allowedSenders: [],
    allowCrossTenant: false,
    rateLimitPerMinute: 30,
    botName: "OpenClaw",
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The URL passed to the most recent fetch call. */
function lastUrl(): string {
  return String(fetchMock.mock.calls.at(-1)?.[0]);
}

/** The parsed JSON body of the most recent fetch call. */
function lastBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  const body = init?.body;
  const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
  return JSON.parse(text);
}

/** The headers object of the most recent fetch call. */
function lastHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  const result = Object.fromEntries(new Headers(init?.headers).entries());
  if (result.authorization) {
    result.Authorization = result.authorization;
  }
  return result;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendNewMail", () => {
  it("self-addresses the agent mailbox by id (/users/{agentId}/sendMail), not /me", async () => {
    await sendNewMail({
      ctx: { account: makeAccount() },
      text: "hello",
      toAddress: "user@contoso.com",
      subject: "Hi",
    });
    expect(lastUrl()).toBe("https://graph.microsoft.com/v1.0/users/agent-oid/sendMail");
    expect(lastUrl()).not.toContain("/me/");
  });

  it("builds the Graph sendMail payload with saveToSentItems and a text body", async () => {
    await sendNewMail({
      ctx: { account: makeAccount() },
      text: "the body",
      toAddress: "user@contoso.com",
      subject: "Subject line",
    });
    expect(lastBody()).toEqual({
      message: {
        subject: "Subject line",
        body: { contentType: "Text", content: "the body" },
        toRecipients: [{ emailAddress: { address: "user@contoso.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("url-encodes a UPN-style agent id so an '@' cannot break the path", async () => {
    await sendNewMail({
      ctx: { account: makeAccount({ agentId: "agent@contoso.com" }) },
      text: "hello",
      toAddress: "user@contoso.com",
      subject: "Hi",
    });
    expect(lastUrl()).toBe("https://graph.microsoft.com/v1.0/users/agent%40contoso.com/sendMail");
  });

  it("throws (fail-closed) and never calls fetch when no agent mailbox id is available", async () => {
    await expect(
      sendNewMail({
        ctx: { account: makeAccount({ agentId: "" }) },
        text: "hello",
        toAddress: "user@contoso.com",
        subject: "Hi",
      }),
    ).rejects.toThrow(/agent mailbox id is unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an inbound agent id that differs from trusted owner configuration", async () => {
    await expect(
      sendNewMail({
        ctx: {
          account: makeAccount({ agentId: "env-seeded-id" }),
          agentId: "inbound-recipient-id",
        },
        text: "hello",
        toAddress: "user@contoso.com",
        subject: "Hi",
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits the Authorization header in brokered mode even when a token is present", async () => {
    await sendNewMail({
      ctx: { account: makeAccount({ brokered: true }), token: "should-be-ignored" },
      text: "hello",
      toAddress: "user@contoso.com",
      subject: "Hi",
    });
    expect(lastHeaders()).not.toHaveProperty("authorization");
  });

  it("sends the bearer in non-brokered mode when a token is supplied", async () => {
    await sendNewMail({
      ctx: { account: makeAccount({ brokered: false }), token: "tok-123" },
      text: "hello",
      toAddress: "user@contoso.com",
      subject: "Hi",
    });
    expect(lastHeaders().Authorization).toBe("Bearer tok-123");
  });

  it("rejects non-brokered mode when no bearer token is supplied", async () => {
    await expect(
      sendNewMail({
        ctx: { account: makeAccount({ brokered: false }) },
        text: "hello",
        toAddress: "user@contoso.com",
        subject: "Hi",
      }),
    ).rejects.toMatchObject({ code: "credential-missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with the Graph status and body when the response is not ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response("mailbox not found", { status: 404 }));
    await expect(
      sendNewMail({
        ctx: { account: makeAccount() },
        text: "hello",
        toAddress: "user@contoso.com",
        subject: "Hi",
      }),
    ).rejects.toMatchObject({ code: "response-rejected", status: 404 });
  });
});

describe("sendMailReply", () => {
  const ctx: M365MailGraphContext = { account: makeAccount() };

  it("threads against the original message id (/users/{agentId}/messages/{id}/reply)", async () => {
    await sendMailReply({ ctx, text: "my reply", messageId: "graph-msg-1" });
    expect(lastUrl()).toBe(
      "https://graph.microsoft.com/v1.0/users/agent-oid/messages/graph-msg-1/reply",
    );
    expect(lastBody()).toEqual({ comment: "my reply" });
  });

  it("url-encodes the message id in the reply path", async () => {
    await sendMailReply({ ctx, text: "r", messageId: "AAMk/id=with+special" });
    expect(lastUrl()).toContain("/messages/AAMk%2Fid%3Dwith%2Bspecial/reply");
  });

  it("falls back to a fresh sendMail when no message id is available", async () => {
    await sendMailReply({
      ctx,
      text: "reply body",
      toAddress: "user@contoso.com",
      subject: "Original subject",
    });
    expect(lastUrl()).toContain("/users/agent-oid/sendMail");
    expect((lastBody().message as { subject: string }).subject).toBe("Re: Original subject");
  });

  it("normalizes the fallback subject to 'Re:' and avoids double-prefixing", async () => {
    await sendMailReply({ ctx, text: "r", toAddress: "user@contoso.com", subject: "Re: Already" });
    expect((lastBody().message as { subject: string }).subject).toBe("Re: Already");

    await sendMailReply({ ctx, text: "r", toAddress: "user@contoso.com" });
    expect((lastBody().message as { subject: string }).subject).toBe("Re:");
  });

  it("throws when neither a message id nor a sender address is available", async () => {
    await expect(sendMailReply({ ctx, text: "r" })).rejects.toThrow(
      /neither messageId nor sender address/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws (fail-closed) on a reply when the agent mailbox id is unavailable", async () => {
    await expect(
      sendMailReply({
        ctx: { account: makeAccount({ agentId: "" }) },
        text: "r",
        messageId: "graph-msg-1",
      }),
    ).rejects.toThrow(/agent mailbox id is unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
