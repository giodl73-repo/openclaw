import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  chargeSessionOrchestrationBudget,
  createSessionOrchestrationBudget,
  getSessionOrchestrationBudget,
} from "./orchestration-budgets.js";
import { upsertSessionEntry } from "./session-accessor.js";

describe("session orchestration budgets", () => {
  const ownerSessionKey = "agent:main:subagent:budget-owner";
  let tempDir = "";
  let storePath = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-orchestration-budget-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedOwner() {
    await upsertSessionEntry(
      { sessionKey: ownerSessionKey, storePath },
      { sessionId: "owner-session", updatedAt: 1 },
    );
  }

  it("creates one durable owner on the root child session", async () => {
    await seedOwner();

    const budget = await createSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      rootRunId: "run-root",
      tokenLimit: 1_000,
      now: 10,
    });

    expect(budget).toEqual({
      schemaVersion: 1,
      rootRunId: "run-root",
      tokenLimit: 1_000,
      tokensUsed: 0,
      createdAt: 10,
      updatedAt: 10,
    });
    expect(getSessionOrchestrationBudget({ ownerSessionKey, storePath })).toEqual(budget);
    await expect(
      createSessionOrchestrationBudget({
        ownerSessionKey,
        storePath,
        rootRunId: "run-other",
        tokenLimit: 2_000,
      }),
    ).rejects.toThrow("orchestration budget already exists");
  });

  it("charges the shared counter and preserves its first exhaustion time", async () => {
    await seedOwner();
    await createSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      rootRunId: "run-root",
      tokenLimit: 100,
      now: 10,
    });

    const first = await chargeSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      tokens: 60,
      now: 20,
    });
    expect(first).toMatchObject({ chargedTokens: 60, exhausted: false });
    expect(first.budget.tokensUsed).toBe(60);

    const exhausted = await chargeSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      tokens: 50,
      now: 30,
    });
    expect(exhausted).toMatchObject({ chargedTokens: 50, exhausted: true });
    expect(exhausted.budget).toMatchObject({ tokensUsed: 110, exhaustedAt: 30 });

    const later = await chargeSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      tokens: 10,
      now: 40,
    });
    expect(later.budget).toMatchObject({ tokensUsed: 120, exhaustedAt: 30, updatedAt: 40 });
  });

  it("serializes concurrent charges through the session owner", async () => {
    await seedOwner();
    await createSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      rootRunId: "run-root",
      tokenLimit: 1_000,
      now: 10,
    });

    await Promise.all(
      [10, 20, 30, 40].map((tokens) =>
        chargeSessionOrchestrationBudget({ ownerSessionKey, storePath, tokens, now: 20 }),
      ),
    );

    expect(getSessionOrchestrationBudget({ ownerSessionKey, storePath })?.tokensUsed).toBe(100);
  });

  it("rejects invalid limits, charges, and missing owners", async () => {
    await seedOwner();
    await expect(
      createSessionOrchestrationBudget({
        ownerSessionKey,
        storePath,
        rootRunId: "run-root",
        tokenLimit: 0,
      }),
    ).rejects.toThrow("token limit must be a positive safe integer");
    await expect(
      chargeSessionOrchestrationBudget({ ownerSessionKey, storePath, tokens: 1 }),
    ).rejects.toThrow("orchestration budget not found");
  });
});
