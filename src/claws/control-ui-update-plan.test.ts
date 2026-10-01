import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/validator-registry-claws.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron.js";
import { digestClawValue } from "./digest.js";
import { prepareCapturedClawToolPolicyConsent } from "./tool-policy-runtime.js";
import type { ClawCronJob } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  detail: vi.fn(),
  inventory: vi.fn(),
  build: vi.fn(),
}));
vi.mock("./clawhub-source.js", () => ({
  ClawHubSourceError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  withResolvedClawHubSource: mocks.source,
  readClawHubClawDetail: mocks.detail,
}));
vi.mock("./inventory-read.js", () => ({ readClawInventory: mocks.inventory }));
vi.mock("./update-plan.js", () => ({ buildClawUpdatePlanWithTarget: mocks.build }));
vi.mock("./packages.js", () => ({ preflightClawPackage: vi.fn() }));
import { planClawUpdateFromCatalog, projectClawUpdatePlan } from "./control-ui-update-plan.js";

const trust = {
  publisher: "Owner (@owner)",
  integrity: "trust",
  riskAcknowledgementRequired: false,
};
const source = { packageName: "@owner/assistant", version: "1.2.3" };
const install = { agentId: "assistant", claw: { kind: "package", name: source.packageName } };
const targetAgent: AgentConfig = {
  id: "assistant",
  workspace: "/private/canonical-workspace",
  tools: { profile: "full", allow: ["read"], fs: { workspaceOnly: true } },
  sandbox: {
    mode: "all",
    scope: "agent",
    workspaceAccess: "ro",
    docker: { env: { PRIVATE: "canonical-secret-fixture" } },
  },
  heartbeat: { every: "5m", prompt: "private-heartbeat-fixture" },
};
const canonical = {
  planIntegrity: "canonical",
  agentId: "assistant",
  currentClaw: { name: source.packageName, version: "1.0.0", integrity: "old" },
  targetClaw: { name: source.packageName, version: source.version, integrity: "new" },
  actions: [
    {
      kind: "workspaceFile",
      id: "SOUL.md",
      action: "change",
      blocked: false,
      target: "/private/workspace",
      reason: "private source",
    },
  ],
  capabilityChanges: [
    {
      kind: "mcpServer",
      id: "tools",
      action: "change",
      classification: "escalation",
      reason: "private",
      effect: { env: { PRIVATE: "fixture" } },
    },
  ],
  blockers: [],
  readiness: { ready: true, requirements: [] },
} as unknown as ClawUpdatePlan;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inventory.mockResolvedValue({ installs: [install], cronJobs: [] });
  mocks.build.mockResolvedValue({ plan: canonical, targetAgent });
  mocks.source.mockImplementation(async ({ run }) => ({
    value: await run(
      { manifest: { packages: [], cronJobs: [] }, source: {}, diagnostics: [] },
      trust,
    ),
  }));
});

describe("Claw Gateway update preview", () => {
  it("uses post-download cron refs and binds hidden message changes without exposing live state", async () => {
    const currentJob: ClawCronJob = {
      id: "daily",
      name: "private-name",
      message: "private-current-message",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      session: "isolated",
    };
    const ref: PersistedClawCronRef = {
      schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
      agentId: "assistant",
      manifestId: currentJob.id,
      declarationKey: "claw:assistant:daily",
      schedulerJobId: "private-scheduler-id",
      status: "complete",
      job: currentJob,
      createdAtMs: 1,
      updatedAtMs: 2,
      error: "private-error",
    };
    const preview = async (message: string) => {
      const proposed = { ...currentJob, message };
      const actions: ClawUpdatePlan["actions"] = [
        {
          kind: "cronJob",
          id: "daily",
          action: "change",
          blocked: false,
          target: "private-target",
          reason: "private-reason",
          currentDigest: digestClawValue(currentJob),
          desiredDigest: digestClawValue(proposed),
        },
      ];
      mocks.inventory
        .mockReset()
        .mockResolvedValueOnce({ installs: [install], cronJobs: [] })
        .mockResolvedValueOnce({
          installs: [install],
          cronJobs: [ref, { ...ref, agentId: "private-other-agent" }],
        });
      mocks.source.mockImplementation(async ({ run }) => ({
        value: await run(
          {
            manifest: { packages: [], cronJobs: [proposed] },
            source: {},
            diagnostics: [],
          },
          trust,
        ),
      }));
      mocks.build.mockResolvedValue({
        plan: { ...canonical, actions, planIntegrity: digestClawValue(actions) },
        targetAgent,
      });
      return planClawUpdateFromCatalog({
        target: "assistant",
        source,
        getRuntimeConfig: () => ({}),
      });
    };
    const first = await preview("private-proposed-message-one");
    const second = await preview("private-proposed-message-two");
    const safeJob = { schedule: currentJob.schedule, session: "isolated", delivery: "none" };
    expect(validateClawLifecyclePlanResult(first)).toBe(true);
    expect(first.scheduledJobs).toEqual({
      coverage: "package-declarations",
      jobs: [
        {
          id: "daily",
          action: "change",
          blocked: false,
          recorded: {
            state: "declared",
            job: safeJob,
            status: "complete",
            schedulerIdRecorded: true,
          },
          proposed: safeJob,
        },
      ],
    });
    expect(second.scheduledJobs).toEqual(first.scheduledJobs);
    expect(second.planIntegrity).not.toBe(first.planIntegrity);
    expect(first.effectivePermissions?.unresolved).toContain("scheduled-jobs");
    expect(first.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
    expect(JSON.stringify([first, second])).not.toContain("private");
    const projected = projectClawUpdatePlan(canonical, trust, undefined, first.scheduledJobs);
    expect(projected.planIntegrity).not.toBe(projectClawUpdatePlan(canonical, trust).planIntegrity);
    expect(projected.planIntegrity).not.toBe(
      projectClawUpdatePlan(canonical, trust, undefined, {
        coverage: "package-declarations",
        jobs: [{ id: "daily", action: "manual", blocked: true, recorded: { state: "unresolved" } }],
      }).planIntegrity,
    );
  });

  it("projects version changes and capability direction without private plan details", () => {
    const result = projectClawUpdatePlan(canonical, trust);
    expect(result.scheduledJobs).toBeUndefined();
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    expect(result.target).toMatchObject({
      currentVersion: "1.0.0",
      targetVersion: "1.2.3",
      publisher: trust.publisher,
    });
    expect(result.capabilities[0]?.reason).toContain("expands");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("fixture");
    for (const changed of [
      { publisher: "Different owner" },
      { integrity: "changed" },
      { riskAcknowledgementRequired: true },
    ]) {
      expect(projectClawUpdatePlan(canonical, { ...trust, ...changed }).planIntegrity).not.toBe(
        result.planIntegrity,
      );
    }
    expect(
      projectClawUpdatePlan({ ...canonical, planIntegrity: "new-state" }, trust).planIntegrity,
    ).not.toBe(result.planIntegrity);
  });

  it("passes fresh post-download state and the bound agent to the canonical planner", async () => {
    const freshInventory = { installs: [install], packages: [], cronJobs: [] };
    mocks.inventory
      .mockResolvedValueOnce({ installs: [install] })
      .mockResolvedValueOnce(freshInventory);
    const config = { agents: { entries: {} } };
    const getRuntimeConfig = vi.fn(() => config);
    mocks.source.mockImplementation(async ({ coordinate, run }) => {
      expect(coordinate).toEqual(source);
      expect(getRuntimeConfig).not.toHaveBeenCalled();
      return {
        value: await run(
          { manifest: { packages: [], cronJobs: [] }, source: {}, diagnostics: [] },
          trust,
        ),
      };
    });
    const result = await planClawUpdateFromCatalog({
      target: source.packageName,
      source,
      getRuntimeConfig,
    });
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "assistant", inventory: freshInventory, config }),
    );
  });

  it("resolves latest only when no exact source was supplied", async () => {
    mocks.detail.mockResolvedValue(source);
    await planClawUpdateFromCatalog({ target: "assistant", getRuntimeConfig: () => ({}) });
    expect(mocks.detail).toHaveBeenCalledWith({ packageName: source.packageName });
    expect(mocks.source).toHaveBeenCalledWith(expect.objectContaining({ coordinate: source }));
  });

  it("discloses the canonical target and inherited current permissions without raw config", async () => {
    const config = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        entries: { assistant: {} },
        defaults: { heartbeat: { every: "30m", prompt: "private-current-prompt" } },
      },
    };
    const result = await planClawUpdateFromCatalog({
      target: "assistant",
      source,
      getRuntimeConfig: () => config,
    });
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(result.effectivePermissions).toMatchObject({
      coverage: "configuration-only",
      current: {
        filesystem: { workspaceOnly: false },
        heartbeat: { enabled: true, intervalMs: 1_800_000 },
      },
      desired: {
        tools: { allowed: ["read", "skills_read"] },
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro", backend: "docker" },
        filesystem: { workspaceOnly: true },
        heartbeat: { enabled: true, intervalMs: 300_000 },
      },
      unresolved: expect.arrayContaining(["memory", "delegation", "scheduled-jobs"]),
    });
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("canonical-secret-fixture");
    expect(serialized).not.toContain("targetAgent");
    const disclosure = result.effectivePermissions!;
    const projected = projectClawUpdatePlan(canonical, trust, disclosure);
    expect(projectClawUpdatePlan(canonical, trust).planIntegrity).not.toBe(projected.planIntegrity);
    expect(
      projectClawUpdatePlan(canonical, trust, {
        ...disclosure,
        desired: { ...disclosure.desired!, filesystem: { workspaceOnly: false } },
      }).planIntegrity,
    ).not.toBe(projected.planIntegrity);
  });

  it("retains the blocked desired preview when current consent provenance is uninitialized", async () => {
    const config: OpenClawConfig = {
      agents: { entries: { assistant: { tools: { profile: "full", allow: ["read"] } } } },
    };
    // Tag the captured config from absent cached provenance without opening a database.
    prepareCapturedClawToolPolicyConsent(config, {
      path: resolve("fixture-update-preview-unprepared-claw-consent.sqlite"),
    });

    const result = await planClawUpdateFromCatalog({
      target: "assistant",
      source,
      getRuntimeConfig: () => config,
    });

    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
    expect(result.effectivePermissions?.current).toBeUndefined();
    expect(result.effectivePermissions?.desired).toMatchObject({
      tools: { allowed: ["read", "skills_read"] },
      filesystem: { workspaceOnly: true },
    });
    expect(result.effectivePermissions?.unresolved).toContain("current-agent");
    expect(JSON.stringify(result)).not.toMatch(
      /provenance|sqlite|fixture|ClawToolProfileConsentStateError/u,
    );
  });

  it("compares and binds memory and subagent target policy from the canonical target", async () => {
    mocks.build.mockResolvedValue({
      plan: canonical,
      targetAgent: {
        ...targetAgent,
        memory: { search: { enabled: false } },
        subagents: { allowAgents: [], requireAgentId: true },
      },
    });
    const result = await planClawUpdateFromCatalog({
      target: "assistant",
      source,
      getRuntimeConfig: () => ({ agents: { entries: { assistant: {} } } }),
    });
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    const disclosure = result.effectivePermissions!;
    expect(disclosure.current?.memorySearch.state).toBe("configured");
    expect(disclosure.desired?.memorySearch).toEqual({ state: "disabled" });
    expect(disclosure.current?.subagentTargets.explicitAgentIds).toEqual(["assistant"]);
    expect(disclosure.desired?.subagentTargets).toEqual({
      explicitAgentIds: [],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: false,
      requireAgentId: true,
    });
    const integrity = projectClawUpdatePlan(canonical, trust, disclosure).planIntegrity;
    for (const change of [
      { memorySearch: disclosure.current!.memorySearch },
      { subagentTargets: disclosure.current!.subagentTargets },
    ]) {
      expect(
        projectClawUpdatePlan(canonical, trust, {
          ...disclosure,
          desired: { ...disclosure.desired!, ...change },
        }).planIntegrity,
      ).not.toBe(integrity);
    }
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
  });

  it("marks target disclosure unresolved when canonical planning has no target agent", async () => {
    mocks.build.mockResolvedValue({ plan: canonical });
    const result = await planClawUpdateFromCatalog({
      target: "assistant",
      source,
      getRuntimeConfig: () => ({}),
    });
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    expect(result.effectivePermissions?.desired).toBeUndefined();
    expect(result.effectivePermissions?.unresolved).toContain("target-agent");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
  });

  it("blocks plugin-bearing updates until the plugin owner can verify consent", async () => {
    mocks.source.mockImplementation(async ({ run }) => ({
      value: await run(
        { manifest: { packages: [{ kind: "plugin" }], cronJobs: [] }, source: {}, diagnostics: [] },
        trust,
      ),
    }));
    const result = await planClawUpdateFromCatalog({
      target: "assistant",
      source,
      getRuntimeConfig: () => ({}),
    });
    expect(result.blockers).toContainEqual({
      code: "plugin_consent_unavailable",
      path: "$.packages[0]",
      message: "Plugin capability consent is not available through the Claws Control UI.",
    });
    expect(result.planIntegrity).not.toBe(projectClawUpdatePlan(canonical, trust).planIntegrity);
  });

  it.each([
    { installs: [], source, code: "claw_not_found" },
    { installs: [install, { ...install, agentId: "other" }], source, code: "claw_ambiguous" },
    {
      installs: [{ ...install, claw: { ...install.claw, kind: "development" } }],
      source,
      code: "claw_source_unsupported",
    },
    {
      installs: [install],
      source: { ...source, packageName: "@owner/unrelated" },
      code: "clawhub_identity_mismatch",
    },
  ])(
    "rejects $code before resolving an artifact",
    async ({ installs, source: candidate, code }) => {
      mocks.inventory.mockResolvedValue({ installs });
      await expect(
        planClawUpdateFromCatalog({
          target: source.packageName,
          source: candidate,
          getRuntimeConfig: () => ({}),
        }),
      ).rejects.toMatchObject({ code });
      expect(mocks.source).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    },
  );
});
