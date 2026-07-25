import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSnapshot } from "../skills/types.js";

const hoisted = vi.hoisted(() => ({
  spawnSubagentDirect: vi.fn(),
}));

vi.mock("./subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirect(...args),
}));

import { spawnManagedSkillDirect } from "./managed-skill-spawn.js";

function createSkillsSnapshot(): SkillSnapshot {
  return {
    prompt: "",
    skills: [
      {
        name: "resolve-case",
        skillDigest: "sha256:abc",
        executionHints: { remembers: ["case.resolved"] },
      },
    ],
    resolvedSkills: [
      {
        name: "resolve-case",
        description: "Resolve a support case.",
        filePath: "/skills/resolve-case/SKILL.md",
        baseDir: "/skills/resolve-case",
        contentDigest: "sha256:abc",
        source: "workspace",
        sourceInfo: {} as never,
        disableModelInvocation: false,
      },
    ],
  };
}

describe("spawnManagedSkillDirect", () => {
  beforeEach(() => {
    hoisted.spawnSubagentDirect.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:child",
      runId: "run-child",
    });
  });

  it("resolves trusted skill identity before native subagent dispatch", async () => {
    const result = await spawnManagedSkillDirect(
      {
        skillName: "resolve-case",
        task: "Resolve case CAS-1042",
        model: "anthropic/sonnet-4.6",
      },
      {
        agentSessionKey: "agent:main:main",
        parentRunId: "run-parent",
        skillsSnapshot: createSkillsSnapshot(),
      },
    );

    expect(result).toMatchObject({ status: "accepted", runId: "run-child" });
    expect(hoisted.spawnSubagentDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Use the resolve-case skill to complete this task:\n\nResolve case CAS-1042",
        model: "anthropic/sonnet-4.6",
        managedSkill: {
          invocationId: expect.stringMatching(/^skill_/),
          skillName: "resolve-case",
          skillSource: "workspace",
          skillDigest: "sha256:abc",
          executionHints: { remembers: ["case.resolved"] },
          parentRunId: "run-parent",
        },
      }),
      { agentSessionKey: "agent:main:main" },
    );
  });

  it("rejects skills outside the trusted parent snapshot", async () => {
    const result = await spawnManagedSkillDirect(
      { skillName: "issue-refund", task: "Refund invoice INV-1042" },
      {
        agentSessionKey: "agent:main:main",
        skillsSnapshot: createSkillsSnapshot(),
      },
    );

    expect(result).toEqual({
      status: "error",
      error: 'Skill "issue-refund" is not available in this run.',
    });
    expect(hoisted.spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects cross-agent managed dispatch before native spawn", async () => {
    const result = await spawnManagedSkillDirect(
      {
        skillName: "resolve-case",
        task: "Resolve case CAS-1042",
        agentId: "reviewer",
      },
      {
        agentSessionKey: "agent:main:main",
        skillsSnapshot: createSkillsSnapshot(),
      },
    );

    expect(result).toEqual({
      status: "error",
      error: "Managed skill invocation currently requires the child to use the current agent.",
    });
    expect(hoisted.spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects non-background managed execution before native spawn", async () => {
    const result = await spawnManagedSkillDirect(
      {
        skillName: "resolve-case",
        task: "Resolve case CAS-1042",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        skillsSnapshot: createSkillsSnapshot(),
      },
    );

    expect(result).toEqual({
      status: "error",
      error:
        'Managed skill invocation is one background run; omit visible and thread, and use mode="run".',
    });
    expect(hoisted.spawnSubagentDirect).not.toHaveBeenCalled();
  });
});
