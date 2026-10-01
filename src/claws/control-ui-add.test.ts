import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestClawValue } from "./digest.js";
import type { ClawAddPlan } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  persist: vi.fn(),
  inventory: vi.fn(),
  build: vi.fn(),
  apply: vi.fn(),
  lease: vi.fn(),
  owned: vi.fn(),
  config: vi.fn(),
  project: vi.fn(),
}));
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
vi.mock("./inventory-read.js", () => ({ readClawInventory: mocks.inventory }));
vi.mock("./control-ui-plan.js", () => ({
  buildClawControlUiAddPlan: mocks.build,
  projectClawAddPlan: mocks.project,
}));
vi.mock("./add.js", () => ({ applyClawAddPlan: mocks.apply }));
vi.mock("../config/config.js", () => ({ transformConfigFileWithRetry: mocks.config }));
vi.mock("../state/openclaw-state-lease.js", () => ({ withOpenClawStateLease: mocks.lease }));
import { applyClawAddFromCatalog, materializeClawAddSource } from "./control-ui-add.js";
import { assertClawMutationCurrent } from "./state-write.js";

const { projectClawAddPlan } =
  await vi.importActual<typeof import("./control-ui-plan.js")>("./control-ui-plan.js");

const source = {
  kind: "package" as const,
  name: "@owner/assistant",
  version: "1.2.3",
  integrityKind: "artifact" as const,
  integrity: "sha256:artifact",
  byteLength: 1,
  packageRoot: resolve("fixture-source"),
  manifestPath: resolve("fixture-source", "CLAW.md"),
};
const canonical = {
  schemaVersion: "openclaw.clawAddPlan.v1",
  manifestSchemaVersion: 1,
  planIntegrity: "canonical",
  claw: { ...source, packageRoot: "$CLAW_SOURCE", manifestPath: "$CLAW_SOURCE/CLAW.md" },
  agent: {
    finalId: "assistant",
    config: { id: "assistant", workspace: resolve("fixture-workspace") },
  },
  actions: [
    {
      kind: "workspaceFile",
      id: "SOUL.md",
      source: "$CLAW_SOURCE/CLAW.md",
      sourceKind: "clawMarkdownBody",
      target: resolve("fixture-workspace", "SOUL.md"),
      blocked: false,
    },
  ],
  capabilityChanges: [],
  blockers: [],
  diagnostics: [],
  readiness: { ready: true, requirements: [] },
} as unknown as ClawAddPlan;
const loaded = { source, manifest: { packages: [] } };
const inventory = { installs: [], packages: [], workspaceFiles: [], mcpServers: [], cronJobs: [] };
const request = () => ({
  source: { packageName: source.name, version: source.version },
  planIntegrity: "canonical:trust",
  getRuntimeConfig: vi.fn(() => ({})),
  assertCurrent: vi.fn(),
  cronGateway: { add: vi.fn() },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.project.mockImplementation((plan: ClawAddPlan, trust: { integrity: string }) => ({
    planIntegrity: `${plan.planIntegrity}:${trust.integrity}`,
  }));
  mocks.resolve.mockImplementation(async ({ run }) => ({
    value: await run(loaded, { integrity: "trust" }, mocks.persist),
  }));
  mocks.persist.mockResolvedValue(loaded);
  mocks.inventory.mockResolvedValue(inventory);
  mocks.build.mockImplementation(async ({ physicalSource }) =>
    physicalSource
      ? { ...materializeClawAddSource(canonical, source), planIntegrity: "physical" }
      : structuredClone(canonical),
  );
  mocks.lease.mockImplementation(async (_options, run) => run({ assertOwned: mocks.owned }));
  mocks.apply.mockResolvedValue({ status: "complete", agent: { finalId: "assistant" } });
});

describe("Claw Gateway canonical add apply", () => {
  it("rechecks the real scheduled declaration projection before persisting a message-only change", async () => {
    mocks.project.mockImplementation(projectClawAddPlan);
    const withMessage = (message: string): ClawAddPlan => {
      const actions: ClawAddPlan["actions"] = [
        {
          kind: "cronJob",
          id: "daily",
          action: "schedule",
          blocked: false,
          target: "private-target",
          details: {
            id: "daily",
            message,
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            agentId: "assistant",
            expectedState: "absent",
          },
        },
      ];
      return { ...canonical, actions, planIntegrity: digestClawValue(actions) };
    };
    const trust = { integrity: "trust", riskAcknowledgementRequired: false };
    mocks.resolve.mockImplementation(async ({ run }) => ({
      value: await run(loaded, trust, mocks.persist),
    }));
    const consent = projectClawAddPlan(withMessage("private-reviewed-message"), trust, {});
    const changed = withMessage("private-changed-message");
    expect(projectClawAddPlan(changed, trust, {}).scheduledJobs).toEqual(consent.scheduledJobs);
    mocks.build.mockResolvedValueOnce(changed);
    await expect(
      applyClawAddFromCatalog({ ...request(), planIntegrity: consent.planIntegrity }),
    ).rejects.toThrow("consent changed");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("validates consent before persistence and applies the canonical physical plan under live ownership", async () => {
    const params = request();
    mocks.apply.mockImplementationOnce(async (plan, options) => {
      assertClawMutationCurrent();
      expect(mocks.owned).toHaveBeenCalled();
      expect(plan.claw.packageRoot).toBe(source.packageRoot);
      expect(plan.actions[0].source).toBe(source.manifestPath);
      expect(options.consentPlanIntegrity).toBe("physical");
      expect(options.cronGateway).toBe(params.cronGateway);
      return { status: "complete", agent: { finalId: "assistant" } };
    });
    expect(await applyClawAddFromCatalog(params)).toEqual({
      schemaVersion: "openclaw.clawsGatewayApply.v1",
      operation: "add",
      status: "complete",
      agentId: "assistant",
      message: "Claw added.",
    });
    expect(mocks.inventory).toHaveBeenCalledTimes(2);
    expect(mocks.lease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "core:agent-deletion", key: "assistant" }),
      expect.any(Function),
    );
  });

  it.each(["stale", "publisher-changed", "trust-changed"])(
    "rejects %s consent without source persistence or mutation",
    async (planIntegrity) => {
      await expect(applyClawAddFromCatalog({ ...request(), planIntegrity })).rejects.toThrow(
        "consent changed",
      );
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["plugin_consent_unavailable", "capability_disclosure_unavailable"])(
    "fails closed for %s even when the supplied digest matches",
    async (code) => {
      mocks.build.mockResolvedValueOnce({
        ...canonical,
        blockers: [{ code }],
      });
      await expect(applyClawAddFromCatalog(request())).rejects.toThrow("blocked");
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.lease).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );

  it("rejects ownership changes while acquiring the agent fence", async () => {
    mocks.build
      .mockResolvedValueOnce(canonical)
      .mockResolvedValueOnce({ ...canonical, planIntegrity: "changed" });
    await expect(applyClawAddFromCatalog(request())).rejects.toThrow("consent changed");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects changed persisted bytes and never applies an altered physical plan", async () => {
    mocks.build
      .mockResolvedValueOnce(canonical)
      .mockResolvedValueOnce(canonical)
      .mockResolvedValueOnce({
        ...materializeClawAddSource(canonical, source),
        actions: [],
      });
    await expect(applyClawAddFromCatalog(request())).rejects.toThrow("source or state changed");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rechecks runtime config and authority after source persistence", async () => {
    const params = request();
    mocks.persist.mockImplementationOnce(async () => {
      params.getRuntimeConfig.mockReturnValue({ agents: { entries: {} } });
      return loaded;
    });
    await expect(applyClawAddFromCatalog(params)).rejects.toThrow("config changed");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("retains live request guards throughout canonical executor awaits", async () => {
    const params = request();
    mocks.apply.mockImplementationOnce(async () => {
      params.assertCurrent.mockImplementation(() => {
        throw new Error("revoked");
      });
      assertClawMutationCurrent();
    });
    await expect(applyClawAddFromCatalog(params)).rejects.toThrow("revoked");
  });

  it("projects settled partial outcomes after authority retirement without canonical paths or errors", async () => {
    const params = request();
    mocks.apply.mockImplementationOnce(async () => {
      params.assertCurrent.mockImplementation(() => {
        throw new Error("retired");
      });
      return {
        status: "partial",
        agent: { finalId: "assistant" },
        error: { message: "secret /private/path" },
      };
    });
    const result = await applyClawAddFromCatalog(params);
    expect(result.status).toBe("partial");
    expect(JSON.stringify(result)).not.toMatch(/secret|private/u);
  });

  it.each(["request", "lease"])(
    "rejects revoked %s authority after config commit",
    async (owner) => {
      const params = request();
      const mutate = vi.fn();
      mocks.config.mockImplementationOnce(async ({ transform, writeOptions }) => {
        transform({});
        writeOptions.assertCurrent();
        params.getRuntimeConfig.mockReturnValue({ agents: { entries: {} } });
      });
      mocks.apply.mockImplementationOnce(async (_plan, options) => {
        await options.commitConfig((config: unknown) => config);
        assertClawMutationCurrent();
        (owner === "request" ? params.assertCurrent : mocks.owned).mockImplementation(() => {
          throw new Error("revoked after commit");
        });
        await Promise.resolve();
        assertClawMutationCurrent();
        mutate();
      });
      await expect(applyClawAddFromCatalog(params)).rejects.toThrow("revoked after commit");
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { owner: "lease", status: "partial" },
    { owner: "lease", status: "complete" },
    { owner: "source", status: "partial" },
    { owner: "source", status: "complete" },
  ])(
    "reports a settled $status outcome as partial when $owner closure fails",
    async ({ owner, status }) => {
      mocks.apply.mockResolvedValueOnce({ status, agent: { finalId: "assistant" } });
      const closureError = new Error("secret /private/closure-error");
      if (owner === "lease") {
        mocks.lease.mockImplementationOnce(async (_options, run) => {
          await run({ assertOwned: mocks.owned });
          throw closureError;
        });
      } else {
        mocks.resolve.mockImplementationOnce(async ({ run }) => {
          await run(loaded, { integrity: "trust" }, mocks.persist);
          throw closureError;
        });
      }
      const result = await applyClawAddFromCatalog(request());
      expect(result).toMatchObject({ operation: "add", status: "partial", agentId: "assistant" });
      expect(JSON.stringify(result)).not.toMatch(/secret|private/u);
      expect(mocks.apply).toHaveBeenCalledOnce();
    },
  );

  it("does not invent a settled outcome when the lease fails before application", async () => {
    mocks.lease.mockRejectedValueOnce(new Error("lease unavailable"));
    await expect(applyClawAddFromCatalog(request())).rejects.toThrow("lease unavailable");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("relocates only source fields and rejects escaping planner references", () => {
    const plan = structuredClone(canonical);
    plan.actions[0]!.details = { message: "$CLAW_SOURCE/leave-this-literal-alone" };
    expect(materializeClawAddSource(plan, source).actions[0]!.details).toEqual(
      plan.actions[0]!.details,
    );
    plan.actions[0]!.source = "$CLAW_SOURCE/../outside";
    expect(() => materializeClawAddSource(plan, source)).toThrow("escapes");
  });
});
