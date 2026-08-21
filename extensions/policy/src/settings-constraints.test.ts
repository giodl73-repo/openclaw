import { describe, expect, it } from "vitest";
import { buildPolicySettingsConstraints } from "./settings-constraints.js";

describe("policy settings constraints", () => {
  it("returns an empty active-policy constraints report when policy has no setting restrictions", () => {
    expect(buildPolicySettingsConstraints({})).toEqual({
      version: 1,
      mode: "active-policy-constraints",
      settings: {},
    });
  });

  it("projects restrictive gateway policy rules into host setting constraints", () => {
    const constraints = buildPolicySettingsConstraints(
      {
        gateway: {
          exposure: { allowNonLoopbackBind: false },
          auth: { requireAuth: true },
          controlUi: { allowInsecure: false },
        },
      },
      "workspace.policy.jsonc",
    );

    expect(constraints.settings["gateway.bind"]).toMatchObject({
      path: "gateway.bind",
      state: "readOnly",
      allowedValues: ["loopback"],
      source: "oc://workspace.policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      checkId: "policy/gateway-non-loopback-bind",
    });
    expect(constraints.settings["gateway.auth.mode"]).toMatchObject({
      path: "gateway.auth.mode",
      state: "enabled",
      allowedValues: ["token", "password", "trusted-proxy"],
      deniedValues: ["none"],
      source: "oc://workspace.policy.jsonc/gateway/auth/requireAuth",
      checkId: "policy/gateway-auth-required",
    });
    expect(constraints.settings["gateway.controlUi.insecureAuth"]).toMatchObject({
      state: "readOnly",
      allowedValues: [false],
      deniedValues: [true],
      checkId: "policy/gateway-control-ui-insecure-auth",
    });
    expect(constraints.settings["gateway.controlUi.deviceAuthDisabled"]).toMatchObject({
      state: "readOnly",
      allowedValues: [false],
      deniedValues: [true],
      checkId: "policy/gateway-control-ui-device-auth-disabled",
    });
    expect(constraints.settings["gateway.controlUi.hostOriginFallback"]).toMatchObject({
      state: "readOnly",
      allowedValues: [false],
      deniedValues: [true],
      checkId: "policy/gateway-control-ui-host-origin-fallback",
    });
  });

  it("does not constrain explicitly permissive gateway policies", () => {
    const constraints = buildPolicySettingsConstraints({
      gateway: {
        exposure: { allowNonLoopbackBind: true },
        auth: { requireAuth: false },
        controlUi: { allowInsecure: true },
      },
    });

    expect(constraints.settings).toEqual({});
  });
});
