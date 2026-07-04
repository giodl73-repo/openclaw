import type { NamedCommandDescriptor } from "../cli/program/command-group-descriptors.js";
import { getCoreCliCommandDescriptors } from "../cli/program/core-command-descriptors.js";
import { getSubCliEntries } from "../cli/program/subcli-descriptors.js";

export type CliCatalogSurfaceId =
  | "skill_workshop"
  | "session_status"
  | "sessions_spawn"
  | "process"
  | "gateway";

export type CliCatalogSurfaceKind = "tool" | "command" | "workflow";
export type CliCatalogDispatchMode = "direct" | "metadata-first" | "hybrid";
export type CliCatalogRisk = "low" | "medium" | "high";
export type CliCatalogSurfaceStatus = "draft" | "stable" | "deprecated";
export type CliCatalogEffectMode = "read" | "mutating" | "mixed";

export type CliCatalogSurfaceDefinition = {
  readonly id: CliCatalogSurfaceId;
  readonly title: string;
  readonly kind: CliCatalogSurfaceKind;
  readonly dispatchMode: CliCatalogDispatchMode;
  readonly target: string;
  readonly source: string;
  readonly intent: string;
  readonly examples: readonly string[];
  readonly aliases: readonly string[];
  readonly owner: string;
  readonly status: CliCatalogSurfaceStatus;
  readonly confidence: "low" | "medium" | "high";
  readonly risk: CliCatalogRisk;
  readonly confirmationRequired: boolean;
  readonly effectMode: CliCatalogEffectMode;
  readonly effects: readonly string[];
  readonly commandHints: readonly string[];
  readonly cliDescriptor?: NamedCommandDescriptor;
};

type CliCatalogSurfaceInput = Omit<CliCatalogSurfaceDefinition, "cliDescriptor"> & {
  readonly cliDescriptorName?: string;
};

function getCliDescriptors(): readonly NamedCommandDescriptor[] {
  return [...getCoreCliCommandDescriptors(), ...getSubCliEntries()];
}

function findCliDescriptor(name: string): NamedCommandDescriptor {
  const descriptor = getCliDescriptors().find((entry) => entry.name === name);
  if (!descriptor) {
    throw new Error(`Missing CLI descriptor for catalog overlay surface: ${name}`);
  }
  return descriptor;
}

function defineCliCatalogSurface(input: CliCatalogSurfaceInput): CliCatalogSurfaceDefinition {
  const { cliDescriptorName, ...surface } = input;
  if (!cliDescriptorName) {
    return surface;
  }
  const descriptor = findCliDescriptor(cliDescriptorName);
  return {
    ...surface,
    source: `CLI descriptor: ${descriptor.name}`,
    target: descriptor.name,
    intent: surface.intent || descriptor.description,
    cliDescriptor: descriptor,
  };
}

const CLI_CATALOG_SURFACES: readonly CliCatalogSurfaceDefinition[] = [
  {
    id: "skill_workshop",
    title: "Skill Workshop proposals",
    kind: "tool",
    dispatchMode: "metadata-first",
    target: "skill_workshop",
    source: "existing skill_workshop tool and prompt guidance",
    intent: "Create, revise, apply, reject, or quarantine durable skill proposals.",
    examples: ["create a reusable skill", "reject a pending skill proposal"],
    aliases: ["skill workshop", "skill proposals"],
    owner: "agents",
    status: "stable",
    confidence: "high",
    risk: "medium",
    confirmationRequired: true,
    effectMode: "mixed",
    effects: ["proposal.lifecycle"],
    commandHints: [
      "skill_workshop action=create|update|revise",
      "skill_workshop action=apply|reject|quarantine",
    ],
  },
  {
    id: "session_status",
    title: "Session status",
    kind: "tool",
    dispatchMode: "direct",
    target: "session_status",
    source: "existing session_status command",
    intent: "Report the current session state and model-use status.",
    examples: ["what model am I using", "show session status"],
    aliases: ["status", "session status"],
    owner: "agents",
    status: "stable",
    confidence: "high",
    risk: "low",
    confirmationRequired: false,
    effectMode: "read",
    effects: ["session.status"],
    commandHints: ["session_status"],
  },
  {
    id: "sessions_spawn",
    title: "Sub-agent spawn",
    kind: "tool",
    dispatchMode: "hybrid",
    target: "sessions_spawn",
    source: "existing sessions_spawn command and delegation guidance",
    intent:
      "Delegate work to a sub-agent or ACP session when the task is broader than a direct reply.",
    examples: ["delegate file review", "spawn a sub-agent for debugging"],
    aliases: ["spawn", "delegate"],
    owner: "agents",
    status: "stable",
    confidence: "high",
    risk: "low",
    confirmationRequired: false,
    effectMode: "mutating",
    effects: ["delegation.spawn"],
    commandHints: ["sessions_spawn"],
  },
  {
    id: "process",
    title: "Process control",
    kind: "command",
    dispatchMode: "direct",
    target: "process",
    source: "existing process command surface",
    intent: "Inspect and manage active exec/process work.",
    examples: ["show process logs", "poll a running command"],
    aliases: ["proc", "running process"],
    owner: "agents",
    status: "stable",
    confidence: "high",
    risk: "low",
    confirmationRequired: false,
    effectMode: "mixed",
    effects: ["process.lifecycle"],
    commandHints: ["process list", "process poll", "process log", "process write"],
  },
  defineCliCatalogSurface({
    id: "gateway",
    title: "Gateway control",
    kind: "command",
    dispatchMode: "hybrid",
    cliDescriptorName: "gateway",
    target: "gateway",
    source: "",
    intent: "Inspect, reconfigure, or restart the OpenClaw gateway.",
    examples: ["restart the gateway", "inspect gateway config"],
    aliases: ["gateway", "restart gateway"],
    owner: "runtime",
    status: "stable",
    confidence: "high",
    risk: "medium",
    confirmationRequired: true,
    effectMode: "mixed",
    effects: ["gateway.restart", "gateway.config"],
    commandHints: [
      "gateway status",
      "gateway restart",
      "gateway config.schema.lookup",
      "gateway config.apply",
    ],
  }),
] as const;

export function listCliCatalogSurfaces(): readonly CliCatalogSurfaceDefinition[] {
  return CLI_CATALOG_SURFACES;
}

export function getCliCatalogSurface(
  surfaceId: CliCatalogSurfaceId,
): CliCatalogSurfaceDefinition | undefined {
  return CLI_CATALOG_SURFACES.find((surface) => surface.id === surfaceId);
}
