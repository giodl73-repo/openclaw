import { describe, expect, it } from "vitest";
import { buildHostingReadiness } from "./readiness.js";

describe("buildHostingReadiness", () => {
  it("reports local ready when every required condition is true", () => {
    expect(
      buildHostingReadiness({
        configLoaded: true,
        gateway: "responding",
        plugins: { errors: [] },
      }),
    ).toMatchObject({
      profile: "local",
      ready: true,
      failures: [],
      advisories: [],
    });
  });

  it("blocks readiness for false required conditions", () => {
    const readiness = buildHostingReadiness({
      configLoaded: false,
      gateway: "unavailable",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["ConfigNotLoaded", "GatewayUnavailable"]);
  });

  it("blocks readiness when a required condition is unknown", () => {
    const readiness = buildHostingReadiness({
      configLoaded: true,
      gateway: "not-checked",
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["GatewayNotChecked"]);
    expect(readiness.advisories).toEqual(["PluginStatusUnavailable"]);
  });

  it("ignores errors from explicitly disabled plugins", () => {
    const readiness = buildHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [
          {
            id: "disabled-plugin",
            activated: false,
            activationSource: "disabled",
            error: "not loaded",
          },
        ],
      },
    });

    expect(readiness.ready).toBe(true);
  });

  it("reports selected plugin activation failures", () => {
    const readiness = buildHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [{ id: "required-plugin", activated: true, error: "boom" }],
      },
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.failures).toEqual([]);
    expect(readiness.advisories).toEqual(["PluginLoadFailures"]);
  });

  it("requires a non-loopback local Gateway for the container profile", () => {
    const readiness = buildHostingReadiness({
      profile: "container",
      config: { gateway: { mode: "local", bind: "loopback" } },
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("ContainerGatewayLoopback");
  });

  it("uses effective startup bind instead of stale persisted bind", () => {
    const readiness = buildHostingReadiness({
      profile: "container",
      config: { gateway: { mode: "local", bind: "loopback" } },
      runtimeGateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        authMode: "token",
        trustedProxyCount: 0,
      },
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(true);
  });

  it("requires complete trusted-proxy posture for reverse-proxy", () => {
    const readiness = buildHostingReadiness({
      profile: "reverse-proxy",
      config: {
        gateway: {
          mode: "local",
          bind: "lan",
          auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } },
        },
      },
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("TrustedProxySourcesMissing");
  });

  it("allows a same-host reverse proxy to use loopback", () => {
    const readiness = buildHostingReadiness({
      profile: "reverse-proxy",
      config: {
        gateway: {
          mode: "local",
          bind: "loopback",
          trustedProxies: ["127.0.0.1"],
          auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } },
        },
      },
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(true);
  });

  it("reports managed ready with trusted-proxy hosting requirements", () => {
    const readiness = buildHostingReadiness({
      profile: "managed",
      config: {
        gateway: {
          mode: "local",
          bind: "lan",
          trustedProxies: ["10.0.0.1"],
          auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } },
        },
      },
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.failures).toEqual([]);
    expect(readiness.conditions.map((condition) => condition.type)).toContain("TrustedProxyReady");
  });
});
