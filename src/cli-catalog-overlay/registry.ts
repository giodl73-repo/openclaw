import type { NamedCommandDescriptor } from "../cli/program/command-group-descriptors.js";
import { getCoreCliCommandDescriptors } from "../cli/program/core-command-descriptors.js";
import { getSubCliEntries } from "../cli/program/subcli-descriptors.js";
import type {
  CliCatalogDispatchMode,
  CliCatalogEffectMode,
  CliCatalogRisk,
  CliCatalogSurfaceKind,
  CliCatalogSurfaceStatus,
  CliCatalogVisibility,
} from "../cli/catalog-metadata.js";
export type {
  CliCatalogDispatchMode,
  CliCatalogEffectMode,
  CliCatalogRisk,
  CliCatalogSurfaceKind,
  CliCatalogSurfaceStatus,
  CliCatalogVisibility,
} from "../cli/catalog-metadata.js";

export type CliCatalogSourceKind =
  | "core"
  | "subcli"
  | "route-policy"
  | "explicit-overlay"
  | "runtime"
  | "plugin";
export type CliCatalogDiscoveryMode =
  | "static-descriptor"
  | "route-policy"
  | "explicit-overlay"
  | "runtime-registered"
  | "plugin-descriptor";

export type CliCatalogSurfaceDefinition = {
  readonly id: string;
  readonly title: string;
  readonly kind: CliCatalogSurfaceKind;
  readonly dispatchMode: CliCatalogDispatchMode;
  readonly target: string;
  readonly source: string;
  readonly sourceKind: CliCatalogSourceKind;
  readonly sourceId: string;
  readonly discoveryMode: CliCatalogDiscoveryMode;
  readonly visibility: readonly CliCatalogVisibility[];
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

function surfaceFromDescriptor(
  descriptor: NamedCommandDescriptor,
  sourceKind: "core" | "subcli",
): CliCatalogSurfaceDefinition | undefined {
  const catalog = descriptor.catalog;
  if (!catalog) {
    return undefined;
  }
  return {
    id: catalog.id ?? descriptor.name,
    title: catalog.title ?? descriptor.description,
    kind: catalog.kind ?? "command",
    dispatchMode: catalog.dispatchMode ?? "direct",
    target: catalog.target ?? descriptor.name,
    source: `CLI descriptor: ${descriptor.name}`,
    sourceKind,
    sourceId: descriptor.name,
    discoveryMode: "static-descriptor",
    visibility: catalog.visibility ?? ["docs", "audit", "operator", "policy"],
    intent: catalog.intent ?? descriptor.description,
    examples: catalog.examples ?? [],
    aliases: catalog.aliases ?? [],
    owner: catalog.owner ?? "cli",
    status: catalog.status ?? "stable",
    confidence: catalog.confidence ?? "high",
    risk: catalog.risk ?? "low",
    confirmationRequired: catalog.confirmationRequired ?? false,
    effectMode: catalog.effectMode ?? "read",
    effects: catalog.effects ?? [],
    commandHints: catalog.commandHints ?? [descriptor.name],
    cliDescriptor: descriptor,
  };
}

function listDescriptorCatalogSurfaces(): readonly CliCatalogSurfaceDefinition[] {
  return [
    ...getCoreCliCommandDescriptors().flatMap((descriptor) => {
      const surface = surfaceFromDescriptor(descriptor, "core");
      return surface ? [surface] : [];
    }),
    ...getSubCliEntries().flatMap((descriptor) => {
      const surface = surfaceFromDescriptor(descriptor, "subcli");
      return surface ? [surface] : [];
    }),
  ];
}

const CLI_CATALOG_ADAPTER_SURFACES: readonly CliCatalogSurfaceDefinition[] = [
  {
    id: "skill_workshop",
    title: "Skill Workshop proposals",
    kind: "tool",
    dispatchMode: "metadata-first",
    target: "skill_workshop",
    source: "existing skill_workshop tool and prompt guidance",
    sourceKind: "explicit-overlay",
    sourceId: "skill_workshop",
    discoveryMode: "explicit-overlay",
    visibility: ["docs", "prompt", "audit", "operator", "policy"],
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
    sourceKind: "explicit-overlay",
    sourceId: "session_status",
    discoveryMode: "explicit-overlay",
    visibility: ["docs", "prompt", "audit", "operator", "policy"],
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
    sourceKind: "explicit-overlay",
    sourceId: "sessions_spawn",
    discoveryMode: "explicit-overlay",
    visibility: ["docs", "prompt", "audit", "operator", "policy"],
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
    sourceKind: "explicit-overlay",
    sourceId: "process",
    discoveryMode: "explicit-overlay",
    visibility: ["docs", "prompt", "audit", "operator", "policy"],
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
] as const;

export function listCliCatalogSurfaces(): readonly CliCatalogSurfaceDefinition[] {
  return [...CLI_CATALOG_ADAPTER_SURFACES, ...listDescriptorCatalogSurfaces()];
}

export function getCliCatalogSurface(
  surfaceId: string,
): CliCatalogSurfaceDefinition | undefined {
  return listCliCatalogSurfaces().find((surface) => surface.id === surfaceId);
}
