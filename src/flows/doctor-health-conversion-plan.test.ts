import { describe, expect, it } from "vitest";
import { doctorHealthConversionRules } from "./doctor-health-conversion-plan.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.js";

describe("doctor health conversion plan", () => {
  it("classifies every current run contribution", () => {
    const contributionIds = resolveDoctorHealthContributions().map((contribution) => contribution.id);
    const plannedIds = doctorHealthConversionRules.map((rule) => rule.contributionId);

    expect(plannedIds).toEqual(contributionIds);
  });

  it("keeps conversion targets explicit", () => {
    for (const rule of doctorHealthConversionRules) {
      expect(rule.target.length).toBeGreaterThan(0);
      expect(rule.rule.trim()).not.toBe("");
    }
  });
});

