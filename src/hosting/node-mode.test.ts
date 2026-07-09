import { describe, expect, it, vi } from "vitest";

const nodeModeMocks = vi.hoisted(() => ({
  listNodePairing: vi.fn(),
  loadNodeHostConfig: vi.fn(),
}));

vi.mock("../infra/node-pairing.js", () => ({
  listNodePairing: nodeModeMocks.listNodePairing,
}));

vi.mock("../node-host/config.js", () => ({
  loadNodeHostConfig: nodeModeMocks.loadNodeHostConfig,
}));

const { resolveNodeModeReadinessEvidence } = await import("./node-mode.js");

describe("resolveNodeModeReadinessEvidence", () => {
  it("maps existing node pairing and command config into node-mode evidence", async () => {
    nodeModeMocks.loadNodeHostConfig.mockResolvedValue({
      nodeId: "node-1",
      gateway: { host: "gateway.example", port: 11912 },
    });
    nodeModeMocks.listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run", "browser.open"] }],
      pending: [{ requestId: "pair-2", nodeId: "node-2" }],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: { gateway: { nodes: { denyCommands: ["dangerous.command"] } } },
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(evidence).toEqual({
      pairing: {
        pairedCount: 1,
        pendingCount: 1,
      },
      targets: {
        count: 1,
      },
      commandApproval: {
        configured: true,
        approvedCommandCount: 2,
      },
      controlChannel: {
        status: "ready",
        target: "gateway.example:11912",
      },
      state: {
        workspaceUsable: true,
      },
    });
  });

  it("keeps missing pairing readable as readiness evidence", async () => {
    nodeModeMocks.loadNodeHostConfig.mockResolvedValue(null);
    nodeModeMocks.listNodePairing.mockResolvedValue({
      paired: [],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      gateway: "not-checked",
      workspaceUsable: false,
    });

    expect(evidence).toMatchObject({
      pairing: {
        pairedCount: 0,
        pendingCount: 0,
      },
      targets: {
        count: 0,
      },
      commandApproval: {
        configured: false,
        approvedCommandCount: 0,
      },
      controlChannel: {
        status: "not-checked",
      },
      state: {
        workspaceUsable: false,
      },
    });
  });
});
