export const DEFAULT_HOSTING_PROFILE = "local" as const;

export type HostingProfileId = typeof DEFAULT_HOSTING_PROFILE;

export type HostingReadinessConditionType =
  | "ProfileSelected"
  | "ConfigLoaded"
  | "GatewayResponding"
  | "PluginsLoaded";

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
  configLoaded: boolean;
  gateway: "responding" | "not-checked" | "unavailable";
  plugins?: HostingPluginReadinessInput;
};

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

export function buildHostingReadiness(input: HostingReadinessInput): HostingReadinessResult {
  const conditions: HostingReadinessCondition[] = [
    {
      type: "ProfileSelected",
      status: "True",
      requirement: "required",
      reason: "ProfileSelected",
      message: "Runtime selected the local hosting profile.",
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
  const failures = conditions
    .filter((entry) => entry.requirement === "required" && entry.status !== "True")
    .map((entry) => entry.reason);
  const advisories = conditions
    .filter((entry) => entry.requirement === "advisory" && entry.status !== "True")
    .map((entry) => entry.reason);
  return {
    profile: DEFAULT_HOSTING_PROFILE,
    ready: failures.length === 0,
    conditions,
    failures,
    advisories,
  };
}
