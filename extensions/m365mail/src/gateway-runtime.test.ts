import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, registerPluginHttpRoute: vi.fn() };
});

import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import {
  collectM365MailGatewayRoutingWarnings,
  collectM365MailGatewayStartupIssues,
  registerM365MailWebhookRoute,
  validateM365MailGatewayAccountStartup,
} from "./gateway-runtime.js";
import type { ResolvedM365MailAccount } from "./types.js";

function makeAccount(overrides: Partial<ResolvedM365MailAccount> = {}): ResolvedM365MailAccount {
  return {
    accountId: "default",
    enabled: true,
    brokered: true,
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
    agentId: "agent-object-id",
    webhookPath: "/webhook/m365mail",
    dmPolicy: "open",
    allowedSenders: [],
    allowCrossTenant: false,
    rateLimitPerMinute: 30,
    botName: "OpenClaw",
    ...overrides,
  };
}

const EMPTY_CFG = {} as OpenClawConfig;

describe("collectM365MailGatewayStartupIssues", () => {
  it("reports a disabled account as an info-level issue and stops early", () => {
    const issues = collectM365MailGatewayStartupIssues({
      cfg: EMPTY_CFG,
      account: makeAccount({ enabled: false, dmPolicy: "allowlist", allowedSenders: [] }),
      accountId: "default",
    });

    // Disabled short-circuits: the empty-allowlist check must not also fire.
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("disabled");
    expect(issues[0].logLevel).toBe("info");
  });

  it("flags an allowlist policy with no senders as a warn-level refusal", () => {
    const issues = collectM365MailGatewayStartupIssues({
      cfg: EMPTY_CFG,
      account: makeAccount({ dmPolicy: "allowlist", allowedSenders: [] }),
      accountId: "default",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("empty-allowlist");
    expect(issues[0].logLevel).toBe("warn");
    expect(issues[0].message).toContain("refusing to start route");
  });

  it("returns no issues for an enabled open-policy account", () => {
    expect(
      collectM365MailGatewayStartupIssues({
        cfg: EMPTY_CFG,
        account: makeAccount({ dmPolicy: "open" }),
        accountId: "default",
      }),
    ).toEqual([]);
  });

  it("refuses startup when the trusted mailbox identity is missing", () => {
    const issues = collectM365MailGatewayStartupIssues({
      cfg: EMPTY_CFG,
      account: makeAccount({ agentId: "" }),
      accountId: "default",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("identity-missing");
    expect(issues[0].message).toContain("no trusted mailbox identity");
  });

  it("returns no issues for an allowlist account that has senders", () => {
    expect(
      collectM365MailGatewayStartupIssues({
        cfg: EMPTY_CFG,
        account: makeAccount({ dmPolicy: "allowlist", allowedSenders: ["ada@contoso.com"] }),
        accountId: "default",
      }),
    ).toEqual([]);
  });
});

describe("collectM365MailGatewayRoutingWarnings", () => {
  it("surfaces only the empty-allowlist issue as a formatted warning line", () => {
    const warnings = collectM365MailGatewayRoutingWarnings({
      cfg: EMPTY_CFG,
      account: makeAccount({ dmPolicy: "allowlist", allowedSenders: [] }),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^- Microsoft 365 Email: /);
    expect(warnings[0]).toContain("empty allowedSenders");
  });

  it("does not surface a disabled account as a routing warning", () => {
    expect(
      collectM365MailGatewayRoutingWarnings({
        cfg: EMPTY_CFG,
        account: makeAccount({ enabled: false }),
      }),
    ).toEqual([]);
  });

  it("returns no warnings for a healthy account", () => {
    expect(
      collectM365MailGatewayRoutingWarnings({
        cfg: EMPTY_CFG,
        account: makeAccount({ dmPolicy: "open" }),
      }),
    ).toEqual([]);
  });
});

describe("validateM365MailGatewayAccountStartup", () => {
  it("returns ok and logs nothing for a healthy account", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = validateM365MailGatewayAccountStartup({
      cfg: EMPTY_CFG,
      account: makeAccount({ dmPolicy: "open" }),
      accountId: "default",
      log,
    });

    expect(result).toEqual({ ok: true });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns not-ok and warns for an empty allowlist", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = validateM365MailGatewayAccountStartup({
      cfg: EMPTY_CFG,
      account: makeAccount({ dmPolicy: "allowlist", allowedSenders: [] }),
      accountId: "default",
      log,
    });

    expect(result).toEqual({ ok: false });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("empty allowedSenders");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("returns not-ok and logs a disabled account at info level, not warn", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = validateM365MailGatewayAccountStartup({
      cfg: EMPTY_CFG,
      account: makeAccount({ enabled: false }),
      accountId: "default",
      log,
    });

    expect(result).toEqual({ ok: false });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("registerM365MailWebhookRoute idempotency", () => {
  const mockedRegister = vi.mocked(registerPluginHttpRoute);

  beforeEach(() => {
    mockedRegister.mockReset();
  });

  it("deregisters the stale route before re-registering the same account/path", () => {
    const unregister1 = vi.fn();
    const unregister2 = vi.fn();
    mockedRegister.mockReturnValueOnce(unregister1).mockReturnValueOnce(unregister2);

    const account = makeAccount({ accountId: "acct-idem", webhookPath: "/webhook/m365mail/idem" });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    registerM365MailWebhookRoute({ account, accountId: account.accountId, log });
    expect(mockedRegister).toHaveBeenCalledTimes(1);
    expect(unregister1).not.toHaveBeenCalled();

    // Re-registering the same route key must tear down the stale route first.
    const dispose2 = registerM365MailWebhookRoute({
      account,
      accountId: account.accountId,
      log,
    });
    expect(mockedRegister).toHaveBeenCalledTimes(2);
    expect(unregister1).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls.some(([m]) => String(m).includes("Deregistering stale route"))).toBe(
      true,
    );

    // The returned disposer tears down the live route.
    dispose2();
    expect(unregister2).toHaveBeenCalledTimes(1);
  });

  it("registers the route on the account's webhook path with gateway auth", () => {
    mockedRegister.mockReturnValue(vi.fn());
    const account = makeAccount({ accountId: "acct-path", webhookPath: "/webhook/m365mail/path" });

    const dispose = registerM365MailWebhookRoute({ account, accountId: account.accountId });

    expect(mockedRegister).toHaveBeenCalledTimes(1);
    const arg = mockedRegister.mock.calls[0][0];
    expect(arg.path).toBe("/webhook/m365mail/path");
    expect(arg.auth).toBe("gateway");
    expect(arg.accountId).toBe("acct-path");

    dispose();
  });

  it("rejects a webhook path already owned by another account", () => {
    const unregister = vi.fn();
    mockedRegister.mockReturnValue(unregister);
    const webhookPath = "/webhook/m365mail/shared";

    const dispose = registerM365MailWebhookRoute({
      account: makeAccount({ accountId: "acct-a", webhookPath }),
      accountId: "acct-a",
    });

    expect(() =>
      registerM365MailWebhookRoute({
        account: makeAccount({ accountId: "acct-b", webhookPath }),
        accountId: "acct-b",
      }),
    ).toThrow(/already registered by account acct-a/);
    expect(mockedRegister).toHaveBeenCalledTimes(1);

    dispose();
  });
});
