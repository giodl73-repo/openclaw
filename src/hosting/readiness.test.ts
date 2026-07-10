import { describe, expect, it } from "vitest";
import { buildHostingReadiness, resolveHostingProfile } from "./readiness.js";

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
        bindHost: "0.0.0.0",
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

  it("rejects a custom loopback host for the container profile", () => {
    const readiness = buildHostingReadiness({
      profile: "container",
      config: {
        gateway: { mode: "local", bind: "custom", customBindHost: "127.0.0.1" },
      },
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("ContainerGatewayLoopback");
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
  it("requires a live connected target for node-mode", () => {
    const disconnected = buildHostingReadiness({
      profile: "node-mode",
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      nodeMode: {
        pairing: { pairedCount: 1, pendingCount: 0 },
        targets: { knownCount: 1, connectedCount: 0 },
        commandApproval: { configured: true, approvedCommandCount: 1 },
        controlChannel: { connectedCount: 0 },
      },
    });
    const connected = buildHostingReadiness({
      profile: "node-mode",
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      nodeMode: {
        pairing: { pairedCount: 1, pendingCount: 0 },
        targets: { knownCount: 1, connectedCount: 1 },
        commandApproval: { configured: true, approvedCommandCount: 1 },
        controlChannel: { connectedCount: 1 },
      },
    });

    expect(disconnected.ready).toBe(false);
    expect(disconnected.failures).toEqual([
      "ControlledTargetsDisconnected",
      "ControlChannelUnavailable",
    ]);
    expect(connected.ready).toBe(true);
  });

  it("reports a stable node pairing timeout condition", () => {
    const readiness = buildHostingReadiness({
      profile: "node-mode",
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      nodeMode: {
        pairing: {
          pairedCount: 0,
          pendingCount: 0,
          timedOut: true,
          error: "Node pairing readiness exceeded 1000ms.",
        },
      },
    });

    expect(readiness.conditions).toContainEqual(
      expect.objectContaining({
        type: "NodePairingReady",
        status: "Unknown",
        reason: "NodePairingTimedOut",
      }),
    );
  });
});

describe("resolveHostingProfile", () => {
  it("uses startup override, environment, config, then local precedence", () => {
    expect(
      resolveHostingProfile({
        override: "reverse-proxy",
        env: { OPENCLAW_HOSTING_PROFILE: "container" },
        config: { hosting: { profile: "local" } },
      }),
    ).toBe("reverse-proxy");
    expect(
      resolveHostingProfile({
        env: { OPENCLAW_HOSTING_PROFILE: "container" },
        config: { hosting: { profile: "reverse-proxy" } },
      }),
    ).toBe("container");
    expect(resolveHostingProfile({ config: { hosting: { profile: "reverse-proxy" } } })).toBe(
      "reverse-proxy",
    );
    expect(resolveHostingProfile()).toBe("local");
  });

  it("fails closed for an invalid explicit environment profile", () => {
    expect(() =>
      resolveHostingProfile({
        env: { OPENCLAW_HOSTING_PROFILE: "unknown" },
        config: { hosting: { profile: "container" } },
      }),
    ).toThrow(/Invalid hosting profile from OPENCLAW_HOSTING_PROFILE/);
  });
});
