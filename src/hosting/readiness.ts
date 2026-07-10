import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayBindMode } from "../config/types.gateway.js";

export const HOSTING_PROFILE_IDS = ["local", "container", "reverse-proxy", "managed"] as const;
export type HostingProfileId = (typeof HOSTING_PROFILE_IDS)[number];

export const DEFAULT_HOSTING_PROFILE: HostingProfileId = "local";
export const HOSTING_PROFILE_ENV = "OPENCLAW_HOSTING_PROFILE";

export type HostingReadinessConditionType =
  | "GatewayStartupComplete"
  | "GatewayAcceptingWork"
  | "ChannelRuntimeReady"
  | "ChannelRuntimeSuppressed"
  | "EventLoopHealthy"
  | "ProfileSelected"
  | "ConfigLoaded"
  | "GatewayResponding"
  | "PluginsLoaded"
  | "ContainerStateReady"
  | "TrustedProxyReady"
  | "ManagedLifecycleReady";

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

export type HostingReadinessInput = {
  profile?: HostingProfileId;
  config?: OpenClawConfig;
  configLoaded: boolean;
  gateway: "responding" | "not-checked" | "unavailable";
  plugins?: HostingPluginReadinessInput;
  coreConditions?: HostingReadinessCondition[];
  managedLifecycle?: "ready" | "not-ready" | "not-checked";
  runtimeGateway?: {
    mode: "local";
    bind: GatewayBindMode;
    port: number;
    authMode: string;
    trustedProxyUserHeader?: string;
    trustedProxyCount: number;
  };
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

function buildContainerCondition(input: HostingReadinessInput): HostingReadinessCondition {
  const mode = input.runtimeGateway?.mode ?? input.config?.gateway?.mode ?? "local";
  if (mode !== "local") {
    return {
      type: "ContainerStateReady",
      status: "False",
      reason: "ContainerGatewayRemote",
      message: "Container profile requires this process to host the Gateway locally.",
    };
  }
  const bind = input.runtimeGateway?.bind ?? input.config?.gateway?.bind ?? "loopback";
  if (bind === "loopback") {
    return {
      type: "ContainerStateReady",
      status: "False",
      reason: "ContainerGatewayLoopback",
      message: "Container profile requires a non-loopback Gateway bind.",
    };
  }
  return {
    type: "ContainerStateReady",
    status: "True",
    reason: "ContainerStateReady",
    message: `Gateway is hosted locally with ${bind} bind on port ${input.runtimeGateway?.port ?? input.config?.gateway?.port ?? 18789}.`,
  };
}

function buildTrustedProxyCondition(input: HostingReadinessInput): HostingReadinessCondition {
  const auth = input.config?.gateway?.auth;
  const authMode = input.runtimeGateway?.authMode ?? auth?.mode;
  if (authMode !== "trusted-proxy") {
    return {
      type: "TrustedProxyReady",
      status: "False",
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
      reason: "TrustedProxySourcesMissing",
      message: "Reverse-proxy profile requires at least one trusted proxy address or CIDR.",
    };
  }
  return {
    type: "TrustedProxyReady",
    status: "True",
    reason: "TrustedProxyReady",
    message: `Trusted-proxy auth accepts ${userHeader} from ${trustedProxyCount} configured source${trustedProxyCount === 1 ? "" : "s"}.`,
  };
}

function buildManagedLifecycleCondition(
  lifecycle: HostingReadinessInput["managedLifecycle"],
): HostingReadinessCondition {
  if (lifecycle === "ready") {
    return {
      type: "ManagedLifecycleReady",
      status: "True",
      reason: "ManagedLifecycleReady",
      message: "Gateway startup completed and the runtime is not draining.",
    };
  }
  if (lifecycle === "not-ready") {
    return {
      type: "ManagedLifecycleReady",
      status: "False",
      reason: "ManagedLifecycleNotReady",
      message: "Gateway startup, channel, or drain state is not ready.",
    };
  }
  return {
    type: "ManagedLifecycleReady",
    status: "Unknown",
    reason: "ManagedLifecycleNotChecked",
    message: "This status surface did not inspect Gateway lifecycle state.",
  };
}

export function buildHostingReadiness(input: HostingReadinessInput): HostingReadinessResult {
  const profile = input.profile ?? DEFAULT_HOSTING_PROFILE;
  const conditions: HostingReadinessCondition[] = [
    ...(input.coreConditions ?? []),
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
    buildGatewayCondition(input.gateway),
    buildPluginCondition(input.plugins),
  ];
  if (profile === "container") {
    conditions.push(buildContainerCondition(input));
  }
  if (profile === "reverse-proxy" || profile === "managed") {
    conditions.push(buildTrustedProxyCondition(input));
  }
  if (profile === "managed") {
    conditions.push(buildManagedLifecycleCondition(input.managedLifecycle));
  }
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
