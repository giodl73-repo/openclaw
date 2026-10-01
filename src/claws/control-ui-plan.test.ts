import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/validator-registry-claws.js";
import { digestClawValue } from "./digest.js";
import type { ClawAddPlan } from "./types.js";

const mocks = vi.hoisted(() => ({ source: vi.fn(), inventory: vi.fn(), build: vi.fn() }));
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.source }));
vi.mock("./inventory-read.js", () => ({ readClawInventory: mocks.inventory }));
vi.mock("./lifecycle.js", () => ({ buildClawAddPlan: mocks.build }));
vi.mock("./packages.js", () => ({ preflightClawPackage: vi.fn() }));
import { planClawAddFromCatalog, projectClawAddPlan } from "./control-ui-plan.js";

const trust = {
  publisher: "Owner (@owner)",
  integrity: "sha256:trust",
  riskAcknowledgementRequired: false,
};
const canonical = {
  planIntegrity: "sha256:canonical",
  agent: {
    finalId: "assistant",
    workspace: "/private/workspace",
    config: { id: "assistant", workspace: "/private/workspace" },
  },
  claw: { name: "@owner/assistant", version: "1.2.3", packageRoot: "/private/source" },
  actions: [
    {
      kind: "workspace",
      id: "assistant",
      action: "create",
      blocked: false,
      target: "/private/workspace",
    },
  ],
  capabilityChanges: [
    {
      kind: "mcpServer",
      id: "tools",
      action: "configure",
      effect: { env: { PRIVATE: "fixture" } },
    },
  ],
  blockers: [],
  readiness: { ready: true, requirements: [] },
} as unknown as ClawAddPlan;

beforeEach(() => vi.resetAllMocks());

describe("Claw Gateway add preview", () => {
  it("discloses planned cron declarations while binding hidden message changes", () => {
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
            name: "private-name",
            message,
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "main",
            delivery: { mode: "announce", channel: "last" },
            agentId: "assistant",
            expectedState: "absent",
          },
        },
      ];
      return { ...canonical, actions, planIntegrity: digestClawValue(actions) };
    };
    const first = projectClawAddPlan(withMessage("private-message-one"), trust, {});
    const second = projectClawAddPlan(withMessage("private-message-two"), trust, {});
    expect(validateClawLifecyclePlanResult(first)).toBe(true);
    expect(first.scheduledJobs).toEqual({
      coverage: "package-declarations",
      jobs: [
        {
          id: "daily",
          action: "schedule",
          blocked: false,
          proposed: {
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "main",
            delivery: "last-channel",
          },
        },
      ],
    });
    expect(second.scheduledJobs).toEqual(first.scheduledJobs);
    expect(second.planIntegrity).not.toBe(first.planIntegrity);
    expect(first.effectivePermissions?.unresolved).toContain("scheduled-jobs");
    expect(JSON.stringify([first, second])).not.toContain("private");
    expect(projectClawAddPlan(canonical, trust, {}).scheduledJobs).toEqual({
      coverage: "package-declarations",
      jobs: [],
    });
  });

  it("projects canonical actions without source paths, config, or capability effects", () => {
    const result = projectClawAddPlan(canonical, trust, {});
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    expect(result.target).toEqual({
      agentId: "assistant",
      name: "@owner/assistant",
      targetVersion: "1.2.3",
      publisher: "Owner (@owner)",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("fixture");
  });

  it("binds exact canonical state, publisher, trust, and risk acknowledgement into consent integrity", () => {
    const original = projectClawAddPlan(canonical, trust, {}).planIntegrity;
    expect(projectClawAddPlan(canonical, trust, {}).planIntegrity).toBe(original);
    for (const change of [
      { publisher: "Other owner" },
      { integrity: "sha256:new-trust" },
      { riskAcknowledgementRequired: true },
      { trustWarning: "Review this release." },
    ]) {
      expect(projectClawAddPlan(canonical, { ...trust, ...change }, {}).planIntegrity).not.toBe(
        original,
      );
    }
    expect(
      projectClawAddPlan({ ...canonical, planIntegrity: "sha256:changed-state" }, trust, {})
        .planIntegrity,
    ).not.toBe(original);
  });

  it("binds inherited policy changes into the displayed add consent", () => {
    const original = projectClawAddPlan(canonical, trust, {});
    const restricted = projectClawAddPlan(canonical, trust, {
      tools: { deny: ["exec"], fs: { workspaceOnly: true } },
    });
    expect(original.effectivePermissions?.desired?.tools.allowed).toContain("exec");
    expect(restricted.effectivePermissions?.desired?.tools.excluded).toContain("exec");
    expect(restricted.effectivePermissions?.desired?.filesystem.workspaceOnly).toBe(true);
    expect(restricted.planIntegrity).not.toBe(original.planIntegrity);
  });

  it("binds configured memory and delegation facts into add consent", () => {
    const original = projectClawAddPlan(canonical, trust, {});
    const memory = projectClawAddPlan(canonical, trust, {
      memory: { search: { enabled: false } },
    });
    expect(memory.effectivePermissions?.desired?.memorySearch).toEqual({ state: "disabled" });
    expect(memory.planIntegrity).not.toBe(original.planIntegrity);
    const delegation = projectClawAddPlan(canonical, trust, {
      agents: { defaults: { subagents: { allowAgents: [], requireAgentId: true } } },
    });
    expect(delegation.effectivePermissions?.desired?.subagentTargets).toEqual({
      explicitAgentIds: [],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: false,
      requireAgentId: true,
    });
    expect(delegation.planIntegrity).not.toBe(original.planIntegrity);
    const wildcardConfig = {
      agents: { defaults: { subagents: { allowAgents: ["*"] } } },
    };
    const wildcard = projectClawAddPlan(canonical, trust, wildcardConfig);
    const expandedRoster = projectClawAddPlan(canonical, trust, {
      agents: { ...wildcardConfig.agents, entries: { main: {}, reviewer: {} } },
    });
    expect(wildcard.effectivePermissions?.desired?.subagentTargets.explicitAgentIds).toEqual([
      "assistant",
      "main",
    ]);
    expect(expandedRoster.effectivePermissions?.desired?.subagentTargets.explicitAgentIds).toEqual([
      "assistant",
      "main",
      "reviewer",
    ]);
    expect(expandedRoster.planIntegrity).not.toBe(wildcard.planIntegrity);
  });

  it("uses post-resolution runtime config and pending ownership with the canonical planner", async () => {
    const config = { agents: { entries: {} } };
    const getRuntimeConfig = vi.fn(() => config);
    const loaded = { source: {}, manifest: { packages: [] }, diagnostics: [] };
    mocks.source.mockImplementation(async ({ mode, run }) => {
      expect(mode).toBe("preview");
      expect(getRuntimeConfig).not.toHaveBeenCalled();
      return {
        value: await run(
          loaded,
          trust,
          vi.fn(() => {
            throw new Error("Preview persisted source");
          }),
        ),
      };
    });
    mocks.inventory.mockImplementation(async () => {
      expect(getRuntimeConfig).not.toHaveBeenCalled();
      return { installs: [{ agentId: "pending-agent", workspace: "/pending/workspace" }] };
    });
    mocks.build.mockResolvedValue(canonical);
    const result = await planClawAddFromCatalog({
      source: { packageName: "@owner/assistant", version: "1.2.3" },
      getRuntimeConfig,
    });
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "capability_disclosure_unavailable",
        message:
          "Applying Claws is unavailable until the preview discloses effective agent permissions.",
      }),
    );
    expect(result.effectivePermissions).toMatchObject({
      coverage: "configuration-only",
      unresolved: expect.arrayContaining(["runtime-tools", "memory", "delegation"]),
      desired: { sandbox: { mode: "off" } },
    });
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          config,
          sourceReferenceRoot: "$CLAW_SOURCE",
          existingAgentIds: expect.arrayContaining(["pending-agent"]),
          existingWorkspacePaths: expect.arrayContaining(["/pending/workspace"]),
        }),
      }),
    );
  });
});
