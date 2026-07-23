import { describe, expect, it } from "vitest";
import { buildCatalogList } from "./list.js";
import { buildCommandPolicyEvidence } from "./policy-evidence.js";

describe("buildCommandPolicyEvidence", () => {
  it("projects normalized facts without claiming attestation", () => {
    const evidence = buildCommandPolicyEvidence(buildCatalogList({ runtimeCommands: [] }));

    expect(evidence.attestation).toBe(false);
    expect(evidence.scope).toEqual({
      runtimeCommands: "current-invocation-registered-tree",
      nodeCommands: "caller-supplied",
      collection: {
        descriptors: "complete",
        commandRoutes: "complete",
        runtimeCommands: "collected",
        pluginCommands: "not-requested",
        nodeCommands: "not-requested",
      },
      nodeIds: [],
    });
    expect(evidence.observations).toEqual([]);
    expect(evidence.records.length).toBeGreaterThan(0);
    expect(evidence.records.map((entry) => entry.id)).toEqual(
      evidence.records.map((entry) => entry.id).toSorted(),
    );
    expect(evidence.records.some((entry) => entry.kind === "operation")).toBe(true);
    expect(new Set(evidence.records.map((entry) => entry.id)).size).toBe(evidence.records.length);
  });
});
