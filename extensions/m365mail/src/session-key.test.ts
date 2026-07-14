import { describe, expect, it } from "vitest";
import { buildM365MailInboundSessionKey } from "./session-key.js";

const BASE = {
  agentId: "agent-oid",
  accountId: "default",
  conversationId: "thread-1",
};

describe("buildM365MailInboundSessionKey", () => {
  it("is stable: the same mail thread maps to the same agent session key", () => {
    // The email conversationId is the session peer, so every reply in one mail
    // thread must resolve to a single persistent agent session.
    expect(buildM365MailInboundSessionKey({ ...BASE })).toBe(
      buildM365MailInboundSessionKey({ ...BASE }),
    );
  });

  it("separates distinct mail threads into distinct session keys", () => {
    const a = buildM365MailInboundSessionKey({ ...BASE, conversationId: "thread-1" });
    const b = buildM365MailInboundSessionKey({ ...BASE, conversationId: "thread-2" });
    expect(a).not.toBe(b);
  });

  it("isolates sessions per account for the same conversation id", () => {
    const a = buildM365MailInboundSessionKey({ ...BASE, accountId: "acct-a" });
    const b = buildM365MailInboundSessionKey({ ...BASE, accountId: "acct-b" });
    expect(a).not.toBe(b);
  });

  it("isolates sessions per agent for the same conversation id", () => {
    const a = buildM365MailInboundSessionKey({ ...BASE, agentId: "agent-1" });
    const b = buildM365MailInboundSessionKey({ ...BASE, agentId: "agent-2" });
    expect(a).not.toBe(b);
  });
});
