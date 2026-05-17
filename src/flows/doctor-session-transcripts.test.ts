import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const tempDirs: string[] = [];

async function createBrokenTranscript(): Promise<{ env: NodeJS.ProcessEnv; filePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-transcripts-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
    {
      type: "message",
      id: "parent",
      parentId: null,
      message: { role: "assistant", content: "previous" },
    },
    {
      type: "message",
      id: "runtime-user",
      parentId: "parent",
      message: {
        role: "user",
        content:
          "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    },
    {
      type: "message",
      id: "runtime-assistant",
      parentId: "runtime-user",
      message: { role: "assistant", content: "stale" },
    },
    {
      type: "message",
      id: "plain-user",
      parentId: "parent",
      message: { role: "user", content: "visible ask" },
    },
    {
      type: "message",
      id: "plain-assistant",
      parentId: "plain-user",
      message: { role: "assistant", content: "answer" },
    },
  ];
  await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { env: { OPENCLAW_STATE_DIR: stateDir }, filePath };
}

describe("doctor session transcript repair check", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("repairs broken prompt-rewrite branches through the structured health check", async () => {
    const { env, filePath } = await createBrokenTranscript();
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/session-transcripts",
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
        checkId: "core/doctor/session-transcripts",
        message: expect.stringContaining("duplicated prompt-rewrite branches"),
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
      changes: ["Repaired 1 transcript file."],
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

    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(
      lines
        .map((line) => JSON.parse(line) as { id?: string; type?: string })
        .filter((entry) => entry.type !== "session")
        .map((entry) => entry.id),
    ).toEqual(["parent", "plain-user", "plain-assistant"]);
  });
});
