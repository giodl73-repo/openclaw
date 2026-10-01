import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), execute: vi.fn() }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: mocks.capture,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: mocks.run,
}));
import {
  persistClawInstallRecordAsync,
  updateClawInstallRecordAsync,
  withClawMutationGuard,
  updateClawInstallRecordStatusAsync,
  recordAgentProvenanceAsync,
} from "./state-write.js";
import type { ClawAddPlan } from "./types.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockReturnValue({ admission: "captured-owner" });
  mocks.run.mockImplementation(async (_context, operation, options) => {
    options.assertCurrent?.();
    await Promise.resolve();
    options.assertCurrent?.();
    return operation({ execute: mocks.execute });
  });
});

it("carries adopted ownership and authored config identity across the worker boundary", async () => {
  const plan: ClawAddPlan = {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:synthetic-plan",
    claw: {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: "/synthetic/package",
      manifestPath: "/synthetic/package/CLAW.md",
      integrityKind: "artifact",
      integrity: "sha256:synthetic-package",
      byteLength: 100,
    },
    agent: {
      requestedId: "worker",
      finalId: "worker",
      workspace: "/synthetic/workspace",
      config: { workspace: "/synthetic/workspace" },
    },
    summary: {
      totalActions: 0,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: 0,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: [],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
  await persistClawInstallRecordAsync(plan, { agentOrigin: "adopted" });
  await updateClawInstallRecordAsync(plan, { agentConfigDigest: "sha256:authored-config" });
  expect(mocks.execute.mock.calls.map(([command]) => command)).toMatchObject([
    {
      type: "claws.state.persistClawInstallRecord",
      input: { args: [plan], options: { agentOrigin: "adopted" } },
    },
    {
      type: "claws.state.updateClawInstallRecord",
      input: { args: [plan], options: { agentConfigDigest: "sha256:authored-config" } },
    },
  ]);
});

it("sends canonical finite state commands to the broker, without serializing environment or callbacks", async () => {
  const guard = vi.fn();
  await withClawMutationGuard(guard, () =>
    updateClawInstallRecordStatusAsync("assistant", "complete", {
      env: { PRIVATE_FIXTURE: "not-for-worker-command" },
      nowMs: 123,
      expectedStatuses: ["config_committed"],
    }),
  );
  expect(guard).toHaveBeenCalledTimes(2);
  expect(mocks.execute).toHaveBeenCalledWith({
    type: "claws.state.updateClawInstallRecordStatus",
    input: {
      args: ["assistant", "complete"],
      options: { nowMs: 123, expectedStatuses: ["config_committed"] },
    },
  });
  expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain("PRIVATE_FIXTURE");
});

it("composes parent authority and rejects queued writes when that authority retires", async () => {
  let current = true;
  const parent = () => {
    if (!current) {
      throw new Error("retired");
    }
  };
  const child = vi.fn();
  mocks.run.mockImplementationOnce(async (_context, operation, options) => {
    options.assertCurrent();
    await Promise.resolve();
    current = false;
    options.assertCurrent();
    return operation({ execute: mocks.execute });
  });
  await expect(
    withClawMutationGuard(parent, () =>
      withClawMutationGuard(child, () =>
        recordAgentProvenanceAsync("assistant", { createdVia: "claw" }),
      ),
    ),
  ).rejects.toThrow("retired");
  expect(child).toHaveBeenCalledTimes(1);
  expect(mocks.execute).not.toHaveBeenCalled();
});
