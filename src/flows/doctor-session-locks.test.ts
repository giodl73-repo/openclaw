import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const tempDirs: string[] = [];

async function createStaleSessionLock(): Promise<{ env: NodeJS.ProcessEnv; lockPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-locks-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const lockPath = path.join(sessionsDir, "stale.jsonl.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: 999_999_999,
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }),
    "utf-8",
  );
  return { env: { OPENCLAW_STATE_DIR: stateDir }, lockPath };
}

describe("doctor session lock repair", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("removes stale session locks through the structured health check", async () => {
    const { env, lockPath } = await createStaleSessionLock();
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/session-locks");
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
        checkId: "core/doctor/session-locks",
        message: expect.stringContaining("lock file is stale"),
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
    ).resolves.toEqual({
      changes: ["Removed 1 stale session lock file."],
      warnings: [],
    });

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
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
  });
});
