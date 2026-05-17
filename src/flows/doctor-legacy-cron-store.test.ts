import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const tempDirs: string[] = [];

async function createLegacyCronStore(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-cron-"));
  tempDirs.push(root);
  const storePath = path.join(root, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs: [
          {
            jobId: "legacy-job",
            name: "Legacy job",
            notify: true,
            createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
            updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
            schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
            payload: {
              kind: "systemEvent",
              text: "Morning brief",
            },
            state: {},
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
  return storePath;
}

describe("doctor legacy cron store repair", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("normalizes legacy cron store entries through the structured health check", async () => {
    const storePath = await createLegacyCronStore();
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/legacy-cron-store");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const cfg = {
      cron: {
        store: storePath,
        webhook: "https://example.invalid/cron-finished",
      },
    };

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/legacy-cron-store",
        message: expect.stringContaining("Legacy cron job storage detected"),
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
      changes: [expect.stringContaining("Cron store normalized")],
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

    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const [job] = persisted.jobs;
    expect(job?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    expect(job?.notify).toBeUndefined();
    expect(job?.schedule).toMatchObject({ kind: "cron", expr: "0 7 * * *", tz: "UTC" });
    expect(job?.delivery).toMatchObject({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });
});
