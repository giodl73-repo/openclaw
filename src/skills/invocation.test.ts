import { describe, expect, it } from "vitest";
import { createManagedSkillInvocation } from "./invocation.js";

describe("createManagedSkillInvocation", () => {
  it("creates a bounded identity with skill and parent lineage", () => {
    const invocation = createManagedSkillInvocation({
      skillName: "resolve-case",
      skillSource: "workspace",
      skillDigest: "sha256:abc",
      executionHints: { remembers: ["case.resolved"], usesSkills: ["verify-customer"] },
      parentRunId: "run-parent",
    });

    expect(invocation).toEqual({
      invocationId: expect.stringMatching(/^skill_[A-Za-z0-9_-]+$/),
      skillName: "resolve-case",
      skillSource: "workspace",
      skillDigest: "sha256:abc",
      executionHints: { remembers: ["case.resolved"], usesSkills: ["verify-customer"] },
      parentRunId: "run-parent",
    });
  });
});
