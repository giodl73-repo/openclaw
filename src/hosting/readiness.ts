import type { OpenClawConfig } from "../config/types.openclaw.js";

export const HOSTING_PROFILE_IDS = [
  "local",
  "container",
  "reverse-proxy",
  "managed",
  "node-mode",
] as const;

export type HostingProfileId = (typeof HOSTING_PROFILE_IDS)[number];

export type HostingProfileDefinition = {
  id: HostingProfileId;
  label: string;
  description: string;
  maturity: "supported" | "preview";
};

export type HostingReadinessConditionType =
  | "ProfileSelected"
  | "ConfigLoaded"
  | "GatewayResponding"
  | "WorkspaceUsable"
  | "PluginsLoaded"
  | "NodePairingReady"
  | "ControlledTargetsReady"
  | "CommandApprovalReady"
  | "ControlChannelReady"
  | "StateReady";

export type HostingReadinessConditionStatus = "True" | "False" | "Unknown";

export type HostingReadinessCondition = {
  type: HostingReadinessConditionType;
  status: HostingReadinessConditionStatus;
  reason: string;
  message: string;
};

export type HostingReadinessResult = {
  profile: HostingProfileId;
  expectedProfile?: HostingProfileId;
  ready: boolean;
  conditions: HostingReadinessCondition[];
  failures: string[];
};

export type HostingPluginReadinessInput = {
  errors?: Array<{
    id: string;
    activated?: boolean;
    activationSource?: string;
    error?: string;
  }>;
};

export type NodeModeReadinessEvidence = {
  pairing?: {
    pairedCount?: number;
    pendingCount?: number;
    error?: string;
  };
  targets?: {
    count?: number;
    connectedCount?: number;
  };
  commandApproval?: {
    configured?: boolean;
    approvedCommandCount?: number;
  };
  controlChannel?: {
    status?: "ready" | "not-checked" | "unavailable";
    target?: string;
  };
  state?: {
    workspaceUsable?: boolean;
  };
};

export type LocalHostingReadinessInput = {
  profile?: HostingProfileId;
  expectedProfile?: HostingProfileId;
  configLoaded: boolean;
  gateway: "responding" | "not-checked" | "unavailable";
  workspaceUsable: boolean;
  plugins?: HostingPluginReadinessInput;
  nodeMode?: NodeModeReadinessEvidence;
};

export const HOSTING_PROFILE_ENV = "OPENCLAW_HOSTING_PROFILE";

export const HOSTING_PROFILE_DEFINITIONS: Record<HostingProfileId, HostingProfileDefinition> = {
  local: {
    id: "local",
    label: "Local",
    description: "Developer/local foreground process readiness.",
    maturity: "supported",
  },
  container: {
    id: "container",
    label: "Container",
    description: "Single OpenClaw service hosted by Docker, Compose, or a similar supervisor.",
    maturity: "preview",
  },
  "reverse-proxy": {
    id: "reverse-proxy",
    label: "Reverse proxy",
    description: "OpenClaw Gateway running behind a trusted reverse proxy.",
    maturity: "preview",
  },
  managed: {
    id: "managed",
    label: "Managed",
    description: "Platform-hosted OpenClaw with managed lifecycle expectations.",
    maturity: "preview",
  },
  "node-mode": {
    id: "node-mode",
    label: "Node mode",
    description: "Platform-controlled execution node or cell readiness.",
    maturity: "preview",
  },
};

export function parseHostingProfileId(value: unknown): HostingProfileId | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return HOSTING_PROFILE_IDS.includes(normalized as HostingProfileId)
    ? (normalized as HostingProfileId)
    : null;
}

export function formatHostingProfileIds(): string {
  return HOSTING_PROFILE_IDS.map((profile) => `"${profile}"`).join(", ");
}

export function resolveHostingProfile(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  override?: unknown;
} = {}): HostingProfileId {
  return (
    parseHostingProfileId(params.override) ??
    parseHostingProfileId(params.env?.[HOSTING_PROFILE_ENV]) ??
    parseHostingProfileId(params.config?.hosting?.profile) ??
    "local"
  );
}

function condition(params: HostingReadinessCondition): HostingReadinessCondition {
  return params;
}

function resolvePluginFailures(plugins: HostingPluginReadinessInput | undefined): string[] {
  const errors = plugins?.errors ?? [];
  return errors
    .filter((entry) => entry.activated === true || entry.activationSource !== "disabled")
    .map((entry) =>
      entry.error ? `${entry.id}: ${entry.error}` : `${entry.id}: plugin load failed`,
    );
}

function buildFailureReasons(conditions: HostingReadinessCondition[]): string[] {
  return Array.from(
    new Set(conditions.filter((entry) => entry.status === "False").map((entry) => entry.reason)),
  );
}

export function buildLocalHostingReadiness(
  input: LocalHostingReadinessInput,
): HostingReadinessResult {
  const profile = input.profile ?? "local";
  const pluginFailures = resolvePluginFailures(input.plugins);
  const profileCondition =
    input.expectedProfile && input.expectedProfile !== profile
      ? condition({
          type: "ProfileSelected",
          status: "False",
          reason: "ProfileMismatch",
          message: `Expected hosting profile ${input.expectedProfile} but runtime selected ${profile}.`,
        })
      : condition({
          type: "ProfileSelected",
          status: "True",
          reason: "ProfileSelected",
          message: `Runtime selected the ${profile} hosting profile.`,
        });
  const gatewayCondition =
    input.gateway === "responding"
      ? condition({
          type: "GatewayResponding",
          status: "True",
          reason: "GatewayResponding",
          message: "Gateway accepted the readiness request.",
        })
      : input.gateway === "unavailable"
        ? condition({
            type: "GatewayResponding",
            status: "False",
            reason: "GatewayUnavailable",
            message: "Gateway did not respond to the readiness request.",
          })
        : condition({
            type: "GatewayResponding",
            status: "Unknown",
            reason: "GatewayNotChecked",
            message: "This status path did not probe a running Gateway.",
          });
  const conditions: HostingReadinessCondition[] = [
    profileCondition,
    condition({
      type: "ConfigLoaded",
      status: input.configLoaded ? "True" : "False",
      reason: input.configLoaded ? "ConfigLoaded" : "ConfigNotLoaded",
      message: input.configLoaded
        ? "Runtime configuration loaded."
        : "Runtime configuration was not loaded.",
    }),
    gatewayCondition,
    condition({
      type: "WorkspaceUsable",
      status: input.workspaceUsable ? "True" : "False",
      reason: input.workspaceUsable ? "WorkspaceUsable" : "WorkspaceUnavailable",
      message: input.workspaceUsable
        ? "Current workspace is usable."
        : "Current workspace is not usable.",
    }),
    condition({
      type: "PluginsLoaded",
      status: pluginFailures.length === 0 ? "True" : "False",
      reason: pluginFailures.length === 0 ? "PluginsLoaded" : "PluginLoadFailures",
      message:
        pluginFailures.length === 0
          ? "Required plugins loaded."
          : `Plugin load failures: ${pluginFailures.join("; ")}`,
    }),
  ];
  const failures = buildFailureReasons(conditions);
  return {
    profile,
    ...(input.expectedProfile ? { expectedProfile: input.expectedProfile } : {}),
    ready: failures.length === 0,
    conditions,
    failures,
  };
}

function buildNodeModeReadinessConditions(
  input: LocalHostingReadinessInput,
): HostingReadinessCondition[] {
  const evidence = input.nodeMode;
  const pairedCount = evidence?.pairing?.pairedCount ?? 0;
  const pendingCount = evidence?.pairing?.pendingCount ?? 0;
  const targetCount = evidence?.targets?.count ?? pairedCount;
  const connectedCount = evidence?.targets?.connectedCount;
  const approvedCommandCount = evidence?.commandApproval?.approvedCommandCount ?? 0;
  const commandApprovalConfigured = evidence?.commandApproval?.configured === true;
  const controlChannelStatus = evidence?.controlChannel?.status ?? input.gateway;
  const stateWorkspaceUsable = evidence?.state?.workspaceUsable ?? input.workspaceUsable;

  const pairingCondition = evidence?.pairing?.error
    ? condition({
        type: "NodePairingReady",
        status: "False",
        reason: "NodePairingUnavailable",
        message: `Node pairing state could not be read: ${evidence.pairing.error}`,
      })
    : pairedCount > 0
      ? condition({
          type: "NodePairingReady",
          status: "True",
          reason: "NodePairingReady",
          message: `Node pairing has ${pairedCount} approved node${pairedCount === 1 ? "" : "s"}.`,
        })
      : condition({
          type: "NodePairingReady",
          status: "False",
          reason: pendingCount > 0 ? "NodePairingPending" : "NodePairingMissing",
          message:
            pendingCount > 0
              ? `Node pairing has ${pendingCount} pending request${pendingCount === 1 ? "" : "s"} and no approved nodes.`
              : "Node-mode requires at least one approved node pairing.",
        });

  const targetCondition =
    targetCount > 0
      ? condition({
          type: "ControlledTargetsReady",
          status: "True",
          reason: "ControlledTargetsReady",
          message:
            connectedCount === undefined
              ? `Controlled target inventory has ${targetCount} target${targetCount === 1 ? "" : "s"}.`
              : `Controlled target inventory has ${targetCount} target${targetCount === 1 ? "" : "s"} (${connectedCount} connected).`,
        })
      : condition({
          type: "ControlledTargetsReady",
          status: "False",
          reason: "ControlledTargetsMissing",
          message: "Node-mode requires at least one controlled execution target.",
        });

  const commandApprovalCondition =
    commandApprovalConfigured || approvedCommandCount > 0
      ? condition({
          type: "CommandApprovalReady",
          status: "True",
          reason: "CommandApprovalReady",
          message:
            approvedCommandCount > 0
              ? `Command approval posture includes ${approvedCommandCount} approved command${approvedCommandCount === 1 ? "" : "s"}.`
              : "Command approval posture is configured.",
        })
      : pairedCount > 0
        ? condition({
            type: "CommandApprovalReady",
            status: "False",
            reason: "CommandApprovalMissing",
            message: "Node-mode has approved nodes but no command approval posture evidence.",
          })
        : condition({
            type: "CommandApprovalReady",
            status: "Unknown",
            reason: "CommandApprovalNotEvaluated",
            message: "Command approval posture is evaluated after node pairing is available.",
          });

  const controlChannelCondition =
    controlChannelStatus === "ready" || controlChannelStatus === "responding"
      ? condition({
          type: "ControlChannelReady",
          status: "True",
          reason: "ControlChannelReady",
          message: evidence?.controlChannel?.target
            ? `Control channel is ready for ${evidence.controlChannel.target}.`
            : "Control channel is ready.",
        })
      : controlChannelStatus === "unavailable"
        ? condition({
            type: "ControlChannelReady",
            status: "False",
            reason: "ControlChannelUnavailable",
            message: "Control channel is unavailable.",
          })
        : condition({
            type: "ControlChannelReady",
            status: "Unknown",
            reason: "ControlChannelNotChecked",
            message: "This status path did not check the node control channel.",
          });

  return [
    pairingCondition,
    targetCondition,
    commandApprovalCondition,
    controlChannelCondition,
    condition({
      type: "StateReady",
      status: stateWorkspaceUsable ? "True" : "False",
      reason: stateWorkspaceUsable ? "StateReady" : "StateUnavailable",
      message: stateWorkspaceUsable
        ? "Node-mode workspace and local state are usable."
        : "Node-mode workspace or local state is unavailable.",
    }),
  ];
}

export function buildHostingReadiness(input: LocalHostingReadinessInput): HostingReadinessResult {
  const base = buildLocalHostingReadiness(input);
  if (base.profile !== "node-mode") {
    return base;
  }
  const conditions = [...base.conditions, ...buildNodeModeReadinessConditions(input)];
  const failures = buildFailureReasons(conditions);
  return {
    ...base,
    conditions,
    failures,
    ready: failures.length === 0,
  };
}

export function buildNodeModeHostingReadiness(
  input: Omit<LocalHostingReadinessInput, "profile">,
): HostingReadinessResult {
  return buildHostingReadiness({ ...input, profile: "node-mode" });
}

export function withExpectedHostingProfile(
  readiness: HostingReadinessResult,
  expectedProfile: HostingProfileId | undefined,
): HostingReadinessResult {
  if (!expectedProfile) {
    return readiness;
  }
  const profileCondition: HostingReadinessCondition =
    expectedProfile === readiness.profile
      ? {
          type: "ProfileSelected",
          status: "True",
          reason: "ProfileSelected",
          message: `Runtime selected the ${readiness.profile} hosting profile.`,
        }
      : {
          type: "ProfileSelected",
          status: "False",
          reason: "ProfileMismatch",
          message: `Expected hosting profile ${expectedProfile} but runtime selected ${readiness.profile}.`,
        };
  const conditions = [
    profileCondition,
    ...readiness.conditions.filter((entry) => entry.type !== "ProfileSelected"),
  ];
  const failures = buildFailureReasons(conditions);
  return {
    ...readiness,
    expectedProfile,
    conditions,
    failures,
    ready: failures.length === 0,
  };
}
