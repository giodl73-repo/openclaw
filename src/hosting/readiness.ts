import type { GatewayBindMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackHost } from "../gateway/net.js";

export const HOSTING_PROFILE_IDS = ["local", "container", "reverse-proxy", "node-mode"] as const;
export type BuiltInHostingProfileId = (typeof HOSTING_PROFILE_IDS)[number];
export type HostingProfileId = string;

export const DEFAULT_HOSTING_PROFILE: BuiltInHostingProfileId = "local";
export const HOSTING_PROFILE_ENV = "OPENCLAW_HOSTING_PROFILE";
export const CUSTOM_HOSTING_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export const BUILT_IN_HOSTING_PROFILE_CRITERIA: Record<
  BuiltInHostingProfileId,
  readonly BuiltInHostingReadinessCriterionId[]
> = {
  local: [],
  container: ["ContainerStateReady"],
  "reverse-proxy": ["TrustedProxyReady"],
  "node-mode": [
    "NodePairingReady",
    "ControlledTargetsReady",
    "CommandApprovalReady",
    "ControlChannelReady",
  ],
};

export type BuiltInHostingReadinessCriterionId =
  | "GatewayStartupComplete"
  | "GatewayAcceptingWork"
  | "ChannelRuntimeReady"
  | "ChannelRuntimeSuppressed"
  | "EventLoopHealthy"
  | "ProfileSelected"
  | "ConfigLoaded"
  | "WorkspaceWritable"
  | "GatewayResponding"
  | "PluginsLoaded"
  | "ContainerStateReady"
  | "TrustedProxyReady"
  | "NodePairingReady"
  | "ControlledTargetsReady"
  | "CommandApprovalReady"
  | "ControlChannelReady";
export type HostingReadinessConditionType = BuiltInHostingReadinessCriterionId | (string & {});

export type HostingReadinessConditionStatus = "True" | "False" | "Unknown";
export type HostingReadinessRequirement = "required" | "advisory";

export type HostingReadinessCondition = {
  type: HostingReadinessConditionType;
  status: HostingReadinessConditionStatus;
  requirement: HostingReadinessRequirement;
  reason: string;
  message: string;
};

export type HostingReadinessResult = {
  profile: HostingProfileId;
  ready: boolean;
  conditions: HostingReadinessCondition[];
  failures: string[];
  advisories: string[];
};

export type HostingPluginReadinessInput = {
  errors: Array<{
    id: string;
    activated?: boolean;
    activationSource?: string;
    error?: string;
  }>;
};

export type NodeModeReadinessEvidence = {
  pairing?: {
    pairedCount: number;
    pendingCount: number;
    error?: string;
    timedOut?: boolean;
  };
  targets?: {
    knownCount: number;
    connectedCount: number;
  };
  commandApproval?: {
    configured: boolean;
    approvedCommandCount: number;
  };
  controlChannel?: {
    connectedCount: number;
  };
};

export type WorkspaceReadinessEvidence = {
  writable: boolean | null;
  reason: string;
  message: string;
};

export type HostingReadinessInput = {
  profile?: HostingProfileId;
  config?: OpenClawConfig;
  configLoaded: boolean;
  gateway: "responding" | "not-checked" | "unavailable";
  plugins?: HostingPluginReadinessInput;
  coreConditions?: HostingReadinessCondition[];
  workspaceProbeExpected?: boolean;
  workspace?: WorkspaceReadinessEvidence;
  runtimeGateway?: {
    mode: "local";
    bind: GatewayBindMode;
    bindHost: string;
    port: number;
    authMode: string;
    trustedProxyUserHeader?: string;
    trustedProxyCount: number;
  };
  nodeMode?: NodeModeReadinessEvidence;
  additionalConditions?: HostingReadinessCondition[];
};

export function buildUnobservedGatewayConditions(): HostingReadinessCondition[] {
  return [
    {
      type: "GatewayStartupComplete",
      status: "Unknown",
      requirement: "required",
      reason: "GatewayStartupNotChecked",
      message: "This surface did not observe Gateway startup state.",
    },
    {
      type: "GatewayAcceptingWork",
      status: "Unknown",
      requirement: "required",
      reason: "GatewayAdmissionNotChecked",
      message: "This surface did not observe Gateway drain state.",
    },
    {
      type: "ChannelRuntimeReady",
      status: "Unknown",
      requirement: "required",
      reason: "ChannelRuntimeNotChecked",
      message: "This surface did not observe Gateway channel runtime state.",
    },
    {
      type: "EventLoopHealthy",
      status: "Unknown",
      requirement: "advisory",
      reason: "EventLoopStatusUnavailable",
      message: "This surface did not observe Gateway event-loop health.",
    },
  ];
}

export function parseHostingProfileId(value: unknown): BuiltInHostingProfileId | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return HOSTING_PROFILE_IDS.includes(normalized as BuiltInHostingProfileId)
    ? (normalized as BuiltInHostingProfileId)
    : null;
}

export function parseHostingProfileName(value: unknown): HostingProfileId | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (parseHostingProfileId(normalized)) {
    return normalized;
  }
  return CUSTOM_HOSTING_PROFILE_PATTERN.test(normalized) ? normalized : null;
}

export function formatHostingProfileIds(): string {
  return HOSTING_PROFILE_IDS.map((profile) => `"${profile}"`).join(", ");
}

function resolveExplicitHostingProfile(
  value: unknown,
  source: string,
  config?: OpenClawConfig,
): HostingProfileId | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = parseHostingProfileName(value);
  if (!normalized) {
    throw new Error(
      `Invalid hosting profile from ${source}: ${JSON.stringify(value)}. Expected ${formatHostingProfileIds()}.`,
    );
  }
  const builtIn = parseHostingProfileId(normalized);
  if (builtIn) {
    return builtIn;
  }
  if (config?.hosting?.profiles?.[normalized]) {
    return normalized;
  }
  throw new Error(
    `Invalid hosting profile from ${source}: ${JSON.stringify(value)}. Expected a built-in profile (${formatHostingProfileIds()}) or a profile defined in hosting.profiles.`,
  );
}

export function resolveHostingProfile(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    override?: unknown;
  } = {},
): HostingProfileId {
  return (
    resolveExplicitHostingProfile(params.override, "gateway startup override", params.config) ??
    resolveExplicitHostingProfile(
      params.env?.[HOSTING_PROFILE_ENV],
      HOSTING_PROFILE_ENV,
      params.config,
    ) ??
    resolveExplicitHostingProfile(
      params.config?.hosting?.profile,
      "hosting.profile",
      params.config,
    ) ??
    DEFAULT_HOSTING_PROFILE
  );
}

export function resolveBuiltInHostingProfile(
  profile: HostingProfileId,
  config?: OpenClawConfig,
): BuiltInHostingProfileId {
  return (
    config?.hosting?.profiles?.[profile]?.extends ??
    parseHostingProfileId(profile) ??
    DEFAULT_HOSTING_PROFILE
  );
}

function resolvePluginFailures(plugins: HostingPluginReadinessInput): string[] {
  return plugins.errors
    .filter((entry) => entry.activated === true || entry.activationSource !== "disabled")
    .map((entry) =>
      entry.error ? `${entry.id}: ${entry.error}` : `${entry.id}: plugin load failed`,
    );
}

function buildPluginCondition(
  plugins: HostingPluginReadinessInput | undefined,
): HostingReadinessCondition {
  if (!plugins) {
    return {
      type: "PluginsLoaded",
      status: "Unknown",
      requirement: "advisory",
      reason: "PluginStatusUnavailable",
      message: "Plugin registry status is not available on this surface.",
    };
  }
  const failures = resolvePluginFailures(plugins);
  return {
    type: "PluginsLoaded",
    status: failures.length === 0 ? "True" : "False",
    requirement: "advisory",
    reason: failures.length === 0 ? "PluginsLoaded" : "PluginLoadFailures",
    message:
      failures.length === 0
        ? "Selected plugins loaded without activation errors."
        : `Plugin load failures: ${failures.join("; ")}`,
  };
}

function buildGatewayCondition(
  gateway: HostingReadinessInput["gateway"],
): HostingReadinessCondition {
  if (gateway === "responding") {
    return {
      type: "GatewayResponding",
      status: "True",
      requirement: "required",
      reason: "GatewayResponding",
      message: "Gateway accepted the readiness request.",
    };
  }
  if (gateway === "unavailable") {
    return {
      type: "GatewayResponding",
      status: "False",
      requirement: "required",
      reason: "GatewayUnavailable",
      message: "Gateway did not respond to the readiness request.",
    };
  }
  return {
    type: "GatewayResponding",
    status: "Unknown",
    requirement: "required",
    reason: "GatewayNotChecked",
    message: "This status surface did not probe the running Gateway.",
  };
}

function buildWorkspaceCondition(
  workspace: WorkspaceReadinessEvidence | undefined,
): HostingReadinessCondition {
  if (!workspace) {
    return {
      type: "WorkspaceWritable",
      status: "Unknown",
      requirement: "required",
      reason: "WorkspaceNotChecked",
      message: "The running Gateway has not published workspace write evidence.",
    };
  }
  return {
    type: "WorkspaceWritable",
    status: workspace.writable === null ? "Unknown" : workspace.writable ? "True" : "False",
    requirement: "required",
    reason: workspace.reason,
    message: workspace.message,
  };
}

function buildContainerCondition(input: HostingReadinessInput): HostingReadinessCondition {
  const mode = input.runtimeGateway?.mode ?? input.config?.gateway?.mode ?? "local";
  if (mode !== "local") {
    return {
      type: "ContainerStateReady",
      status: "False",
      requirement: "required",
      reason: "ContainerGatewayRemote",
      message: "Container profile requires this process to host the Gateway locally.",
    };
  }
  const bind = input.runtimeGateway?.bind ?? input.config?.gateway?.bind ?? "loopback";
  const bindHost =
    input.runtimeGateway?.bindHost ??
    (bind === "custom" ? input.config?.gateway?.customBindHost?.trim() : undefined);
  if (bind === "loopback" || (bindHost && isLoopbackHost(bindHost))) {
    return {
      type: "ContainerStateReady",
      status: "False",
      requirement: "required",
      reason: "ContainerGatewayLoopback",
      message: "Container profile requires a non-loopback Gateway bind.",
    };
  }
  if (bind === "auto" && !bindHost) {
    return {
      type: "ContainerStateReady",
      status: "Unknown",
      requirement: "required",
      reason: "ContainerBindNotResolved",
      message: "Container profile requires the resolved Gateway bind host.",
    };
  }
  return {
    type: "ContainerStateReady",
    status: "True",
    requirement: "required",
    reason: "ContainerStateReady",
    message: `Gateway is hosted locally at ${bindHost ?? bind}:${input.runtimeGateway?.port ?? input.config?.gateway?.port ?? 18789}.`,
  };
}

function buildTrustedProxyCondition(input: HostingReadinessInput): HostingReadinessCondition {
  const auth = input.config?.gateway?.auth;
  const authMode = input.runtimeGateway?.authMode ?? auth?.mode;
  if (authMode !== "trusted-proxy") {
    return {
      type: "TrustedProxyReady",
      status: "False",
      requirement: "required",
      reason: "TrustedProxyAuthMissing",
      message: "Reverse-proxy profile requires gateway.auth.mode=trusted-proxy.",
    };
  }
  const userHeader =
    input.runtimeGateway?.trustedProxyUserHeader?.trim() ?? auth?.trustedProxy?.userHeader?.trim();
  if (!userHeader) {
    return {
      type: "TrustedProxyReady",
      status: "False",
      requirement: "required",
      reason: "TrustedProxyHeaderMissing",
      message: "Trusted-proxy auth requires a non-empty userHeader.",
    };
  }
  const trustedProxyCount =
    input.runtimeGateway?.trustedProxyCount ?? input.config?.gateway?.trustedProxies?.length ?? 0;
  if (trustedProxyCount === 0) {
    return {
      type: "TrustedProxyReady",
      status: "False",
      requirement: "required",
      reason: "TrustedProxySourcesMissing",
      message: "Reverse-proxy profile requires at least one trusted proxy address or CIDR.",
    };
  }
  return {
    type: "TrustedProxyReady",
    status: "True",
    requirement: "required",
    reason: "TrustedProxyReady",
    message: `Trusted-proxy auth accepts ${userHeader} from ${trustedProxyCount} configured source${trustedProxyCount === 1 ? "" : "s"}.`,
  };
}

function buildNodeModeConditions(
  evidence: NodeModeReadinessEvidence | undefined,
): HostingReadinessCondition[] {
  const pairing = evidence?.pairing;
  const pairedCount = pairing?.pairedCount ?? 0;
  const pendingCount = pairing?.pendingCount ?? 0;
  const connectedCount = evidence?.targets?.connectedCount ?? 0;
  const pairingCondition: HostingReadinessCondition = pairing?.error
    ? {
        type: "NodePairingReady",
        status: "Unknown",
        requirement: "required",
        reason: pairing.timedOut ? "NodePairingTimedOut" : "NodePairingUnavailable",
        message: `Node pairing state could not be read: ${pairing.error}`,
      }
    : pairedCount > 0
      ? {
          type: "NodePairingReady",
          status: "True",
          requirement: "required",
          reason: "NodePairingReady",
          message: `Node pairing has ${pairedCount} approved node${pairedCount === 1 ? "" : "s"}.`,
        }
      : {
          type: "NodePairingReady",
          status: "False",
          requirement: "required",
          reason: pendingCount > 0 ? "NodePairingPending" : "NodePairingMissing",
          message:
            pendingCount > 0
              ? `Node pairing has ${pendingCount} pending request${pendingCount === 1 ? "" : "s"} and no approved nodes.`
              : "Node-mode requires at least one approved node pairing.",
        };
  const targetCondition: HostingReadinessCondition =
    connectedCount > 0
      ? {
          type: "ControlledTargetsReady",
          status: "True",
          requirement: "required",
          reason: "ControlledTargetsReady",
          message: `${connectedCount} controlled target${connectedCount === 1 ? " is" : "s are"} connected.`,
        }
      : {
          type: "ControlledTargetsReady",
          status: "False",
          requirement: "required",
          reason: "ControlledTargetsDisconnected",
          message: "Node-mode requires at least one connected controlled target.",
        };
  const commandApproval = evidence?.commandApproval;
  const commandCondition: HostingReadinessCondition = commandApproval?.configured
    ? {
        type: "CommandApprovalReady",
        status: "True",
        requirement: "required",
        reason: "CommandApprovalReady",
        message:
          commandApproval.approvedCommandCount > 0
            ? `Pairing grants ${commandApproval.approvedCommandCount} approved command${commandApproval.approvedCommandCount === 1 ? "" : "s"}.`
            : "Gateway node allowCommands provides command approval posture.",
      }
    : {
        type: "CommandApprovalReady",
        status: "False",
        requirement: "required",
        reason: "CommandApprovalMissing",
        message: "Node-mode requires paired command grants or gateway.nodes.allowCommands.",
      };
  const controlConnectedCount = evidence?.controlChannel?.connectedCount ?? 0;
  const controlCondition: HostingReadinessCondition =
    controlConnectedCount > 0
      ? {
          type: "ControlChannelReady",
          status: "True",
          requirement: "required",
          reason: "ControlChannelReady",
          message: `${controlConnectedCount} node control channel${controlConnectedCount === 1 ? " is" : "s are"} connected.`,
        }
      : {
          type: "ControlChannelReady",
          status: "False",
          requirement: "required",
          reason: "ControlChannelUnavailable",
          message: "No node control channel is connected.",
        };
  return [pairingCondition, targetCondition, commandCondition, controlCondition];
}

export function buildHostingReadiness(input: HostingReadinessInput): HostingReadinessResult {
  const profile = input.profile ?? DEFAULT_HOSTING_PROFILE;
  const customProfile = input.config?.hosting?.profiles?.[profile];
  const builtInProfile = resolveBuiltInHostingProfile(profile, input.config);
  const conditionsById = new Map<HostingReadinessConditionType, HostingReadinessCondition>();
  const addCondition = (condition: HostingReadinessCondition) => {
    conditionsById.set(condition.type, condition);
  };
  for (const condition of input.coreConditions ?? []) {
    addCondition(condition);
  }
  const baseConditions: HostingReadinessCondition[] = [
    {
      type: "ProfileSelected",
      status: "True",
      requirement: "required",
      reason: "ProfileSelected",
      message: `Runtime selected the ${profile} hosting profile.`,
    },
    {
      type: "ConfigLoaded",
      status: input.configLoaded ? "True" : "False",
      requirement: "required",
      reason: input.configLoaded ? "ConfigLoaded" : "ConfigNotLoaded",
      message: input.configLoaded
        ? "Runtime configuration loaded."
        : "Runtime configuration was not loaded.",
    },
  ];
  for (const condition of baseConditions) {
    addCondition(condition);
  }
  if (input.workspaceProbeExpected || input.workspace) {
    addCondition(buildWorkspaceCondition(input.workspace));
  }
  addCondition(buildGatewayCondition(input.gateway));
  addCondition(buildPluginCondition(input.plugins));
  const profileCandidates = new Map<HostingReadinessConditionType, HostingReadinessCondition>();
  const profileConditions = [
    buildContainerCondition(input),
    buildTrustedProxyCondition(input),
    ...buildNodeModeConditions(input.nodeMode),
  ];
  for (const condition of profileConditions) {
    profileCandidates.set(condition.type, condition);
  }
  for (const criterionId of BUILT_IN_HOSTING_PROFILE_CRITERIA[builtInProfile]) {
    const condition = profileCandidates.get(criterionId);
    if (condition) {
      addCondition(condition);
    }
  }
  for (const condition of input.additionalConditions ?? []) {
    addCondition({ ...condition, requirement: "advisory" });
  }
  const requiredCriteria = new Set(customProfile?.requiredCriteria ?? []);
  const advisoryCriteria = new Set(customProfile?.advisoryCriteria ?? []);
  for (const criterionId of [...requiredCriteria, ...advisoryCriteria]) {
    const existing = conditionsById.get(criterionId) ?? profileCandidates.get(criterionId);
    if (existing) {
      conditionsById.set(criterionId, {
        ...existing,
        requirement:
          existing.requirement === "required" || requiredCriteria.has(criterionId)
            ? "required"
            : "advisory",
      });
      continue;
    }
    addCondition({
      type: criterionId,
      status: "Unknown",
      requirement: requiredCriteria.has(criterionId) ? "required" : "advisory",
      reason: "CriterionUnavailable",
      message: `Readiness criterion ${criterionId} is not registered.`,
    });
  }
  const conditions = [...conditionsById.values()];
  const failures = conditions
    .filter((entry) => entry.requirement === "required" && entry.status !== "True")
    .map((entry) => entry.reason);
  const advisories = conditions
    .filter((entry) => entry.requirement === "advisory" && entry.status !== "True")
    .map((entry) => entry.reason);
  return {
    profile,
    ready: failures.length === 0,
    conditions,
    failures,
    advisories,
  };
}
