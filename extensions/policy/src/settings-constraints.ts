import { readPolicyBoolean } from "./doctor/utils.js";

export type PolicySettingsConstraintState = "enabled" | "readOnly" | "disabled";

export type PolicySettingsConstraintValue = string | number | boolean | null;

export type PolicySettingsConstraint = {
  readonly path: string;
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

  if (readPolicyBoolean(policy, ["gateway", "exposure", "allowNonLoopbackBind"]) === false) {
    settings["gateway.bind"] = {
      path: "gateway.bind",
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
      reason: "The active policy does not allow insecure Control UI authentication.",
      source: sourceRef(policyDocName, ["gateway", "controlUi", "allowInsecure"]),
      checkId: "policy/gateway-control-ui-insecure-auth",
    });
    addFalseLock(settings, {
      path: "gateway.controlUi.deviceAuthDisabled",
      reason: "The active policy requires device authorization for Control UI access.",
      source: sourceRef(policyDocName, ["gateway", "controlUi", "allowInsecure"]),
      checkId: "policy/gateway-control-ui-device-auth-disabled",
    });
    addFalseLock(settings, {
      path: "gateway.controlUi.hostOriginFallback",
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
  constraint: Pick<PolicySettingsConstraint, "path" | "reason" | "source" | "checkId">,
): void {
  settings[constraint.path] = {
    ...constraint,
    state: "readOnly",
    allowedValues: [false],
    deniedValues: [true],
  };
}

function sourceRef(policyDocName: string, path: readonly string[]): string {
  return `oc://${policyDocName}/${path.join("/")}`;
}
