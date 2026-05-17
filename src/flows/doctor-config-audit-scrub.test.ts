import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const tempDirs: string[] = [];

async function createAuditLog(content: string): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-audit-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const logDir = path.join(stateDir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, "config-audit.jsonl"), content, "utf-8");
  return { OPENCLAW_STATE_DIR: stateDir };
}

describe("doctor config audit scrub", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("repairs stale audit argv entries through the structured health check", async () => {
    const env = await createAuditLog(
      `${JSON.stringify({
        argv: ["openclaw", "gateway", "--token", "secret-token"],
        execArgv: ["--api-key=secret-key"],
      })}\n`,
    );
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/config-audit-scrub");
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
        checkId: "core/doctor/config-audit-scrub",
        message: expect.stringContaining("1 entry"),
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
      status: "repaired",
      changes: [expect.stringContaining("Scrubbed 1 entry")],
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

    const rewritten = await fs.readFile(
      path.join(env.OPENCLAW_STATE_DIR ?? "", "logs", "config-audit.jsonl"),
      "utf-8",
    );
    expect(rewritten).toContain('"--token","***"');
    expect(rewritten).toContain('"--api-key=***"');
    expect(rewritten).not.toContain("secret-token");
    expect(rewritten).not.toContain("secret-key");
  });
});
