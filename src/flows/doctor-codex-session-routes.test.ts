import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const tempDirs: string[] = [];

async function createSessionStore(): Promise<{ env: NodeJS.ProcessEnv; storePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-routes-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        stale: {
          sessionId: "stale",
          updatedAt: 1,
          modelProvider: "openai-codex",
          model: "gpt-5.5",
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.4",
          agentHarnessId: "codex",
          agentRuntimeOverride: "codex",
          authProfileOverride: "openai-codex:default",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { env: { OPENCLAW_STATE_DIR: stateDir }, storePath };
}

describe("doctor Codex session route repair", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("repairs legacy Codex session routes through the structured health check", async () => {
    const { env, storePath } = await createSessionStore();
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/codex-session-routes",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg: {},
      env,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/codex-session-routes",
        message: expect.stringContaining("Legacy `openai-codex/*` session route state"),
      }),
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg: {},
          env,
        },
        findings ?? [],
      ),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Repaired Codex session routes")],
      warnings: [],
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg: {},
          env,
        },
        { findings },
      ),
    ).resolves.toEqual([]);

    const repaired = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      stale: Record<string, unknown>;
    };
    expect(repaired.stale.modelProvider).toBe("openai");
    expect(repaired.stale.model).toBe("gpt-5.5");
    expect(repaired.stale.providerOverride).toBe("openai");
    expect(repaired.stale.modelOverride).toBe("gpt-5.4");
    expect(repaired.stale.authProfileOverride).toBe("openai-codex:default");
    expect(repaired.stale.agentHarnessId).toBeUndefined();
    expect(repaired.stale.agentRuntimeOverride).toBeUndefined();
  });
});
