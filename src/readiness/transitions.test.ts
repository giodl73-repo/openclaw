import { describe, expect, it } from "vitest";
import type { CanonicalReadinessResult } from "./conditions.js";
import { diffReadinessResults } from "./transitions.js";

function result(): CanonicalReadinessResult {
  return {
    contractVersion: 1,
    evaluatedAtMs: 1_000,
    identity: {
      producerRef: "openclaw/gateway/current",
      subjects: [{ ref: "openclaw/gateway/current", kind: "openclaw.gateway", id: "gateway-1" }],
    },
    ready: true,
    conditions: [
      {
        type: "GatewayResponding",
        subjectRef: "openclaw/gateway/current",
        observedAtMs: 1_000,
        status: "True",
        requirement: "required",
        reason: "GatewayResponding",
        message: "Gateway is responding.",
      },
    ],
    failures: [],
    advisories: [],
  };
}

describe("diffReadinessResults", () => {
  it("ignores evaluation and observation timestamp churn", () => {
    const before = result();
    const after = {
      ...result(),
      evaluatedAtMs: 2_000,
      conditions: [{ ...result().conditions[0], observedAtMs: 2_000 }],
    };
    expect(diffReadinessResults(before, after)).toEqual([]);
  });

  it("reports readiness and condition changes", () => {
    const before = result();
    const after = {
      ...result(),
      ready: false,
      conditions: [
        {
          ...result().conditions[0],
          status: "False" as const,
          reason: "GatewayUnavailable",
          message: "Gateway is unavailable.",
        },
      ],
      failures: ["GatewayUnavailable"],
    };
    expect(diffReadinessResults(before, after).map((change) => change.kind)).toEqual([
      "ready",
      "condition",
    ]);
  });

  it("reports subject replacement at a new lifetime", () => {
    const before = result();
    const after = result();
    after.identity.subjects[0] = {
      ...after.identity.subjects[0],
      id: "gateway-2",
      generation: "2",
    };
    expect(diffReadinessResults(before, after)).toEqual([
      expect.objectContaining({
        kind: "subject",
        change: "replaced",
        ref: "openclaw/gateway/current",
      }),
    ]);
  });

  it("reports a change in the result producer", () => {
    const before = result();
    const after = result();
    after.identity.producerRef = "openclaw/process/current";
    expect(diffReadinessResults(before, after)).toEqual([
      {
        kind: "producer",
        before: "openclaw/gateway/current",
        after: "openclaw/process/current",
      },
    ]);
  });

  it("reports added and removed keyed conditions", () => {
    const before = result();
    const after = result();
    after.conditions = [
      {
        type: "WorkspaceWritable",
        subjectRef: "openclaw/workspace/default",
        status: "True",
        requirement: "required",
        reason: "WorkspaceWritable",
        message: "Workspace is writable.",
      },
    ];
    expect(diffReadinessResults(before, after)).toEqual([
      expect.objectContaining({ kind: "condition", change: "removed" }),
      expect.objectContaining({ kind: "condition", change: "added" }),
    ]);
  });
});
