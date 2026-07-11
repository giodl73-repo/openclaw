import { describe, expect, it } from "vitest";
import { buildLiveNodeCommandObservation } from "./live-node-commands.js";

describe("live node command observations", () => {
  it("normalizes a connected node command inventory conservatively", () => {
    const observation = buildLiveNodeCommandObservation(
      {
        ts: 42,
        nodeId: "node-1",
        displayName: "Desk",
        connected: true,
        commands: ["system.run", "camera.snap", "system.run", 42],
      },
      "node-1",
    );

    expect(observation).toMatchObject({ nodeId: "node-1", nodeName: "Desk", observedAtMs: 42 });
    expect(observation.commands.map((entry) => entry.command)).toEqual([
      "camera.snap",
      "system.run",
    ]);
    expect(observation.commands[0]).toMatchObject({
      sourceKind: "node-runtime",
      discoveryMode: "runtime-node-query",
      risk: "high",
      confirmationRequired: true,
      effectMode: "mixed",
      observedAtMs: 42,
      metadataCompleteness: "identifier-only",
    });
  });

  it("fails explicitly for disconnected and mismatched nodes", () => {
    expect(() =>
      buildLiveNodeCommandObservation({ nodeId: "node-1", connected: false }, "node-1"),
    ).toThrow("not connected");
    expect(() =>
      buildLiveNodeCommandObservation({ nodeId: "node-2", connected: true }, "node-1"),
    ).toThrow("unexpected node");
  });
});
