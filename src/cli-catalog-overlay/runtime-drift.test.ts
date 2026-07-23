import { describe, expect, it } from "vitest";
import type { CommandPolicyEvidence } from "./policy-evidence.js";
import { compareCommandRuntimeEvidence } from "./runtime-drift.js";

function evidence(
  records: CommandPolicyEvidence["records"],
  nodeCommands: CommandPolicyEvidence["scope"]["nodeCommands"] = "caller-supplied",
): CommandPolicyEvidence {
  return {
    schemaVersion: 1,
    evidenceKind: "openclaw-command-inventory",
    scope: {
      runtimeCommands: "current-invocation-registered-tree",
      nodeCommands,
      collection: {
        descriptors: "complete",
        commandRoutes: "complete",
        runtimeCommands: "collected",
        pluginCommands: "not-requested",
        nodeCommands: nodeCommands === "live-gateway-query" ? "caller-supplied" : "not-requested",
      },
      nodeIds: nodeCommands === "live-gateway-query" ? ["node-1"] : [],
    },
    observations: [],
    attestation: false,
    records,
  };
}

describe("compareCommandRuntimeEvidence", () => {
  it("separates added, removed, changed, and scope drift", () => {
    const before = evidence([
      { id: "plugin:a", kind: "plugin", sourceKind: "plugin", sourceId: "a", risk: "low" },
      { id: "node:old", kind: "node", sourceKind: "node-runtime", sourceId: "old" },
    ]);
    const after = evidence(
      [
        {
          id: "plugin:a",
          kind: "plugin",
          sourceKind: "plugin",
          sourceId: "a",
          risk: "high",
        },
        { id: "node:new", kind: "node", sourceKind: "node-runtime", sourceId: "new" },
      ],
      "live-gateway-query",
    );

    expect(compareCommandRuntimeEvidence(before, after)).toEqual({
      schemaVersion: 1,
      comparisonKind: "openclaw-command-inventory",
      scopeChanged: true,
      added: [after.records[1]],
      removed: [before.records[1]],
      changed: [{ before: before.records[0], after: after.records[0] }],
    });
  });

  it("does not report semantic drift for a new observation timestamp", () => {
    const before = {
      ...evidence([]),
      observations: [{ nodeId: "node-1", observedAt: "2026-07-22T00:00:00.000Z" }],
    };
    const after = {
      ...before,
      observations: [{ nodeId: "node-1", observedAt: "2026-07-23T00:00:00.000Z" }],
    };

    expect(compareCommandRuntimeEvidence(before, after)).toMatchObject({
      scopeChanged: false,
      added: [],
      removed: [],
      changed: [],
    });
  });
});
