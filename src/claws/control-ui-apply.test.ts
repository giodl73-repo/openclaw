import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawControlUiHost } from "./control-ui-worker-contract.js";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  addPlan: vi.fn(),
  addPreview: vi.fn(),
  updatePlan: vi.fn(),
  removePlan: vi.fn(),
  source: vi.fn(),
  inventory: vi.fn(),
}));
vi.mock("./add.js", () => ({ applyClawAddPlan: mocks.add }));
vi.mock("./update-apply.js", () => ({ applyClawUpdatePlan: mocks.update }));
vi.mock("./lifecycle-state.js", () => ({
  applyClawRemovePlan: mocks.remove,
  buildClawRemovePlan: mocks.removePlan,
}));
vi.mock("./control-ui-plan.js", () => ({
  buildClawControlUiAddPlan: mocks.addPlan,
  projectClawAddPlan: mocks.addPreview,
}));
vi.mock("./control-ui-update-plan.js", () => ({
  withClawControlUiUpdatePlan: mocks.updatePlan,
}));
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.source }));
vi.mock("./inventory-read.js", () => ({ readClawInventory: mocks.inventory }));
vi.mock("./packages.js", () => ({ preflightClawPackage: vi.fn() }));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withArtifactPreservingStateReads: <T>(operation: () => T): T => operation(),
}));

import { executeClawControlUiOperation } from "./control-ui-apply.js";

const agentId = "fixture-agent";
const source = { packageName: "fixture-claw", version: "1.1.0" };
const config = {};
const loaded = { manifest: { schemaVersion: 1, agent: { id: agentId } }, source: {} };
const preview = {
  planIntegrity: "reviewed",
  actions: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};
const updateCommand = {
  operation: "update" as const,
  params: { target: agentId, source, planIntegrity: preview.planIntegrity },
};

function readinessHost() {
  const ready = vi.fn(async () => {
    throw new Error("Fixture Gateway readiness failed.");
  });
  const host = vi.fn<ClawControlUiHost>(async ({ method, params }) => {
    if (method === "config") {
      return config;
    }
    if (method === "agent.ready") {
      expect(params).toEqual({ agentId });
      return await ready();
    }
    throw new Error(`Unexpected fixture host request: ${method}`);
  });
  return { host, ready };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.updatePlan.mockImplementation(
    async (_params, run: (prepared: unknown) => Promise<unknown>) =>
      await run({
        plan: { planIntegrity: "canonical-update" },
        preview,
        persistSource: async () => loaded,
        config,
      }),
  );
});

// Mocked canonical-boundary contract proof, not worker or lifecycle integration.
describe("Claw Control UI executor outcomes", () => {
  it("preserves a partial update without requesting agent readiness", async () => {
    mocks.update.mockResolvedValue({ agentId, status: "partial" });
    const { host, ready } = readinessHost();

    await expect(
      executeClawControlUiOperation(updateCommand, host, vi.fn()),
    ).resolves.toMatchObject({
      schemaVersion: "openclaw.clawsGatewayApply.v1",
      operation: "update",
      agentId,
      status: "partial",
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(host.mock.calls.map(([request]) => request.method)).toEqual(["config"]);
  });

  it("returns partial when a complete update cannot become ready", async () => {
    mocks.update.mockResolvedValue({ agentId, status: "complete" });
    const { host, ready } = readinessHost();

    await expect(
      executeClawControlUiOperation(updateCommand, host, vi.fn()),
    ).resolves.toMatchObject({
      schemaVersion: "openclaw.clawsGatewayApply.v1",
      operation: "update",
      agentId,
      status: "partial",
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
    expect(host.mock.calls.map(([request]) => request.method)).toEqual(["config", "agent.ready"]);
  });

  it("returns partial when a complete add cannot become ready", async () => {
    const packageRoot = path.resolve("fixture-claw");
    mocks.source.mockImplementation(
      async ({ run }: { run: (...args: unknown[]) => Promise<unknown> }) => ({
        value: await run(loaded, {}, async () => loaded),
      }),
    );
    mocks.inventory.mockResolvedValue({ installs: [] });
    mocks.addPreview.mockReturnValue(preview);
    mocks.addPlan.mockImplementation(async ({ physicalSource }: { physicalSource?: boolean }) => ({
      planIntegrity: "canonical-add",
      claw: {
        packageRoot,
        manifestPath: physicalSource
          ? path.join(packageRoot, "openclaw.claw.json")
          : "$CLAW_SOURCE/openclaw.claw.json",
      },
      actions: [],
    }));
    mocks.add.mockResolvedValue({ agent: { finalId: agentId }, status: "complete" });
    const { host, ready } = readinessHost();

    await expect(
      executeClawControlUiOperation(
        { operation: "add", params: { agentId, source, planIntegrity: preview.planIntegrity } },
        host,
        vi.fn(),
      ),
    ).resolves.toMatchObject({
      schemaVersion: "openclaw.clawsGatewayApply.v1",
      operation: "add",
      agentId,
      status: "partial",
    });
    expect(mocks.add).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
    expect(host.mock.calls.map(([request]) => request.method)).toEqual([
      "config",
      "config",
      "agent.ready",
    ]);
  });

  it("passes fresh read-only inventory to removal planning (not full no-write proof)", async () => {
    const inventory = {
      installs: [],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    };
    mocks.inventory.mockResolvedValue(inventory);
    mocks.removePlan.mockResolvedValue({
      planIntegrity: "canonical-remove",
      agentId,
      actions: [],
      blockers: [],
    });
    const host = vi.fn<ClawControlUiHost>(async ({ method }) => {
      if (method === "config") {
        return config;
      }
      if (method === "monitor.binding") {
        return {
          configPath: "fixture-config",
          statePath: "fixture-state",
          cronStorePath: "fixture-cron",
        };
      }
      throw new Error(`Unexpected fixture host request: ${method}`);
    });
    const beforePersistentApply = vi.fn();

    await expect(
      executeClawControlUiOperation(
        { operation: "remove.plan", params: { target: agentId } },
        host,
        beforePersistentApply,
      ),
    ).resolves.toMatchObject({ operation: "remove", target: { agentId }, blockers: [] });
    expect(mocks.removePlan).toHaveBeenCalledExactlyOnceWith(
      agentId,
      expect.objectContaining({ config, readOnly: true, inventory }),
    );
    expect(mocks.inventory).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(beforePersistentApply).not.toHaveBeenCalled();
    expect(host.mock.calls.map(([request]) => request.method)).toEqual([
      "monitor.binding",
      "config",
    ]);
  });
});
