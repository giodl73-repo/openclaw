import { describe, expect, it, vi } from "vitest";

const listNodePairing = vi.hoisted(() => vi.fn());

vi.mock("../infra/node-pairing.js", () => ({ listNodePairing }));

const { resolveNodeModeReadinessEvidence } = await import("./node-mode.js");

describe("resolveNodeModeReadinessEvidence", () => {
  it("keeps paired but disconnected nodes out of connected target evidence", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [],
    });

    expect(evidence).toMatchObject({
      pairing: { pairedCount: 1 },
      targets: { knownCount: 1, connectedCount: 0 },
      controlChannel: { connectedCount: 0 },
    });
  });

  it("uses live node sessions for target and control-channel evidence", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(evidence).toMatchObject({
      targets: { knownCount: 1, connectedCount: 1 },
      controlChannel: { connectedCount: 1 },
    });
  });

  it("does not treat denyCommands as command approval posture", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: { gateway: { nodes: { denyCommands: ["system.run"] } } },
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(evidence.commandApproval).toEqual({
      configured: false,
      approvedCommandCount: 0,
    });
  });

  it("correlates approved commands with the connected paired node", async () => {
    listNodePairing.mockResolvedValue({
      paired: [
        { nodeId: "node-1", commands: ["system.run"] },
        { nodeId: "node-2", commands: [] },
      ],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [{ nodeId: "node-2", commands: [] } as never],
    });

    expect(evidence.targets?.connectedCount).toBe(1);
    expect(evidence.commandApproval).toEqual({
      configured: false,
      approvedCommandCount: 0,
    });
  });
});
