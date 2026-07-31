import { describe, expect, it, vi } from "vitest";
import { rejectPolicySettingsConstraintViolations } from "./config-policy-constraints.js";

function makeConstraints() {
  return {
    version: 1 as const,
    mode: "active-policy-constraints" as const,
    settings: {
      "gateway.bind": {
        path: "gateway.bind",
        policyPath: "gateway.exposure.allowNonLoopbackBind",
        state: "readOnly" as const,
        reason: "Loopback is required.",
        source: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
        checkId: "policy/gateway-non-loopback-bind",
        allowedValues: ["loopback"],
      },
      "agents.*.sandbox.mode": {
        path: "agents.*.sandbox.mode",
        policyPath: "sandbox.requireMode",
        state: "readOnly" as const,
        reason: "Sandbox coding mode is required.",
        source: "oc://policy.jsonc/sandbox/requireMode",
        checkId: "policy/sandbox-mode-required",
        allowedValues: ["coding"],
      },
    },
  };
}

describe("rejectPolicySettingsConstraintViolations", () => {
  it("rejects changed exact paths outside active policy constraints", async () => {
    const respond = vi.fn();

    await expect(
      rejectPolicySettingsConstraintViolations({
        context: { getPolicySettingsConstraints: () => makeConstraints() } as never,
        nextConfig: { gateway: { bind: "0.0.0.0" } },
        changedPaths: ["gateway.bind"],
        respond,
      }),
    ).resolves.toBe(true);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Loopback is required."),
        details: {
          policySettingsConstraint: expect.objectContaining({
            path: "gateway.bind",
            checkId: "policy/gateway-non-loopback-bind",
          }),
        },
      }),
    );
  });

  it("rejects changed wildcard paths outside active policy constraints", async () => {
    const respond = vi.fn();

    await expect(
      rejectPolicySettingsConstraintViolations({
        context: { getPolicySettingsConstraints: () => makeConstraints() } as never,
        nextConfig: { agents: { main: { sandbox: { mode: "full" } } } },
        changedPaths: ["agents.main.sandbox.mode"],
        respond,
      }),
    ).resolves.toBe(true);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: {
          policySettingsConstraint: expect.objectContaining({
            path: "agents.main.sandbox.mode",
            checkId: "policy/sandbox-mode-required",
          }),
        },
      }),
    );
  });

  it("allows writes when no changed path violates active policy constraints", async () => {
    const respond = vi.fn();

    await expect(
      rejectPolicySettingsConstraintViolations({
        context: { getPolicySettingsConstraints: () => makeConstraints() } as never,
        nextConfig: { gateway: { bind: "loopback", port: 19001 } },
        changedPaths: ["gateway.port"],
        respond,
      }),
    ).resolves.toBe(false);

    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects generic host read-only settings without policy metadata", async () => {
    const respond = vi.fn();

    await expect(
      rejectPolicySettingsConstraintViolations({
        context: {
          getPolicySettingsConstraints: () => ({
            version: 1,
            mode: "active-policy-constraints",
            settings: {
              "gateway.bind": {
                path: "gateway.bind",
                state: "readOnly",
                reason: "Lobster owns Gateway bind settings.",
                source: "lobster",
                broker: "lobster.policy.apply",
              },
            },
          }),
        } as never,
        nextConfig: { gateway: { bind: "0.0.0.0" } },
        changedPaths: ["gateway.bind"],
        respond,
      }),
    ).resolves.toBe(true);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: {
          policySettingsConstraint: expect.objectContaining({
            path: "gateway.bind",
            state: "readOnly",
            source: "lobster",
            broker: "lobster.policy.apply",
          }),
        },
      }),
    );
  });
});
