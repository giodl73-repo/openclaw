import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

describe("doctor Codex provider auth compatibility", () => {
  it("reports legacy Codex transport overrides when Codex OAuth is configured", async () => {
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/auth-profiles/codex-provider",
    );
    const cfg: OpenClawConfig = {
      auth: {
        profiles: {
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
          },
        },
      },
      models: {
        providers: {
          "openai-codex": {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };

    await expect(
      check?.detect({
        mode: "doctor",
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        },
        cfg,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles/codex-provider",
        severity: "warning",
        message: expect.stringContaining("legacy transport override"),
        ocPath: "models.providers.openai-codex",
      }),
    ]);
  });
});
