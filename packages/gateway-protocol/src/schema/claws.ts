// Gateway Protocol schema module defines secret-safe Claw lifecycle inventory payloads.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const ClawLifecycleStateSchema = Type.Union([
  Type.Literal("present"),
  Type.Literal("unchanged"),
  Type.Literal("complete"),
  Type.Literal("modified"),
  Type.Literal("missing"),
  Type.Literal("unsafe"),
  Type.Literal("ambiguous"),
  Type.Literal("incomplete"),
  Type.Literal("pending"),
  Type.Literal("failed"),
  Type.Literal("removed"),
]);

const ClawRelationshipSchema = Type.Union([Type.Literal("managed"), Type.Literal("referenced")]);

const ClawOriginSchema = Type.Union([
  Type.Literal("claw-introduced"),
  Type.Literal("pre-existing"),
]);

export const ClawsStatusParamsSchema = closedObject({
  target: Type.Optional(NonEmptyString),
});

export const ClawsDoctorParamsSchema = closedObject({});

export const ClawResourceStatusSchema = closedObject({
  kind: Type.Union([
    Type.Literal("agent"),
    Type.Literal("workspace-file"),
    Type.Literal("skill"),
    Type.Literal("plugin"),
    Type.Literal("mcp-server"),
    Type.Literal("cron-job"),
  ]),
  id: NonEmptyString,
  state: ClawLifecycleStateSchema,
  relationship: Type.Optional(ClawRelationshipSchema),
  origin: Type.Optional(ClawOriginSchema),
  independentOwner: Type.Optional(Type.Boolean()),
});

export const ClawStatusEntrySchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
  version: NonEmptyString,
  sourceKind: Type.Union([Type.Literal("package"), Type.Literal("development")]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("workspace_ready"),
    Type.Literal("config_committed"),
    Type.Literal("complete"),
    Type.Literal("partial"),
  ]),
  agentState: Type.Union([
    Type.Literal("present"),
    Type.Literal("modified"),
    Type.Literal("missing"),
  ]),
  bootstrapState: Type.Union([
    Type.Literal("missing"),
    Type.Literal("pending"),
    Type.Literal("complete"),
    Type.Literal("modified"),
    Type.Literal("unsafe"),
    Type.Literal("unknown"),
  ]),
  orphaned: Type.Boolean(),
  addedAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  resources: Type.Array(ClawResourceStatusSchema),
});

export const ClawsStatusResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayStatus.v1"),
  records: Type.Array(ClawStatusEntrySchema),
  summary: closedObject({
    claws: Type.Integer({ minimum: 0 }),
    healthy: Type.Integer({ minimum: 0 }),
    attention: Type.Integer({ minimum: 0 }),
    managed: Type.Integer({ minimum: 0 }),
    referenced: Type.Integer({ minimum: 0 }),
  }),
});

export const ClawDoctorFindingSchema = closedObject({
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: NonEmptyString,
  path: Type.Optional(NonEmptyString),
  requirement: Type.Optional(NonEmptyString),
  fixHint: Type.Optional(NonEmptyString),
});

export const ClawsDoctorResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayDoctor.v1"),
  findings: Type.Array(ClawDoctorFindingSchema),
  summary: closedObject({
    info: Type.Integer({ minimum: 0 }),
    warnings: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
  }),
});

const ClawCatalogCoordinateSchema = closedObject({
  packageName: NonEmptyString,
  version: NonEmptyString,
});

export const ClawsCatalogDetailParamsSchema = closedObject({
  packageName: NonEmptyString,
  version: Type.Optional(NonEmptyString),
});

export const ClawCatalogDetailSchema = closedObject({
  packageName: NonEmptyString,
  displayName: NonEmptyString,
  summary: Type.Optional(NonEmptyString),
  channel: Type.Union([
    Type.Literal("official"),
    Type.Literal("community"),
    Type.Literal("private"),
  ]),
  official: Type.Boolean(),
  version: NonEmptyString,
  publisher: Type.Optional(NonEmptyString),
  agentName: Type.Optional(NonEmptyString),
  agentDescription: Type.Optional(NonEmptyString),
  workspaceFiles: Type.Integer({ minimum: 0 }),
  skills: Type.Integer({ minimum: 0 }),
  plugins: Type.Integer({ minimum: 0 }),
  mcpServers: Type.Integer({ minimum: 0 }),
  scheduledJobs: Type.Integer({ minimum: 0 }),
  scanStatus: Type.Optional(NonEmptyString),
});

export const ClawsCatalogDetailResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsCatalogDetail.v1"),
  detail: ClawCatalogDetailSchema,
});

export const ClawsAddPlanParamsSchema = closedObject({
  source: ClawCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
});

export const ClawsAddApplyParamsSchema = closedObject({
  source: ClawCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
});

export const ClawsUpdatePlanParamsSchema = closedObject({
  target: NonEmptyString,
  source: Type.Optional(ClawCatalogCoordinateSchema),
});

export const ClawsUpdateApplyParamsSchema = closedObject({
  target: NonEmptyString,
  source: Type.Optional(ClawCatalogCoordinateSchema),
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
});

export const ClawsRemovePlanParamsSchema = closedObject({
  target: NonEmptyString,
  removeUnused: Type.Optional(Type.Boolean()),
});

export const ClawsRemoveApplyParamsSchema = closedObject({
  target: NonEmptyString,
  removeUnused: Type.Optional(Type.Boolean()),
  planIntegrity: NonEmptyString,
});

const ClawMemorySourceSchema = Type.Union([Type.Literal("memory"), Type.Literal("sessions")]);

const ClawConfiguredPermissionsSchema = closedObject({
  tools: closedObject({
    allowed: Type.Array(NonEmptyString),
    excluded: Type.Array(NonEmptyString),
  }),
  sandbox: closedObject({
    mode: Type.Union([Type.Literal("off"), Type.Literal("non-main"), Type.Literal("all")]),
    scope: Type.Union([Type.Literal("session"), Type.Literal("agent"), Type.Literal("shared")]),
    workspaceAccess: Type.Union([Type.Literal("none"), Type.Literal("ro"), Type.Literal("rw")]),
    backend: Type.Union([Type.Literal("docker"), Type.Literal("ssh"), Type.Literal("other")]),
  }),
  filesystem: closedObject({ workspaceOnly: Type.Boolean() }),
  heartbeat: closedObject({
    enabled: Type.Boolean(),
    intervalMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
  memorySearch: Type.Union([
    closedObject({ state: Type.Literal("disabled") }),
    closedObject({ state: Type.Literal("unresolved") }),
    closedObject({
      state: Type.Literal("configured"),
      rememberAcrossConversations: Type.Boolean(),
      sessionMemory: Type.Boolean(),
      indexedSources: Type.Array(ClawMemorySourceSchema),
      searchSources: Type.Array(ClawMemorySourceSchema),
      extraPathCount: Type.Integer({ minimum: 0 }),
    }),
  ]),
  subagentTargets: closedObject({
    explicitAgentIds: Type.Array(NonEmptyString),
    allowAnyConfiguredAgent: Type.Boolean(),
    implicitSelfAllowed: Type.Boolean(),
    requireAgentId: Type.Boolean(),
  }),
});

export const ClawPermissionDisclosureSchema = closedObject({
  coverage: Type.Literal("configuration-only"),
  current: Type.Optional(ClawConfiguredPermissionsSchema),
  desired: Type.Optional(ClawConfiguredPermissionsSchema),
  unresolved: Type.Array(
    Type.Union([
      Type.Literal("runtime-tools"),
      Type.Literal("sandbox-runtime"),
      Type.Literal("memory"),
      Type.Literal("delegation"),
      Type.Literal("scheduled-jobs"),
      Type.Literal("current-agent"),
      Type.Literal("target-agent"),
    ]),
  ),
});

export type ClawConfiguredPermissions = Static<typeof ClawConfiguredPermissionsSchema>;
export type ClawPermissionDisclosure = Static<typeof ClawPermissionDisclosureSchema>;

const ClawScheduledDeclarationSchema = closedObject({
  schedule: closedObject({ cron: NonEmptyString, timezone: NonEmptyString }),
  session: Type.Union([Type.Literal("main"), Type.Literal("isolated")]),
  delivery: Type.Union([Type.Literal("none"), Type.Literal("last-channel")]),
});

export const ClawScheduledJobDisclosureSchema = closedObject({
  coverage: Type.Literal("package-declarations"),
  jobs: Type.Array(
    closedObject({
      id: NonEmptyString,
      action: Type.Union([
        Type.Literal("schedule"),
        Type.Literal("add"),
        Type.Literal("change"),
        Type.Literal("remove"),
        Type.Literal("release"),
        Type.Literal("unchanged"),
        Type.Literal("manual"),
      ]),
      blocked: Type.Boolean(),
      recorded: Type.Optional(
        Type.Union([
          closedObject({ state: Type.Literal("unresolved") }),
          closedObject({
            state: Type.Literal("declared"),
            job: ClawScheduledDeclarationSchema,
            status: Type.Union([
              Type.Literal("pending"),
              Type.Literal("complete"),
              Type.Literal("failed"),
              Type.Literal("removed"),
            ]),
            schedulerIdRecorded: Type.Boolean(),
          }),
        ]),
      ),
      proposed: Type.Optional(ClawScheduledDeclarationSchema),
    }),
  ),
});

export type ClawScheduledJobDisclosure = Static<typeof ClawScheduledJobDisclosureSchema>;

export const ClawLifecyclePlanResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayPlan.v1"),
  operation: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
  planIntegrity: NonEmptyString,
  target: closedObject({
    agentId: Type.Optional(NonEmptyString),
    name: Type.Optional(NonEmptyString),
    publisher: Type.Optional(NonEmptyString),
    currentVersion: Type.Optional(NonEmptyString),
    targetVersion: Type.Optional(NonEmptyString),
  }),
  actions: Type.Array(
    closedObject({
      kind: NonEmptyString,
      id: NonEmptyString,
      action: NonEmptyString,
      blocked: Type.Boolean(),
      reason: Type.Optional(NonEmptyString),
    }),
  ),
  capabilities: Type.Array(
    closedObject({
      kind: NonEmptyString,
      id: NonEmptyString,
      action: NonEmptyString,
      reason: NonEmptyString,
    }),
  ),
  blockers: Type.Array(
    closedObject({
      code: NonEmptyString,
      path: NonEmptyString,
      message: NonEmptyString,
    }),
  ),
  trustWarning: Type.Optional(NonEmptyString),
  riskAcknowledgementRequired: Type.Boolean(),
  effectivePermissions: Type.Optional(ClawPermissionDisclosureSchema),
  scheduledJobs: Type.Optional(ClawScheduledJobDisclosureSchema),
  readiness: Type.Optional(
    closedObject({
      ready: Type.Boolean(),
      requirements: Type.Array(
        closedObject({
          kind: Type.Union([
            Type.Literal("environment"),
            Type.Literal("oauth"),
            Type.Literal("plugin-setup"),
          ]),
          owner: NonEmptyString,
        }),
      ),
    }),
  ),
});

export const ClawLifecycleApplyResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayApply.v1"),
  operation: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
  agentId: NonEmptyString,
  message: NonEmptyString,
});

export type ClawsStatusParams = Static<typeof ClawsStatusParamsSchema>;
export type ClawsDoctorParams = Static<typeof ClawsDoctorParamsSchema>;
export type ClawResourceStatus = Static<typeof ClawResourceStatusSchema>;
export type ClawStatusEntry = Static<typeof ClawStatusEntrySchema>;
export type ClawsStatusResult = Static<typeof ClawsStatusResultSchema>;
export type ClawDoctorFinding = Static<typeof ClawDoctorFindingSchema>;
export type ClawsDoctorResult = Static<typeof ClawsDoctorResultSchema>;
export type ClawsCatalogDetailParams = Static<typeof ClawsCatalogDetailParamsSchema>;
export type ClawCatalogDetail = Static<typeof ClawCatalogDetailSchema>;
export type ClawsCatalogDetailResult = Static<typeof ClawsCatalogDetailResultSchema>;
export type ClawsAddPlanParams = Static<typeof ClawsAddPlanParamsSchema>;
export type ClawsAddApplyParams = Static<typeof ClawsAddApplyParamsSchema>;
export type ClawsUpdatePlanParams = Static<typeof ClawsUpdatePlanParamsSchema>;
export type ClawsUpdateApplyParams = Static<typeof ClawsUpdateApplyParamsSchema>;
export type ClawsRemovePlanParams = Static<typeof ClawsRemovePlanParamsSchema>;
export type ClawsRemoveApplyParams = Static<typeof ClawsRemoveApplyParamsSchema>;
export type ClawLifecyclePlanResult = Static<typeof ClawLifecyclePlanResultSchema>;
export type ClawLifecycleApplyResult = Static<typeof ClawLifecycleApplyResultSchema>;
