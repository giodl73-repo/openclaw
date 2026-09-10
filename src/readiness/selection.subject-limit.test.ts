import { describe, expect, it } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { buildRuntimeReadiness } from "./conditions.js";
import { createSelectedReadinessResolver } from "./selection.js";

function chainedCriterion(
  pluginId: string,
  criterionId: string,
): PluginReadinessCriterionRegistration {
  return {
    id: `plugin.${pluginId}.${criterionId}`,
    pluginId,
    source: `/plugins/${pluginId}/index.js`,
    criterion: {
      id: criterionId,
      description: "Reports readiness with a retained subject chain.",
      check: ({ subjects }) => {
        let parentRef: string | undefined;
        for (let index = 0; index < 64; index += 1) {
          parentRef = subjects.declare({
            kind: "node",
            key: `level-${index}`,
            ...(parentRef ? { parentRef } : {}),
          });
        }
        return {
          subjectRef: parentRef,
          status: "True",
          reason: "PluginReady",
          message: "Plugin is ready.",
        };
      },
    },
  };
}

describe("selected readiness aggregate subject limit", () => {
  it("degrades only overflowing advisory evidence and preserves required readiness", async () => {
    const advisory = chainedCriterion("advisory", "backend");
    const required = chainedCriterion("required", "backend");
    const contribution = await createSelectedReadinessResolver()({
      config: {
        gateway: {
          readiness: {
            advisoryCriteria: [advisory.id],
            requiredCriteria: [required.id],
          },
        },
      },
      registry: { readinessCriteria: [advisory, required] },
    });

    expect(contribution.conditions).toEqual([
      expect.objectContaining({
        type: advisory.id,
        status: "Unknown",
        requirement: "advisory",
        reason: "CriterionSubjectLimitExceeded",
      }),
      expect.objectContaining({
        type: required.id,
        status: "True",
        requirement: "required",
        reason: "PluginReady",
      }),
    ]);
    expect(
      contribution.subjects.some((subject) => subject.ref.startsWith("plugin.advisory/")),
    ).toBe(false);
    expect(
      contribution.subjects.some((subject) => subject.ref.startsWith("plugin.required/")),
    ).toBe(true);

    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: contribution.conditions,
      additionalSubjects: contribution.subjects,
    });
    expect(readiness).toMatchObject({
      ready: true,
      failures: [],
      advisories: ["CriterionSubjectLimitExceeded"],
    });
    expect(readiness.identity.subjects.length).toBeLessThanOrEqual(128);
  });
});
