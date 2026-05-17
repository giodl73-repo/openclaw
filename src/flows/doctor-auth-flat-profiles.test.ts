import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const states: OpenClawTestState[] = [];

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-health-flat-auth-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
    },
  });
  states.push(state);
  return state;
}

describe("doctor flat auth profile repair", () => {
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    for (const state of states.splice(0)) {
      await state.cleanup();
    }
  });

  it("rewrites legacy flat auth profile stores through the structured health check", async () => {
    const state = await makeTestState();
    const legacy = {
      "ollama-windows": {
        apiKey: "ollama-local",
      },
    };
    const authPath = await state.writeAuthProfiles(legacy);
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/auth-profiles/flat-store",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const cfg = {};

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles/flat-store",
        message: expect.stringContaining("uses the legacy flat auth profile format"),
        path: authPath,
      }),
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg,
          doctor: {
            confirm: vi.fn(async () => true),
          },
        },
        findings ?? [],
      ),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("canonical auth profile format")],
      warnings: [],
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg,
        },
        { findings },
      ),
    ).resolves.toEqual([]);

    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
      version: 1,
      profiles: {
        "ollama-windows:default": {
          type: "api_key",
          provider: "ollama-windows",
          key: "ollama-local",
        },
      },
    });
  });
});
