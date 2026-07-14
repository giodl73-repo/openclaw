import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionOrchestrationBudget,
  getSessionOrchestrationBudget,
} from "../../../config/sessions/orchestration-budgets.js";
import { upsertSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { ExplicitSkillInvocation } from "../../../skills/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { chargeOrchestrationBudgetUsage } from "./orchestration-budget-accounting.js";

describe("orchestration budget accounting", () => {
  const ownerSessionKey = "agent:main:subagent:budget-owner";
  const invocation: ExplicitSkillInvocation = {
    invocationId: "invocation-child",
    commandName: "child-skill",
    skillName: "child-skill",
    orchestrationBudget: { ownerSessionKey, rootRunId: "run-root" },
  };
  let tempDir = "";
  let storePath = "";
  let config: { session: { store: string } };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-orchestration-accounting-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    config = { session: { store: storePath } };
    await upsertSessionEntry(
      { sessionKey: ownerSessionKey, storePath },
      { sessionId: "owner-session", updatedAt: 1 },
    );
    await createSessionOrchestrationBudget({
      ownerSessionKey,
      storePath,
      rootRunId: "run-root",
      tokenLimit: 1_000,
      now: 10,
    });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("charges normalized completed-attempt usage to the shared owner", async () => {
    await chargeOrchestrationBudgetUsage({
      config,
      explicitSkillInvocation: invocation,
      usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 25 },
    });

    expect(getSessionOrchestrationBudget({ ownerSessionKey, storePath })?.tokensUsed).toBe(375);
  });

  it("uses the provider aggregate instead of recomputing it", async () => {
    await chargeOrchestrationBudgetUsage({
      config,
      explicitSkillInvocation: invocation,
      usage: { input: 100, output: 50, cacheRead: 200, total: 500 },
    });

    expect(getSessionOrchestrationBudget({ ownerSessionKey, storePath })?.tokensUsed).toBe(500);
  });

  it("does not charge ordinary runs or attempts without observed usage", async () => {
    await chargeOrchestrationBudgetUsage({ config, usage: { total: 100 } });
    await chargeOrchestrationBudgetUsage({
      config,
      explicitSkillInvocation: invocation,
      usage: undefined,
    });

    expect(getSessionOrchestrationBudget({ ownerSessionKey, storePath })?.tokensUsed).toBe(0);
  });
});
