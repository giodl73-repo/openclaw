import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const authProfileStoreMock = vi.hoisted(() => ({
  store: { version: 1, profiles: {} } as AuthProfileStore,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: () => resolvePluginProvidersMock(),
}));

vi.mock("../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStore: () => authProfileStoreMock.store,
}));

describe("doctor OAuth profile id repair", () => {
  it("migrates legacy OAuth profile ids through the structured health check", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:user@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "token-a",
          refresh: "token-r",
          expires: Date.now() + 60_000,
          email: "user@example.com",
        },
      },
      lastGood: {
        anthropic: "anthropic:user@example.com",
      },
    };
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/auth-profiles/oauth-ids",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const cfg: OpenClawConfig = {
      auth: {
        profiles: {
          "anthropic:default": { provider: "anthropic", mode: "oauth" },
        },
        order: {
          anthropic: ["anthropic:default"],
        },
      },
    };

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles/oauth-ids",
        message: expect.stringContaining("legacy OAuth profile id anthropic:default"),
        ocPath: "auth.profiles.anthropic:default",
      }),
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime,
        cfg,
        doctor: {
          confirm: vi.fn(async () => true),
        },
      },
      findings ?? [],
    );

    expect(repaired).toMatchObject({
      changes: [
        "Auth: migrate anthropic:default \u2192 anthropic:user@example.com (OAuth profile id)",
      ],
      warnings: [],
    });
    expect(repaired?.config?.auth?.profiles?.["anthropic:default"]).toBeUndefined();
    expect(repaired?.config?.auth?.profiles?.["anthropic:user@example.com"]).toMatchObject({
      provider: "anthropic",
      mode: "oauth",
      email: "user@example.com",
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg: repaired?.config ?? cfg,
        },
        { findings },
      ),
    ).resolves.toEqual([]);
  });
});
