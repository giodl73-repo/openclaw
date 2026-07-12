import type { ContinuityLevel, OpenClawConfig } from "../config/types.js";

export const CONTINUITY_MODEL_VERSION = 1 as const;

export const CONTINUITY_LEVELS = [
  "conventional",
  "archived",
  "portable",
  "elastic",
] as const satisfies readonly ContinuityLevel[];

export type ContinuityStateTreatment = "captured" | "reconstructed" | "external" | "ephemeral";

export type ContinuityStateOwner = "openclaw" | "host";

export type ContinuityStateSurfaceDescriptor = {
  id: string;
  description: string;
  owner: ContinuityStateOwner;
  treatment: ContinuityStateTreatment;
  sensitive: boolean;
};

const CORE_STATE_SURFACES = [
  {
    id: "config",
    description: "Effective OpenClaw configuration and source fragments",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "shared-state",
    description: "Shared transactional runtime state",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "agent-state",
    description: "Per-agent transactional state and memory indexes",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "sessions-transcripts",
    description: "Session metadata, transcript events, and compatibility artifacts",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "plugin-state",
    description: "Plugin-owned state persisted through the core state service",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "schedule-state",
    description: "Cron definitions and durable scheduler state",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "workspace",
    description: "Agent workspace files selected for continuity",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "runtime-identity",
    description: "Runtime-owned identity, pairing, and authorization material",
    owner: "openclaw",
    treatment: "captured",
    sensitive: true,
  },
  {
    id: "host-dependencies",
    description: "Host credentials, placement bindings, and publication service",
    owner: "host",
    treatment: "external",
    sensitive: true,
  },
  {
    id: "derived-state",
    description: "Caches and indexes that can be rebuilt from authoritative inputs",
    owner: "openclaw",
    treatment: "reconstructed",
    sensitive: false,
  },
  {
    id: "runtime-transients",
    description: "Locks, sockets, process identifiers, and temporary files",
    owner: "openclaw",
    treatment: "ephemeral",
    sensitive: false,
  },
] as const satisfies readonly ContinuityStateSurfaceDescriptor[];

export type ContinuityCapabilityMaturity = "available" | "planned";

export type ContinuityCapabilityStatus = {
  level: ContinuityLevel;
  maturity: ContinuityCapabilityMaturity;
};

export type ContinuityStatusReason = {
  code:
    | "continuity.archived.not_implemented"
    | "continuity.portable.not_implemented"
    | "continuity.elastic.not_implemented";
  message: string;
};

export type ContinuityStatus = {
  version: typeof CONTINUITY_MODEL_VERSION;
  desiredLevel: ContinuityLevel;
  effectiveLevel: ContinuityLevel;
  capabilities: ContinuityCapabilityStatus[];
  reasons: ContinuityStatusReason[];
  inventory: ContinuityStateSurfaceDescriptor[];
};

const PLANNED_REASON_BY_LEVEL = {
  archived: {
    code: "continuity.archived.not_implemented",
    message: "Archived checkpoint publication and restore are not implemented.",
  },
  portable: {
    code: "continuity.portable.not_implemented",
    message: "Portable final handoff and fresh-compute restore are not implemented.",
  },
  elastic: {
    code: "continuity.elastic.not_implemented",
    message: "Elastic hibernate and wake are not implemented.",
  },
} as const satisfies Record<Exclude<ContinuityLevel, "conventional">, ContinuityStatusReason>;

/** Returns the stable, path-free inventory consumed by continuity providers. */
export function listContinuityStateSurfaces(): ContinuityStateSurfaceDescriptor[] {
  return CORE_STATE_SURFACES.map((surface) => ({ ...surface }));
}

/**
 * Projects configured intent separately from proven runtime capability.
 *
 * PR 1 intentionally proves only Conventional behavior. A stronger configured
 * level therefore remains visible as desired intent without changing runtime
 * behavior or overstating recoverability.
 */
export function resolveContinuityStatus(cfg: OpenClawConfig): ContinuityStatus {
  const desiredLevel = cfg.continuity?.level ?? "conventional";
  return {
    version: CONTINUITY_MODEL_VERSION,
    desiredLevel,
    effectiveLevel: "conventional",
    capabilities: CONTINUITY_LEVELS.map((level) => ({
      level,
      maturity: level === "conventional" ? "available" : "planned",
    })),
    reasons: desiredLevel === "conventional" ? [] : [PLANNED_REASON_BY_LEVEL[desiredLevel]],
    inventory: listContinuityStateSurfaces(),
  };
}
