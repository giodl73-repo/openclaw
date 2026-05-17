import { describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

describe("doctor sandbox scope health", () => {
  it("reports ignored per-agent sandbox overrides when scope resolves to shared", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox-scope");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(
      check?.detect({
        mode: "lint",
        runtime,
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                scope: "shared",
              },
            },
            list: [
              {
                id: "researcher",
                sandbox: {
                  docker: {
                    image: "custom-sandbox:latest",
                  },
                  browser: {
                    enabled: true,
                  },
                },
              },
            ],
          },
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/sandbox-scope",
        message:
          'agents.list (id "researcher") sandbox docker/browser overrides ignored; scope resolves to "shared".',
        path: "agents.list[0].sandbox",
      }),
    ]);
  });
});
