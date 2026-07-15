import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAccountIds, resolveAccount } from "./accounts.js";

// Every env var resolveAccount reads. Snapshot + clear before each test so a
// stray value from the host (or a prior test) can't leak into resolution, then
// restore afterward.
const ENV_KEYS = [
  "M365MAIL_AUTH",
  "M365MAIL_ALLOW_CROSS_TENANT",
  "M365MAIL_GRAPH_BASE_URL",
  "M365MAIL_WEBHOOK_PATH",
  "M365MAIL_ALLOWED_SENDERS",
  "M365MAIL_RATE_LIMIT",
  "OPENCLAW_BOT_NAME",
  "OPENCLAW_M365MAIL_AGENT_ID",
] as const;

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

/** A minimal config with the m365mail channel enabled and optional overrides. */
function cfg(m365mail: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { m365mail: { enabled: true, ...m365mail } } } as unknown as OpenClawConfig;
}

describe("resolveAccount graphBaseUrl sanitization", () => {
  // The resolved graphBaseUrl is concatenated straight into the outbound Graph
  // fetch URL (graph.ts), so an attacker-influenced value could redirect the
  // agent's reply — and any bearer the runtime injects — to a hostile host.
  // These are the highest-risk assumption paths: unsafe values must be rejected
  // and fall back to the trusted default, never trusted verbatim.
  it("rejects a non-https (http) Graph base URL and falls back to the default", () => {
    const account = resolveAccount(cfg({ graphBaseUrl: "http://graph.microsoft.com/v1.0" }));
    expect(account.graphBaseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
  });

  it("rejects an attacker-controlled host and falls back to the default", () => {
    const account = resolveAccount(cfg({ graphBaseUrl: "https://evil.example.com/v1.0" }));
    expect(account.graphBaseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
  });

  it("rejects a look-alike Graph host and falls back to the default", () => {
    const account = resolveAccount(
      cfg({ graphBaseUrl: "https://graph.microsoft.com.evil.io/v1.0" }),
    );
    expect(account.graphBaseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
  });

  it("rejects an unparseable Graph base URL and falls back to the default", () => {
    const account = resolveAccount(cfg({ graphBaseUrl: "not a url" }));
    expect(account.graphBaseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
  });

  it("rejects a non-v1.0 Graph path and falls back to the default", () => {
    const account = resolveAccount(cfg({ graphBaseUrl: "https://graph.microsoft.com/beta" }));
    expect(account.graphBaseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
  });

  it("rejects Graph base URLs with query parameters or a non-default port", () => {
    expect(
      resolveAccount(cfg({ graphBaseUrl: "https://graph.microsoft.com/v1.0?scope=mail" }))
        .graphBaseUrl,
    ).toBe(DEFAULT_GRAPH_BASE_URL);
    expect(
      resolveAccount(cfg({ graphBaseUrl: "https://graph.microsoft.com:8443/v1.0" })).graphBaseUrl,
    ).toBe(DEFAULT_GRAPH_BASE_URL);
  });

  it("accepts a known national-cloud Graph host", () => {
    const account = resolveAccount(cfg({ graphBaseUrl: "https://graph.microsoft.us/v1.0" }));
    expect(account.graphBaseUrl).toBe("https://graph.microsoft.us/v1.0");
  });

  it("accepts the allowlisted host case-insensitively and strips a trailing slash", () => {
    const account = resolveAccount(cfg({ graphBaseUrl: "https://GRAPH.microsoft.com/v1.0/" }));
    expect(account.graphBaseUrl).toBe("https://GRAPH.microsoft.com/v1.0");
  });

  it("prefers a valid production config graphBaseUrl over the env fallback", () => {
    process.env.M365MAIL_GRAPH_BASE_URL = "https://graph.microsoft.us/v1.0";
    const account = resolveAccount(cfg({ graphBaseUrl: "https://dod-graph.microsoft.us/v1.0" }));
    expect(account.graphBaseUrl).toBe("https://dod-graph.microsoft.us/v1.0");
  });

  it("falls back to a valid env graphBaseUrl when the config value is unsafe", () => {
    process.env.M365MAIL_GRAPH_BASE_URL = "https://graph.microsoft.us/v1.0";
    const account = resolveAccount(cfg({ graphBaseUrl: "http://evil.example.com" }));
    expect(account.graphBaseUrl).toBe("https://graph.microsoft.us/v1.0");
  });

  it("rejects an unsafe env graphBaseUrl and falls back to the default", () => {
    process.env.M365MAIL_GRAPH_BASE_URL = "https://evil.example.com";
    const account = resolveAccount(cfg());
    expect(account.graphBaseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
  });
});

describe("resolveAccount agent mailbox id resolution", () => {
  it("seeds agentId from the OPENCLAW_M365MAIL_AGENT_ID env the adapter projects", () => {
    process.env.OPENCLAW_M365MAIL_AGENT_ID = "  agent-object-id  ";
    expect(resolveAccount(cfg()).agentId).toBe("agent-object-id");
  });

  it("leaves agentId empty until provisioning projects the env (no silent /me fallback)", () => {
    expect(resolveAccount(cfg()).agentId).toBe("");
  });
});

describe("resolveAccount defaults and config resolution", () => {
  it("applies safe defaults for an enabled-only channel", () => {
    const account = resolveAccount(cfg());
    expect(account).toMatchObject({
      enabled: true,
      brokered: true,
      graphBaseUrl: DEFAULT_GRAPH_BASE_URL,
      webhookPath: "/webhook/m365mail",
      dmPolicy: "open",
      allowedSenders: [],
      allowCrossTenant: false,
      rateLimitPerMinute: 30,
      botName: "OpenClaw",
    });
  });

  it("normalizes webhook paths to the registry leading-slash form", () => {
    expect(resolveAccount(cfg({ webhookPath: " webhook/m365mail-work " })).webhookPath).toBe(
      "/webhook/m365mail-work",
    );
  });

  it("normalizes allowedSenders to trimmed, lower-cased entries", () => {
    const account = resolveAccount(cfg({ allowedSenders: [" User@Contoso.com ", "OTHER@x.com"] }));
    expect(account.allowedSenders).toEqual(["user@contoso.com", "other@x.com"]);
  });

  it("parses a comma-separated allowedSenders env fallback", () => {
    process.env.M365MAIL_ALLOWED_SENDERS = "a@x.com, B@Y.com ,,";
    expect(resolveAccount(cfg()).allowedSenders).toEqual(["a@x.com", "b@y.com"]);
  });

  it("remains brokered when the legacy auth environment value is truthy", () => {
    process.env.M365MAIL_AUTH = "true";
    expect(resolveAccount(cfg()).brokered).toBe(true);
  });

  it("honors an explicit allowCrossTenant:true", () => {
    expect(resolveAccount(cfg({ allowCrossTenant: true })).allowCrossTenant).toBe(true);
  });

  it("keeps root policy on the implicit default when only named accounts are configured", () => {
    expect(
      resolveAccount(
        cfg({
          allowCrossTenant: true,
          accounts: { work: { allowCrossTenant: false } },
        }),
      ).allowCrossTenant,
    ).toBe(true);
  });

  it("does not start a phantom default account when named accounts are configured", () => {
    expect(
      listAccountIds(
        cfg({
          accounts: {
            work: { webhookPath: "/webhook/m365mail-work" },
          },
        }),
      ),
    ).toEqual(["work"]);
  });

  it("falls back to the default rate limit for a non-numeric env value", () => {
    process.env.M365MAIL_RATE_LIMIT = "not-a-number";
    expect(resolveAccount(cfg()).rateLimitPerMinute).toBe(30);
  });

  it("falls back for non-positive or fractional rate limits", () => {
    process.env.M365MAIL_RATE_LIMIT = "0";
    expect(resolveAccount(cfg()).rateLimitPerMinute).toBe(30);
    process.env.M365MAIL_RATE_LIMIT = "-1";
    expect(resolveAccount(cfg()).rateLimitPerMinute).toBe(30);
    expect(resolveAccount(cfg({ rateLimitPerMinute: 0 })).rateLimitPerMinute).toBe(30);
    expect(resolveAccount(cfg({ rateLimitPerMinute: 1.5 })).rateLimitPerMinute).toBe(30);
  });
});
