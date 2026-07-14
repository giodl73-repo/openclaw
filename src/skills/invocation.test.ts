import { describe, expect, it } from "vitest";
import { createExplicitSkillInvocation } from "./invocation.js";

describe("createExplicitSkillInvocation", () => {
  it("creates the canonical identity recorded by either dispatch path", () => {
    const invocation = createExplicitSkillInvocation({
      commandName: "support",
      skillName: "customer-support",
      skillSource: "workspace",
    });

    expect(invocation).toMatchObject({
      invocationId: expect.stringMatching(/^skill_[A-Za-z0-9_-]{11}$/),
      commandName: "support",
      skillName: "customer-support",
      skillSource: "workspace",
    });
  });
});
