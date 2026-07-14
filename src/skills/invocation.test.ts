import { describe, expect, it } from "vitest";
import { createExplicitSkillInvocation } from "./invocation.js";

describe("createExplicitSkillInvocation", () => {
  it("creates the canonical identity recorded by either dispatch path", () => {
    const invocation = createExplicitSkillInvocation({
      commandName: "support",
      skillName: "customer-support",
      skillSource: "workspace",
      skillDigest: `sha256:${"a".repeat(64)}`,
      executionHints: { outcomes: ["case.resolved"], usesSkills: ["verify-customer"] },
    });

    expect(invocation).toMatchObject({
      invocationId: expect.stringMatching(/^skill_[A-Za-z0-9_-]{11}$/),
      commandName: "support",
      skillName: "customer-support",
      skillSource: "workspace",
      skillDigest: `sha256:${"a".repeat(64)}`,
      executionHints: { outcomes: ["case.resolved"], usesSkills: ["verify-customer"] },
    });
  });

  it("preserves child invocation lineage", () => {
    const invocation = createExplicitSkillInvocation({
      commandName: "invoice-paid",
      skillName: "invoice-paid",
      parentInvocationId: "skill_parent",
      parentRunId: "run_parent",
    });

    expect(invocation).toMatchObject({
      parentInvocationId: "skill_parent",
      parentRunId: "run_parent",
    });
  });

  it("omits incomplete child invocation lineage", () => {
    const invocation = createExplicitSkillInvocation({
      commandName: "invoice-paid",
      skillName: "invoice-paid",
      parentInvocationId: "skill_parent",
    });

    expect(invocation).not.toHaveProperty("parentInvocationId");
    expect(invocation).not.toHaveProperty("parentRunId");
  });
});
