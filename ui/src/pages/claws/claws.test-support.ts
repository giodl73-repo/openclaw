import type {
  ClawCatalogDetail,
  ClawConfiguredPermissions,
  ClawLifecyclePlanResult,
  ClawPermissionDisclosure,
  ClawScheduledJobDisclosure,
  ClawStatusEntry,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";

export const clawMethods = [
  "claws.status",
  "claws.doctor",
  "claws.catalog.detail",
  "claws.add.plan",
  "claws.add.apply",
  "claws.update.plan",
  "claws.update.apply",
  "claws.remove.plan",
  "claws.remove.apply",
];
export const clawRecord: ClawStatusEntry = {
  agentId: "travel",
  name: "@openclaw/travel-concierge",
  version: "0.1.0",
  sourceKind: "package",
  status: "complete",
  agentState: "present",
  bootstrapState: "pending",
  orphaned: false,
  addedAtMs: 1,
  updatedAtMs: 1,
  resources: [
    {
      kind: "workspace-file",
      id: "SOUL.md",
      state: "unchanged",
      relationship: "managed",
      origin: "claw-introduced",
    },
  ],
};
export const clawDetail: ClawCatalogDetail = {
  packageName: clawRecord.name,
  displayName: "Travel Concierge",
  channel: "official",
  official: true,
  version: "0.2.0",
  workspaceFiles: 3,
  skills: 0,
  plugins: 0,
  mcpServers: 0,
  scheduledJobs: 0,
};
export const clawDoctor: ClawsDoctorResult = {
  schemaVersion: "openclaw.clawsGatewayDoctor.v1",
  findings: [],
  summary: { info: 0, warnings: 0, errors: 0 },
};
export function clawStatus(records: ClawStatusEntry[] = [clawRecord]): ClawsStatusResult {
  return {
    schemaVersion: "openclaw.clawsGatewayStatus.v1",
    records,
    summary: {
      claws: records.length,
      healthy: 0,
      attention: records.length,
      managed: records.length,
      referenced: 0,
    },
  };
}
export function clawPlan(operation: "add" | "update" | "remove" = "add"): ClawLifecyclePlanResult {
  const desired: ClawConfiguredPermissions = {
    tools: { allowed: ["read", "web_fetch"], excluded: ["exec"] },
    sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro", backend: "docker" },
    filesystem: { workspaceOnly: true },
    heartbeat: { enabled: true, intervalMs: 1800000 },
    memorySearch: {
      state: "configured",
      rememberAcrossConversations: true,
      sessionMemory: true,
      indexedSources: ["memory", "sessions"],
      searchSources: ["memory"],
      extraPathCount: 2,
    },
    subagentTargets: {
      explicitAgentIds: ["research", "planner"],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: false,
      requireAgentId: true,
    },
  };
  const effectivePermissions: ClawPermissionDisclosure = {
    coverage: "configuration-only",
    desired,
    unresolved: ["runtime-tools", "sandbox-runtime", "memory", "delegation", "scheduled-jobs"],
  };
  if (operation === "update") {
    effectivePermissions.current = {
      tools: { allowed: ["read"], excluded: [] },
      sandbox: { mode: "off", scope: "session", workspaceAccess: "none", backend: "other" },
      filesystem: { workspaceOnly: false },
      heartbeat: { enabled: false, intervalMs: null },
      memorySearch: { state: "disabled" },
      subagentTargets: {
        explicitAgentIds: [],
        allowAnyConfiguredAgent: false,
        implicitSelfAllowed: true,
        requireAgentId: false,
      },
    };
  }
  const scheduledJob: ClawScheduledJobDisclosure["jobs"][number] = {
    id: "daily-review",
    action: operation === "add" ? "schedule" : "change",
    blocked: false,
    proposed: {
      schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
      session: "isolated",
      delivery: "none",
    },
  };
  const scheduledJobs: ClawScheduledJobDisclosure = {
    coverage: "package-declarations",
    jobs: [scheduledJob],
  };
  if (operation === "update") {
    scheduledJob.recorded = {
      state: "declared",
      job: {
        schedule: { cron: "0 8 * * *", timezone: "UTC" },
        session: "main",
        delivery: "last-channel",
      },
      status: "complete",
      schedulerIdRecorded: true,
    };
    scheduledJobs.jobs.push(
      {
        id: "retired-review",
        action: "remove",
        blocked: false,
        recorded: {
          state: "declared",
          job: {
            schedule: { cron: "0 12 * * 0", timezone: "UTC" },
            session: "isolated",
            delivery: "none",
          },
          status: "failed",
          schedulerIdRecorded: false,
        },
      },
      {
        id: "weekly-review-requiring-manual-reconciliation-of-package-declared-scheduler-state",
        action: "manual",
        blocked: true,
        recorded: { state: "unresolved" },
      },
    );
  }
  return {
    schemaVersion: "openclaw.clawsGatewayPlan.v1",
    operation,
    planIntegrity: "reviewed-exact-plan",
    target: {
      name: clawRecord.name,
      agentId: "travel",
      currentVersion: operation !== "add" ? "0.1.0" : undefined,
      targetVersion: operation !== "remove" ? "0.2.0" : undefined,
    },
    actions: [
      {
        kind: "workspace-file",
        id: "SOUL.md",
        action: operation === "remove" ? "preserve" : "write",
        blocked: false,
      },
    ],
    capabilities: [],
    ...(operation === "remove" ? {} : { effectivePermissions, scheduledJobs }),
    blockers: [],
    riskAcknowledgementRequired: false,
  };
}

export function blockedClawPluginPlan(
  operation: "add" | "update" = "add",
): ClawLifecyclePlanResult {
  return {
    ...clawPlan(operation),
    blockers: [
      {
        code: "plugin_consent_unavailable",
        path: "$.packages[0]",
        message: "Plugin capability consent is not available through the Claws Control UI.",
      },
    ],
  };
}
