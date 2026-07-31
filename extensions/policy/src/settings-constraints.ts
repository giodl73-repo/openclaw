import { POLICY_RULE_METADATA, type PolicyRuleMetadata } from "./doctor/metadata.js";
import { readPolicyBoolean, readString, readStringList } from "./doctor/utils.js";

export type PolicySettingsConstraintState = "enabled" | "readOnly" | "disabled";

export type PolicySettingsConstraintValue = string | number | boolean | null;

export type PolicySettingsConstraint = {
  readonly path: string;
  readonly policyPath: string;
  readonly state: PolicySettingsConstraintState;
  readonly reason: string;
  readonly source: string;
  readonly checkId: string;
  readonly allowedValues?: readonly PolicySettingsConstraintValue[];
  readonly deniedValues?: readonly PolicySettingsConstraintValue[];
};

export type PolicySettingsConstraintsReport = {
  readonly version: 1;
  readonly mode: "active-policy-constraints";
  readonly settings: Readonly<Record<string, PolicySettingsConstraint>>;
};

export function buildPolicySettingsConstraints(
  policy: unknown,
  policyDocName = "policy.jsonc",
): PolicySettingsConstraintsReport {
  const settings: Record<string, PolicySettingsConstraint> = {};

  addMetadataConstraints(settings, policy, policyDocName);

  if (readPolicyBoolean(policy, ["gateway", "exposure", "allowNonLoopbackBind"]) === false) {
    settings["gateway.bind"] = {
      path: "gateway.bind",
      policyPath: "gateway.exposure.allowNonLoopbackBind",
      state: "readOnly",
      allowedValues: ["loopback"],
      reason: "The active policy does not allow gateway binds outside the local host.",
      source: sourceRef(policyDocName, ["gateway", "exposure", "allowNonLoopbackBind"]),
      checkId: "policy/gateway-non-loopback-bind",
    };
  }

  if (readPolicyBoolean(policy, ["gateway", "auth", "requireAuth"]) === true) {
    settings["gateway.auth.mode"] = {
      path: "gateway.auth.mode",
      policyPath: "gateway.auth.requireAuth",
      state: "enabled",
      allowedValues: ["token", "password", "trusted-proxy"],
      deniedValues: ["none"],
      reason: "The active policy requires authenticated gateway access.",
      source: sourceRef(policyDocName, ["gateway", "auth", "requireAuth"]),
      checkId: "policy/gateway-auth-required",
    };
  }

  if (readPolicyBoolean(policy, ["gateway", "controlUi", "allowInsecure"]) === false) {
    addFalseLock(settings, {
      path: "gateway.controlUi.insecureAuth",
      policyPath: "gateway.controlUi.allowInsecure",
      reason: "The active policy does not allow insecure Control UI authentication.",
      source: sourceRef(policyDocName, ["gateway", "controlUi", "allowInsecure"]),
      checkId: "policy/gateway-control-ui-insecure-auth",
    });
    addFalseLock(settings, {
      path: "gateway.controlUi.deviceAuthDisabled",
      policyPath: "gateway.controlUi.allowInsecure",
      reason: "The active policy requires device authorization for Control UI access.",
      source: sourceRef(policyDocName, ["gateway", "controlUi", "allowInsecure"]),
      checkId: "policy/gateway-control-ui-device-auth-disabled",
    });
    addFalseLock(settings, {
      path: "gateway.controlUi.hostOriginFallback",
      policyPath: "gateway.controlUi.allowInsecure",
      reason: "The active policy does not allow Control UI host origin fallback.",
      source: sourceRef(policyDocName, ["gateway", "controlUi", "allowInsecure"]),
      checkId: "policy/gateway-control-ui-host-origin-fallback",
    });
  }

  return {
    version: 1,
    mode: "active-policy-constraints",
    settings,
  };
}

function addFalseLock(
  settings: Record<string, PolicySettingsConstraint>,
  constraint: Pick<
    PolicySettingsConstraint,
    "path" | "policyPath" | "reason" | "source" | "checkId"
  >,
): void {
  settings[constraint.path] = {
    ...constraint,
    state: "readOnly",
    allowedValues: [false],
    deniedValues: [true],
  };
}

function addMetadataConstraints(
  settings: Record<string, PolicySettingsConstraint>,
  policy: unknown,
  policyDocName: string,
): void {
  for (const rule of POLICY_RULE_METADATA) {
    const constraint = metadataConstraint(rule, policy, policyDocName);
    if (constraint === undefined) {
      continue;
    }
    settings[constraint.path] = mergeConstraint(settings[constraint.path], constraint);
  }
}

function metadataConstraint(
  rule: PolicyRuleMetadata,
  policy: unknown,
  policyDocName: string,
): PolicySettingsConstraint | undefined {
  const policyPath = rule.policyPath.join(".");
  if (SKIPPED_POLICY_PATHS.has(policyPath)) {
    return undefined;
  }
  const path = SETTING_PATHS_BY_POLICY_PATH[policyPath] ?? policyPath;
  const source = sourceRef(policyDocName, rule.policyPath);
  const checkId = rule.checkIds[0];
  if (checkId === undefined) {
    return undefined;
  }
  const customValues = CUSTOM_VALUES_BY_POLICY_PATH[policyPath];

  switch (rule.strictness) {
    case "requires-false":
      return readPolicyBoolean(policy, rule.policyPath) === false
        ? {
            path,
            policyPath,
            state: customValues === undefined ? "readOnly" : "enabled",
            allowedValues: customValues?.allowedValues ?? [false],
            deniedValues: customValues?.deniedValues ?? [true],
            reason: customValues?.reason ?? `The active policy requires ${path} to stay disabled.`,
            source,
            checkId,
          }
        : undefined;
    case "requires-true":
      return readPolicyBoolean(policy, rule.policyPath) === true
        ? {
            path,
            policyPath,
            state: customValues === undefined ? "readOnly" : "enabled",
            allowedValues: customValues?.allowedValues ?? [true],
            deniedValues: customValues?.deniedValues ?? [false],
            reason: customValues?.reason ?? `The active policy requires ${path} to stay enabled.`,
            source,
            checkId,
          }
        : undefined;
    case "allowlist-subset": {
      const allowed = readStringList(policy, rule.policyPath, {
        lowercase: rule.caseSensitive === true ? false : undefined,
      });
      return allowed.length > 0
        ? {
            path,
            policyPath,
            state: "enabled",
            allowedValues: allowed,
            reason: `The active policy only allows approved values for ${path}.`,
            source,
            checkId,
          }
        : undefined;
    }
    case "denylist-superset": {
      const denied = readStringList(policy, rule.policyPath, {
        lowercase: rule.caseSensitive === true ? false : undefined,
      });
      return denied.length > 0
        ? {
            path,
            policyPath,
            state: "enabled",
            deniedValues: denied,
            reason: `The active policy denies these values for ${path}.`,
            source,
            checkId,
          }
        : undefined;
    }
    case "ordered-string": {
      const value = readString(policy, rule.policyPath);
      return value === undefined
        ? undefined
        : {
            path,
            policyPath,
            state: "readOnly",
            allowedValues: [value],
            reason: `The active policy requires ${path} to use this value.`,
            source,
            checkId,
          };
    }
    case "exact-list": {
      const values = readStringList(policy, rule.policyPath, {
        lowercase: rule.caseSensitive === true ? false : undefined,
      });
      return values.length > 0
        ? {
            path,
            policyPath,
            state: "readOnly",
            allowedValues: values,
            reason: `The active policy requires an exact value set for ${path}.`,
            source,
            checkId,
          }
        : undefined;
    }
    case "routing-probes":
      return undefined;
  }
}

function mergeConstraint(
  current: PolicySettingsConstraint | undefined,
  next: PolicySettingsConstraint,
): PolicySettingsConstraint {
  if (current === undefined) {
    return next;
  }
  return {
    ...current,
    state:
      current.state === "readOnly" || next.state === "readOnly"
        ? "readOnly"
        : current.state === "disabled" || next.state === "disabled"
          ? "disabled"
          : "enabled",
    allowedValues: mergeValues(current.allowedValues, next.allowedValues),
    deniedValues: mergeValues(current.deniedValues, next.deniedValues),
  };
}

function mergeValues(
  left: readonly PolicySettingsConstraintValue[] | undefined,
  right: readonly PolicySettingsConstraintValue[] | undefined,
): readonly PolicySettingsConstraintValue[] | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return [...new Set([...left, ...right])];
}

function sourceRef(policyDocName: string, path: readonly string[]): string {
  return `oc://${policyDocName}/${path.join("/")}`;
}

const SETTING_PATHS_BY_POLICY_PATH: Readonly<Record<string, string>> = {
  "agents.workspace.allowedAccess": "agents.*.sandbox.workspaceAccess",
  "agents.workspace.denyTools": "agents.*.tools.deny",
  "auth.profiles.allowModes": "auth.profiles.*.mode",
  "auth.profiles.requireMetadata": "auth.profiles.*.metadata",
  "execApprovals.agents.allowAutoAllowSkills": "execApprovals.agents.*.autoAllowSkills",
  "execApprovals.agents.allowSecurity": "execApprovals.agents.*.security",
  "execApprovals.agents.allowlist.expected": "execApprovals.agents.*.allowlist",
  "execApprovals.defaults.allowSecurity": "execApprovals.defaults.security",
  "gateway.auth.requireExplicitRateLimit": "gateway.auth.rateLimit",
  "gateway.exposure.allowNonLoopbackBind": "gateway.bind",
  "gateway.exposure.allowTailscaleFunnel": "gateway.tailscale.mode",
  "gateway.http.denyEndpoints": "gateway.http.endpoints.*.enabled",
  "gateway.http.requireUrlAllowlists": "gateway.http.endpoints.*.urlAllowlist",
  "gateway.nodes.denyCommands": "gateway.nodes.commands",
  "gateway.remote.allow": "gateway.mode",
  "ingress.channels.allowDmPolicies": "channels.*.dmPolicy",
  "ingress.channels.denyOpenGroups": "channels.*.groupPolicy",
  "ingress.channels.requireMentionInGroups": "channels.*.requireMention",
  "ingress.session.requireDmScope": "session.dmScope",
  "models.providers.allow": "models.*.provider",
  "models.providers.deny": "models.*.provider",
  "network.privateNetwork.allow": "network.privateNetwork.allow",
  "sandbox.allowBackends": "agents.*.sandbox.backend",
  "sandbox.browser.requireCdpSourceRange": "agents.*.sandbox.browser.cdpSourceRange",
  "sandbox.containers.denyContainerNamespaceJoin": "agents.*.sandbox.containers.namespace",
  "sandbox.containers.denyContainerRuntimeSocketMounts": "agents.*.sandbox.containers.mounts",
  "sandbox.containers.denyHostNetwork": "agents.*.sandbox.docker.network",
  "sandbox.containers.denyUnconfinedProfiles": "agents.*.sandbox.containers.securityProfile",
  "sandbox.containers.requireReadOnlyMounts": "agents.*.sandbox.containers.mounts",
  "sandbox.requireMode": "agents.*.sandbox.mode",
  "tools.alsoAllow.expected": "tools.allow",
  "tools.denyTools": "tools.deny",
  "tools.elevated.allow": "tools.elevated.enabled",
  "tools.exec.allowHosts": "tools.exec.host",
  "tools.exec.allowSecurity": "tools.exec.security",
  "tools.exec.requireAsk": "tools.exec.ask",
  "tools.fs.requireWorkspaceOnly": "tools.fs.workspaceOnly",
  "tools.profiles.allow": "tools.profile",
  "tools.requireMetadata": "tools.*.metadata",
};

const CUSTOM_VALUES_BY_POLICY_PATH: Readonly<
  Record<
    string,
    {
      readonly allowedValues?: readonly PolicySettingsConstraintValue[];
      readonly deniedValues?: readonly PolicySettingsConstraintValue[];
      readonly reason?: string;
    }
  >
> = {
  "gateway.exposure.allowTailscaleFunnel": {
    deniedValues: ["funnel"],
    reason: "The active policy does not allow Tailscale Funnel exposure.",
  },
  "gateway.remote.allow": {
    deniedValues: ["remote"],
    reason: "The active policy does not allow remote gateway mode.",
  },
  "ingress.channels.denyOpenGroups": {
    allowedValues: ["allowlist", "disabled"],
    deniedValues: ["open"],
    reason: "The active policy only allows closed group ingress modes.",
  },
};

const SKIPPED_POLICY_PATHS = new Set<string>([
  "execApprovals.requireFile",
  "gateway.http.requireUrlAllowlists",
  "routing.requireBindings",
  "routing.requireConfiguredChannels",
  "sandbox.browser.requireCdpSourceRange",
  "sandbox.containers.denyContainerNamespaceJoin",
  "sandbox.containers.denyContainerRuntimeSocketMounts",
  "sandbox.containers.denyHostNetwork",
  "sandbox.containers.denyUnconfinedProfiles",
  "sandbox.containers.requireReadOnlyMounts",
]);
