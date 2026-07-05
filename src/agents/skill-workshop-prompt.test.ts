import { describe, expect, it } from "vitest";
import { buildSkillWorkshopPromptSection } from "./skill-workshop-prompt.js";

describe("buildSkillWorkshopPromptSection", () => {
  it("keeps proposal lifecycle in skill_workshop and live actions on existing surfaces", () => {
    const section = buildSkillWorkshopPromptSection().join("\n");

    expect(section).toContain(
      "Use `skill_workshop` when the user wants to create, update, revise, list, inspect, apply, reject, or quarantine a reusable skill, Skill Workshop proposal, playbook, workflow, procedure, or durable instruction.",
    );
    expect(section).toContain(
      "Pending skills stay proposals. Use `skill_workshop` for proposal lifecycle; live install/enable or approval actions must go through the existing command or tool surface for that action.",
    );
  });
});
