import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { buildPolicySettingsConstraints } from "./settings-constraints.js";

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

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
      policyPath: "gateway.exposure.allowNonLoopbackBind",
      state: "readOnly",
      allowedValues: ["loopback"],
      source: "oc://workspace.policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      checkId: "policy/gateway-non-loopback-bind",
    });
    expect(constraints.settings["gateway.auth.mode"]).toMatchObject({
      path: "gateway.auth.mode",
      policyPath: "gateway.auth.requireAuth",
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
    expect(constraints.settings["gateway.controlUi.allowInsecure"]).toMatchObject({
      state: "readOnly",
      allowedValues: [false],
      deniedValues: [true],
      checkId: "policy/gateway-control-ui-insecure",
    });
  });

  it("projects metadata-backed policy rules into generic setting constraints", () => {
    const constraints = buildPolicySettingsConstraints({
      sandbox: {
        requireMode: ["all"],
        allowBackends: ["podman"],
        containers: { denyHostNetwork: true },
      },
      tools: {
        profiles: { allow: ["coding"] },
        exec: {
          allowSecurity: ["deny", "allowlist"],
          requireAsk: ["always"],
          allowHosts: ["sandbox", "gateway"],
        },
        elevated: { allow: false },
      },
      agents: {
        workspace: { allowedAccess: ["none", "ro"], denyTools: ["exec"] },
      },
      ingress: {
        session: { requireDmScope: "per-peer" },
        channels: {
          allowDmPolicies: ["pairing", "allowlist"],
          denyOpenGroups: true,
          requireMentionInGroups: true,
        },
      },
      network: { privateNetwork: { allow: false } },
      models: { providers: { allow: ["openai"], deny: ["local"] } },
      gateway: {
        http: { denyEndpoints: ["responses"], requireUrlAllowlists: true },
        nodes: { denyCommands: ["system.run"] },
        remote: { allow: false },
      },
      execApprovals: {
        defaults: { allowSecurity: ["deny"] },
        agents: { allowSecurity: ["deny", "allowlist"], allowAutoAllowSkills: false },
      },
      auth: { profiles: { allowModes: ["oauth", "token"] } },
    });

    expect(constraints.settings["agents.*.sandbox.mode"]).toMatchObject({
      policyPath: "sandbox.requireMode",
      allowedValues: ["all"],
    });
    expect(constraints.settings["tools.exec.host"]).toMatchObject({
      policyPath: "tools.exec.allowHosts",
      allowedValues: ["sandbox", "gateway"],
    });
    expect(constraints.settings["tools.elevated.enabled"]).toMatchObject({
      policyPath: "tools.elevated.allow",
      allowedValues: [false],
      deniedValues: [true],
    });
    expect(constraints.settings["channels.*.groupPolicy"]).toMatchObject({
      policyPath: "ingress.channels.denyOpenGroups",
      allowedValues: ["allowlist", "disabled"],
      deniedValues: ["open"],
    });
    expect(constraints.settings["session.dmScope"]).toMatchObject({
      policyPath: "ingress.session.requireDmScope",
      allowedValues: ["per-peer"],
    });
    expect(constraints.settings["models.*.provider"]).toMatchObject({
      policyPath: "models.providers.allow",
      allowedValues: ["openai"],
      deniedValues: ["local"],
    });
    expect(constraints.settings["gateway.http.endpoints.*.enabled"]).toMatchObject({
      policyPath: "gateway.http.denyEndpoints",
      deniedValues: ["responses"],
    });
    expect(constraints.settings["gateway.nodes.commands"]).toMatchObject({
      policyPath: "gateway.nodes.denyCommands",
      deniedValues: ["system.run"],
    });
    expect(constraints.settings["execApprovals.agents.*.autoAllowSkills"]).toMatchObject({
      policyPath: "execApprovals.agents.allowAutoAllowSkills",
      allowedValues: [false],
    });
    expect(constraints.settings["auth.profiles.*.mode"]).toMatchObject({
      policyPath: "auth.profiles.allowModes",
      allowedValues: ["oauth", "token"],
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

  it("keeps the hosted Control UI lockdown example aligned with the emitted contract", async () => {
    const policyText = await readFile(
      join(EXAMPLES_DIR, "hosted-control-ui-lockdown.policy.jsonc"),
      "utf-8",
    );
    const expectedText = await readFile(
      join(EXAMPLES_DIR, "hosted-control-ui-lockdown.constraints.json"),
      "utf-8",
    );

    expect(
      buildPolicySettingsConstraints(
        JSON5.parse(policyText),
        "hosted-control-ui-lockdown.policy.jsonc",
      ),
    ).toEqual(JSON.parse(expectedText));
  });
});
