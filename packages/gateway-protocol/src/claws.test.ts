import { describe, expect, it } from "vitest";
import {
  validateClawsAddApplyParams,
  validateClawsCatalogDetailParams,
  validateClawsRemoveApplyParams,
  validateClawsStatusParams,
  validateClawsUpdatePlanParams,
  validateClawLifecyclePlanResult,
} from "./validator-registry-claws.js";

describe("Claw Gateway contract", () => {
  it("accepts only secret-safe scheduled declarations, not live jobs or payloads", () => {
    const declaration = {
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      session: "isolated",
      delivery: "last-channel",
    };
    const recorded = {
      state: "declared",
      job: declaration,
      status: "complete",
      schedulerIdRecorded: true,
    };
    const job = { id: "daily", action: "change", blocked: false, recorded, proposed: declaration };
    const result = {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "update",
      planIntegrity: "sha256:consented",
      target: { agentId: "assistant" },
      actions: [],
      capabilities: [],
      blockers: [],
      riskAcknowledgementRequired: false,
      scheduledJobs: { coverage: "package-declarations", jobs: [job] },
    };
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    for (const jobs of [
      [],
      [{ ...job, action: "manual", blocked: true, recorded: { state: "unresolved" } }],
      [{ id: "daily", action: "remove", blocked: false, recorded }],
      [{ id: "daily", action: "schedule", blocked: false, proposed: declaration }],
    ]) {
      expect(
        validateClawLifecyclePlanResult({
          ...result,
          scheduledJobs: { ...result.scheduledJobs, jobs },
        }),
      ).toBe(true);
    }
    for (const invalid of [
      { ...result.scheduledJobs, coverage: "live-scheduler" },
      { ...result.scheduledJobs, enabled: true },
      ...[
        { ...job, action: "enable" },
        { ...job, message: "private task" },
        { ...job, name: "private label" },
        { ...job, schedulerJobId: "private-id" },
        { ...job, recorded: { ...recorded, status: "enabled" } },
        { ...job, recorded: { state: "unresolved", error: "private details" } },
        { ...job, proposed: { ...declaration, delivery: "webhook" } },
        { ...job, proposed: { ...declaration, recipient: "private recipient" } },
        { ...job, proposed: { ...declaration, payload: { message: "private task" } } },
        { ...job, proposed: { ...declaration, session: "session:private" } },
        {
          ...job,
          proposed: { ...declaration, schedule: { ...declaration.schedule, nextRunAtMs: 1 } },
        },
      ].map((invalidJob) => ({ ...result.scheduledJobs, jobs: [invalidJob] })),
    ]) {
      expect(validateClawLifecyclePlanResult({ ...result, scheduledJobs: invalid })).toBe(false);
    }
  });

  it("accepts the existing exact-source lifecycle requests", () => {
    expect(validateClawsCatalogDetailParams({ packageName: "@owner/assistant" })).toBe(true);
    expect(
      validateClawsAddApplyParams({
        source: { packageName: "@owner/assistant", version: "1.2.3" },
        planIntegrity: "sha256:consented",
        acknowledgeClawHubRisk: true,
      }),
    ).toBe(true);
    expect(validateClawsUpdatePlanParams({ target: "assistant" })).toBe(true);
    expect(
      validateClawsRemoveApplyParams({
        target: "assistant",
        removeUnused: false,
        planIntegrity: "sha256:consented",
      }),
    ).toBe(true);
  });

  it("rejects client plans, secrets, and missing exact-source consent", () => {
    expect(validateClawsStatusParams({ includeSecrets: true })).toBe(false);
    expect(
      validateClawsAddApplyParams({
        source: { packageName: "@owner/assistant" },
        planIntegrity: "sha256:consented",
      }),
    ).toBe(false);
    expect(
      validateClawsRemoveApplyParams({
        target: "assistant",
        plan: { actions: [] },
      }),
    ).toBe(false);
  });

  it("keeps publisher separate from a channel and accepts no raw plan data", () => {
    const result = {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "add",
      planIntegrity: "sha256:consented",
      target: { name: "Assistant", targetVersion: "1.2.3", publisher: "Owner (@owner)" },
      actions: [],
      capabilities: [],
      blockers: [],
      riskAcknowledgementRequired: false,
    };
    expect(validateClawLifecyclePlanResult(result)).toBe(true);
    expect(validateClawLifecyclePlanResult({ ...result, config: { secret: "fixture" } })).toBe(
      false,
    );
    const permissions = {
      coverage: "configuration-only",
      unresolved: ["runtime-tools", "memory"],
      desired: {
        tools: { allowed: ["read"], excluded: ["exec"] },
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro", backend: "docker" },
        filesystem: { workspaceOnly: true },
        heartbeat: { enabled: false, intervalMs: null },
        memorySearch: {
          state: "configured",
          rememberAcrossConversations: true,
          sessionMemory: true,
          indexedSources: ["memory", "sessions"],
          searchSources: ["memory"],
          extraPathCount: 2,
        },
        subagentTargets: {
          explicitAgentIds: ["assistant"],
          allowAnyConfiguredAgent: false,
          implicitSelfAllowed: true,
          requireAgentId: false,
        },
      },
    };
    expect(validateClawLifecyclePlanResult({ ...result, effectivePermissions: permissions })).toBe(
      true,
    );
    for (const state of ["disabled", "unresolved"]) {
      expect(
        validateClawLifecyclePlanResult({
          ...result,
          effectivePermissions: {
            ...permissions,
            desired: { ...permissions.desired, memorySearch: { state } },
          },
        }),
      ).toBe(true);
    }
    for (const invalid of [
      { ...permissions, coverage: "complete" },
      { ...permissions, unresolved: ["unknown"] },
      { ...permissions, desired: { ...permissions.desired, workspace: "/private/path" } },
      {
        ...permissions,
        desired: {
          ...permissions.desired,
          sandbox: { ...permissions.desired.sandbox, env: { PRIVATE: "fixture" } },
        },
      },
      {
        ...permissions,
        desired: { ...permissions.desired, heartbeat: { enabled: true, intervalMs: -1 } },
      },
      ...[
        { ...permissions.desired.memorySearch, extraPaths: ["/private/path"] },
        { ...permissions.desired.memorySearch, remote: { apiKey: "fixture" } },
        { ...permissions.desired.memorySearch, extraPathCount: -1 },
        { ...permissions.desired.memorySearch, indexedSources: ["unknown"] },
        { ...permissions.desired.memorySearch, searchSources: ["unknown"] },
        { state: "disabled", searchSources: ["memory"] },
        { state: "unresolved", reason: "private owner details" },
      ].map((memorySearch) => ({
        ...permissions,
        desired: { ...permissions.desired, memorySearch },
      })),
      ...[
        { ...permissions.desired.subagentTargets, explicitAgentIds: [""] },
        { ...permissions.desired.subagentTargets, prompt: "private guidance" },
      ].map((subagentTargets) => ({
        ...permissions,
        desired: { ...permissions.desired, subagentTargets },
      })),
    ]) {
      expect(validateClawLifecyclePlanResult({ ...result, effectivePermissions: invalid })).toBe(
        false,
      );
    }
  });
});
