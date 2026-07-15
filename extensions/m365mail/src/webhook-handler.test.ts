import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { M365MailInboundMessage } from "./inbound-context.js";
import { clearM365MailRuntime, setM365MailRuntime } from "./runtime.js";
import type { ResolvedM365MailAccount } from "./types.js";
import {
  clearM365MailWebhookRateLimiterStateForTest,
  createWebhookHandler,
} from "./webhook-handler.js";

// Inlined mock req/res so all test-only wiring stays in this `.test.ts` file
// (the extension tsconfig excludes `**/*.test.ts`, so nothing here reaches the
// image build; a non-`.test` helper module would be bundled).
function makeReq(
  method: string,
  body: string,
  opts: { headers?: Record<string, string> } = {},
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { destroyed: boolean };
  req.method = method;
  req.headers = opts.headers ?? {};
  req.url = "/webhook/m365mail";
  req.socket = { remoteAddress: "127.0.0.1" } as unknown as IncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = ((_?: Error) => {
    req.destroyed = true;
    return req;
  }) as IncomingMessage["destroy"];
  process.nextTick(() => {
    if (req.destroyed) {
      return;
    }
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): ServerResponse & { status: number; body: string } {
  const res = {
    status: 0,
    body: "",
    writeHead(statusCode: number, _headers?: Record<string, string>) {
      res.status = statusCode;
      return res;
    },
    end(body?: string) {
      res.body = body ?? "";
      return res;
    },
  } as unknown as ServerResponse & { status: number; body: string };
  Object.defineProperty(res, "statusCode", {
    configurable: true,
    enumerable: true,
    get() {
      return res.status;
    },
    set(value: number) {
      res.status = value;
    },
  });
  return res;
}

const OWNER_TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
type Deliver = (msg: M365MailInboundMessage) => Promise<null>;
type TestLoggerFn = (...args: unknown[]) => void;
type MockWithCalls<TArgs extends readonly unknown[]> = { mock: { calls: TArgs[] } };

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

let accountSeq = 0;
function makeAccount(overrides: Partial<ResolvedM365MailAccount> = {}): ResolvedM365MailAccount {
  accountSeq += 1;
  return {
    accountId: `acct-${accountSeq}`,
    enabled: true,
    brokered: true,
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
    agentId: "agent@owner.example",
    webhookPath: "/webhook/m365mail",
    dmPolicy: "open",
    allowedSenders: [],
    allowCrossTenant: false,
    rateLimitPerMinute: 30,
    botName: "TestAgent",
    ...overrides,
  };
}

/** A well-formed, same-tenant, authorized inbound email activity. */
function validActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    from: { id: "sender@owner.example", name: "Sender", tenantId: OWNER_TENANT },
    recipient: { id: "agent@owner.example", tenantId: OWNER_TENANT },
    conversation: { id: "conv-1", topic: "Weekly sync" },
    entities: [
      {
        type: "emailNotification",
        id: "graph-message-1",
        conversationId: "thread-1",
        htmlBody: "<p>Hello agent</p>",
      },
    ],
    ...overrides,
  };
}

function makeDeliver() {
  return vi.fn<Deliver>(async () => null);
}

function makeLog() {
  return {
    info: vi.fn<TestLoggerFn>(),
    warn: vi.fn<TestLoggerFn>(),
    error: vi.fn<TestLoggerFn>(),
  };
}

describe("createWebhookHandler", () => {
  beforeEach(() => {
    clearM365MailWebhookRateLimiterStateForTest();
  });

  afterEach(() => {
    clearM365MailRuntime();
  });

  it("rejects non-POST methods with 405 and never dispatches", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(makeReq("GET", ""), res);
    expect(res.status).toBe(405);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects an unparseable body with 400", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(makeReq("POST", "not-json{"), res);
    expect(res.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects an email notification without a stable Graph message id", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      entities: [{ type: "emailNotification", conversationId: "thread-1", htmlBody: "<p>hi</p>" }],
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects an activity without a resolvable conversationId with 400", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      conversation: { topic: "no id" },
      entities: [{ type: "emailNotification", id: "m1", htmlBody: "<p>hi</p>" }],
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  // Assumption (harryf): a tenant-less / cross-tenant sender must fail closed at
  // the webhook boundary before any dispatch, even under the default open DM
  // policy — an unauthenticated loopback caller must not be able to drive a reply.
  it("rejects a tenant-less sender with 403 when cross-tenant is not opted in", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      from: { id: "external@evil.example", name: "X" }, // no tenantId
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects a different-tenant sender with 403 when cross-tenant is not opted in", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      from: { id: "external@other.example", tenantId: OTHER_TENANT },
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("accepts a different-tenant sender when the account opts into cross-tenant", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({
      account: makeAccount({ allowCrossTenant: true }),
      deliver,
      log: makeLog(),
    });
    const res = makeRes();
    const activity = validActivity({
      from: { id: "external@other.example", tenantId: OTHER_TENANT },
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  // Assumption (harryf): when the owner tenant is absent the tenant gate defers
  // to the DM policy rather than silently accepting — a disabled policy must
  // still reject.
  it("defers to DM policy when the owner tenant is absent (disabled policy rejects)", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({
      account: makeAccount({ dmPolicy: "disabled" }),
      deliver,
      log: makeLog(),
    });
    const res = makeRes();
    const activity = validActivity({
      from: { id: "sender@owner.example" }, // no sender tenant
      recipient: { id: "agent@owner.example" }, // no owner tenant
      conversation: { id: "conv-1" },
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  // Assumption (harryf @ 1bcdcfed): the owner-tenant chain must include
  // `channelData.tenant.id`. For a payload that carries the owner tenant ONLY
  // there (recipient/conversation tenant absent) and a tenant-less sender, the
  // strict same-tenant compare must run and REJECT — it must NOT resolve
  // ownerTenant="" and fall through to the default open DM policy, which would
  // accept the tenant-less sender despite allowCrossTenant=false.
  it("rejects a tenant-less sender when the owner tenant is only on channelData.tenant.id", async () => {
    const deliver = makeDeliver();
    // Default account: dmPolicy="open", allowCrossTenant=false.
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      from: { id: "external@evil.example", name: "X" }, // no sender tenant
      recipient: { id: "agent@owner.example" }, // no owner tenant here
      conversation: { id: "conv-1" }, // nor here
      channelData: { tenant: { id: OWNER_TENANT } }, // owner tenant ONLY here
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  // Complement: a genuine same-tenant sender whose owner tenant is carried only
  // on channelData.tenant.id is still accepted (the chain resolves the owner
  // tenant and the compare passes).
  it("accepts a same-tenant sender when the owner tenant is only on channelData.tenant.id", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      from: { id: "sender@owner.example", tenantId: OWNER_TENANT },
      recipient: { id: "agent@owner.example" },
      conversation: { id: "conv-1" },
      channelData: { tenant: { id: OWNER_TENANT } },
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("acks 202 and dispatches the parsed email for an authorized same-tenant sender", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(makeReq("POST", JSON.stringify(validActivity())), res);
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [msg] = firstMockCall(deliver, "deliver");
    expect(msg.conversationId).toBe("thread-1");
    expect(msg.body).toBe("Hello agent");
    // Only the emailNotification entity id (a Graph message id) may be used for
    // threaded reply — not the Bot Framework activity id.
    expect(msg.messageId).toBe("graph-message-1");
    expect(msg.fromAddress).toBe("sender@owner.example");
    expect(msg.commandAuthorized).toBe(true);
    // Reply self-addressing id falls back to recipient.id (UPN) when the
    // activity carries no agenticUserId.
    expect(msg.agentId).toBe("agent@owner.example");
  });

  // Canonical AOS email-notification fixture (harryf re-review @ 47f6d33c):
  // mirrors the exact wire shape the runtime forwards verbatim — nested
  // `conversation.tenantId`, `channelData.tenant.id`, `channelId: "agents"`,
  // `serviceUrl`, and a full `entities[]` list (`productInfo` + `clientInfo` +
  // `emailNotification`). Proves a REAL same-tenant email — whose `from` carries
  // a platform-stamped `tenantId` — is accepted (202) and dispatched, i.e. the
  // fail-closed cross-tenant gate does NOT 403 legitimate same-tenant mail on
  // the canonical shape, and the notification-scope tenant fields are not
  // mistaken for the sender tenant.
  it("acks 202 and dispatches a canonical AOS email notification (real wire shape)", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    // Shape taken from a captured production e2e emailNotification callback.
    const canonical = {
      type: "message",
      id: "AAMkADbotframeworkactivityid=",
      channelId: "agents",
      serviceUrl: `https://smba.trafficmanager.net/amer/${OWNER_TENANT}/`,
      from: {
        id: "rygregg2@owner.example",
        name: "Ryan Gregg (test)",
        role: "user",
        tenantId: OWNER_TENANT,
      },
      recipient: {
        id: "agent@owner.example",
        name: "Managed Dev Agent",
        role: "agenticUser",
        tenantId: OWNER_TENANT,
      },
      conversation: {
        tenantId: OWNER_TENANT,
        id: "bot-framework-conversation-id",
        topic: "m365mail e2e",
      },
      textFormat: "plain",
      text: "Validation email for the m365mail OpenClaw provider.",
      entities: [
        { type: "productInfo", id: "email" },
        { type: "clientInfo", locale: "en-US" },
        {
          type: "emailNotification",
          id: "graph-message-canonical",
          conversationId: "graph-thread-canonical",
          htmlBody: "<body><div>Validation email for the m365mail OpenClaw provider.</div></body>",
        },
      ],
      channelData: { tenant: { id: OWNER_TENANT }, productContext: "email" },
    };
    await handler(makeReq("POST", JSON.stringify(canonical)), res);
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [msg] = firstMockCall(deliver, "deliver");
    // Threading + reply targeting must come from the emailNotification entity
    // (Graph ids), never the Bot Framework activity/conversation id.
    expect(msg.conversationId).toBe("graph-thread-canonical");
    expect(msg.messageId).toBe("graph-message-canonical");
    expect(msg.fromAddress).toBe("rygregg2@owner.example");
    expect(msg.commandAuthorized).toBe(true);
  });

  it("preserves the configured object-id form when the activity also carries a UPN", async () => {
    const deliver = makeDeliver();
    const agentId = "c0a46aa5-86ba-4b76-acd9-c968f17b7995";
    const handler = createWebhookHandler({
      account: makeAccount({ agentId }),
      deliver,
      log: makeLog(),
    });
    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            recipient: {
              id: "agent@owner.example",
              agenticUserId: agentId,
              role: "agenticUser",
              tenantId: OWNER_TENANT,
            },
          }),
        ),
      ),
      res,
    );
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [msg] = firstMockCall(deliver, "deliver");
    expect(msg.agentId).toBe(agentId);
  });

  it("preserves the configured UPN form when the activity also carries an object id", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            recipient: {
              id: "agent@owner.example",
              agenticUserId: "c0a46aa5-86ba-4b76-acd9-c968f17b7995",
              tenantId: OWNER_TENANT,
            },
          }),
        ),
      ),
      res,
    );
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [msg] = firstMockCall(deliver, "deliver");
    expect(msg.agentId).toBe("agent@owner.example");
  });

  it("matches an asserted recipient UPN case-insensitively", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            recipient: { id: "Agent@Owner.Example", tenantId: OWNER_TENANT },
          }),
        ),
      ),
      res,
    );
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("rejects an asserted recipient that does not match the configured agent", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            recipient: {
              id: "other-agent@owner.example",
              agenticUserId: "other-agent-object-id",
              tenantId: OWNER_TENANT,
            },
          }),
        ),
      ),
      res,
    );
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  // When neither identity field is present the mapping yields `undefined`
  // rather than an empty string, so the downstream reply path can detect the
  // missing target and fall back to the env-seeded account id instead of
  // self-addressing an empty mailbox.
  it("maps agentId to undefined when the recipient carries no id or agenticUserId", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            recipient: { tenantId: OWNER_TENANT },
            channelData: { tenant: { id: OWNER_TENANT } },
          }),
        ),
      ),
      res,
    );
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [msg] = firstMockCall(deliver, "deliver");
    expect(msg.agentId).toBeUndefined();
  });

  it("rejects with 403 when the DM policy is disabled", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({
      account: makeAccount({ dmPolicy: "disabled" }),
      deliver,
      log: makeLog(),
    });
    const res = makeRes();
    await handler(makeReq("POST", JSON.stringify(validActivity())), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects with 403 when dmPolicy=allowlist but the allowlist is empty", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({
      account: makeAccount({ dmPolicy: "allowlist", allowedSenders: [] }),
      deliver,
      log: makeLog(),
    });
    const res = makeRes();
    await handler(makeReq("POST", JSON.stringify(validActivity())), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects a sender absent from a populated allowlist with 403", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({
      account: makeAccount({
        dmPolicy: "allowlist",
        allowedSenders: ["someone-else@owner.example"],
      }),
      deliver,
      log: makeLog(),
    });
    const res = makeRes();
    await handler(makeReq("POST", JSON.stringify(validActivity())), res);
    expect(res.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("enforces the per-sender rate limit with 429 on the second request", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({
      account: makeAccount({ rateLimitPerMinute: 1 }),
      deliver,
      log: makeLog(),
    });
    const first = makeRes();
    await handler(makeReq("POST", JSON.stringify(validActivity())), first);
    expect(first.status).toBe(202);
    const second = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            entities: [
              {
                type: "emailNotification",
                id: "graph-message-2",
                conversationId: "thread-1",
                htmlBody: "<p>Hello from email</p>",
              },
            ],
          }),
        ),
      ),
      second,
    );
    expect(second.status).toBe(429);
    const retry = makeRes();
    await handler(
      makeReq(
        "POST",
        JSON.stringify(
          validActivity({
            entities: [
              {
                type: "emailNotification",
                id: "graph-message-2",
                conversationId: "thread-1",
                htmlBody: "<p>Hello from email</p>",
              },
            ],
          }),
        ),
      ),
      retry,
    );
    expect(retry.status).toBe(429);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a repeated Graph message id without delivering it twice", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const body = JSON.stringify(validActivity());
    const first = makeRes();
    await handler(makeReq("POST", body), first);
    const second = makeRes();
    await handler(makeReq("POST", body), second);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent deliveries of the same Graph message id", async () => {
    let resolveLookup: ((value: { deliveredAt: number } | undefined) => void) | undefined;
    const lookup = vi.fn(
      () =>
        new Promise<{ deliveredAt: number } | undefined>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    setM365MailRuntime({
      state: {
        openKeyedStore: () => ({
          register: vi.fn(async () => {}),
          lookup,
        }),
      },
      logging: {
        getChildLogger: () => ({ warn: vi.fn() }),
      },
    } as never);
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const body = JSON.stringify(validActivity());
    const first = makeRes();
    const second = makeRes();

    const firstRequest = handler(makeReq("POST", body), first);
    const secondRequest = handler(makeReq("POST", body), second);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    resolveLookup?.(undefined);
    await Promise.all([firstRequest, secondRequest]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("scopes repeated Graph message ids to each account", async () => {
    const firstDeliver = makeDeliver();
    const secondDeliver = makeDeliver();
    const firstHandler = createWebhookHandler({
      account: makeAccount(),
      deliver: firstDeliver,
      log: makeLog(),
    });
    const secondHandler = createWebhookHandler({
      account: makeAccount(),
      deliver: secondDeliver,
      log: makeLog(),
    });
    const body = JSON.stringify(validActivity());
    await firstHandler(makeReq("POST", body), makeRes());
    await secondHandler(makeReq("POST", body), makeRes());
    expect(firstDeliver).toHaveBeenCalledTimes(1);
    expect(secondDeliver).toHaveBeenCalledTimes(1);
  });

  it("restores duplicate suppression from persistent plugin state", async () => {
    const records = new Map<string, { deliveredAt: number }>();
    setM365MailRuntime({
      state: {
        openKeyedStore: () => ({
          register: async (key: string, value: { deliveredAt: number }) => {
            records.set(key, value);
          },
          lookup: async (key: string) => records.get(key),
        }),
      },
      logging: {
        getChildLogger: () => ({ warn: vi.fn() }),
      },
    } as never);
    const account = makeAccount();
    const firstDeliver = makeDeliver();
    const body = JSON.stringify(validActivity());
    await createWebhookHandler({ account, deliver: firstDeliver, log: makeLog() })(
      makeReq("POST", body),
      makeRes(),
    );
    expect(firstDeliver).toHaveBeenCalledTimes(1);

    clearM365MailWebhookRateLimiterStateForTest();

    const secondDeliver = makeDeliver();
    await createWebhookHandler({ account, deliver: secondDeliver, log: makeLog() })(
      makeReq("POST", body),
      makeRes(),
    );
    expect(secondDeliver).not.toHaveBeenCalled();
  });

  it("acks 202 without dispatching when the email body is empty", async () => {
    const deliver = makeDeliver();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log: makeLog() });
    const res = makeRes();
    const activity = validActivity({
      text: "",
      entities: [{ type: "emailNotification", id: "m1", conversationId: "thread-1", htmlBody: "" }],
    });
    await handler(makeReq("POST", JSON.stringify(activity)), res);
    expect(res.status).toBe(202);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("acks 202 and logs (does not throw) when dispatch fails", async () => {
    const deliver = makeDeliver();
    deliver.mockRejectedValue(new Error("boom"));
    const log = makeLog();
    const handler = createWebhookHandler({ account: makeAccount(), deliver, log });
    const res = makeRes();
    await handler(makeReq("POST", JSON.stringify(validActivity())), res);
    // The handler ACKs before dispatch, so the caller always sees 202 even when
    // the downstream agent turn fails.
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
