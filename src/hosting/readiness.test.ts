import { describe, expect, it } from "vitest";
import {
  buildHostingReadiness,
  buildLocalHostingReadiness,
  buildNodeModeHostingReadiness,
  parseHostingProfileId,
  resolveHostingProfile,
} from "./readiness.js";

describe("buildLocalHostingReadiness", () => {
  it("returns the local profile as ready when required conditions pass", () => {
    const readiness = buildLocalHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      plugins: { errors: [] },
    });

    expect(readiness).toMatchObject({
      profile: "local",
      ready: true,
      failures: [],
    });
    expect(readiness.conditions.map((condition) => [condition.type, condition.status])).toEqual([
      ["ProfileSelected", "True"],
      ["ConfigLoaded", "True"],
      ["GatewayResponding", "True"],
      ["WorkspaceUsable", "True"],
      ["PluginsLoaded", "True"],
    ]);
  });

  it("reports the selected non-local profile without changing base checks", () => {
    const readiness = buildLocalHostingReadiness({
      profile: "container",
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(readiness).toMatchObject({
      profile: "container",
      ready: true,
    });
    expect(readiness.conditions[0]).toMatchObject({
      type: "ProfileSelected",
      status: "True",
      reason: "ProfileSelected",
    });
  });

  it("fails readiness when the host expected a different profile", () => {
    const readiness = buildLocalHostingReadiness({
      profile: "local",
      expectedProfile: "managed",
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(readiness).toMatchObject({
      profile: "local",
      expectedProfile: "managed",
      ready: false,
      failures: ["ProfileMismatch"],
    });
    expect(readiness.conditions[0]).toMatchObject({
      type: "ProfileSelected",
      status: "False",
      reason: "ProfileMismatch",
    });
  });

  it("resolves profile from override, env, config, then local default", () => {
    expect(
      resolveHostingProfile({
        override: "managed",
        env: { OPENCLAW_HOSTING_PROFILE: "container" } as NodeJS.ProcessEnv,
        config: { hosting: { profile: "reverse-proxy" } },
      }),
    ).toBe("managed");
    expect(
      resolveHostingProfile({
        env: { OPENCLAW_HOSTING_PROFILE: "container" } as NodeJS.ProcessEnv,
        config: { hosting: { profile: "reverse-proxy" } },
      }),
    ).toBe("container");
    expect(resolveHostingProfile({ config: { hosting: { profile: "reverse-proxy" } } })).toBe(
      "reverse-proxy",
    );
    expect(resolveHostingProfile()).toBe("local");
  });

  it("resolves declared custom profiles from config and env", () => {
    const config = {
      hosting: {
        profile: "acme.managed",
        profiles: {
          "acme.managed": {
            extends: "container" as const,
          },
        },
      },
    };

    expect(resolveHostingProfile({ config })).toBe("acme.managed");
    expect(
      resolveHostingProfile({
        config,
        env: { OPENCLAW_HOSTING_PROFILE: "acme.managed" } as NodeJS.ProcessEnv,
      }),
    ).toBe("acme.managed");
  });

  it("falls back to local for undeclared custom profile selections", () => {
    expect(
      resolveHostingProfile({
        config: { hosting: { profile: "acme.missing" } },
      }),
    ).toBe("local");
  });

  it("parses only built-in profile ids", () => {
    expect(parseHostingProfileId("node-mode")).toBe("node-mode");
    expect(parseHostingProfileId("acme.managed")).toBe("acme.managed");
    expect(parseHostingProfileId("bad-profile")).toBeNull();
  });

  it("does not fail status-only readiness when gateway was not checked", () => {
    const readiness = buildLocalHostingReadiness({
      configLoaded: true,
      gateway: "not-checked",
      workspaceUsable: true,
    });

    expect(readiness.ready).toBe(true);
    expect(
      readiness.conditions.find((condition) => condition.type === "GatewayResponding"),
    ).toMatchObject({
      status: "Unknown",
      reason: "GatewayNotChecked",
    });
  });

  it("blocks readiness on enabled plugin load failures", () => {
    const readiness = buildLocalHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      plugins: {
        errors: [
          {
            id: "disabled-plugin",
            activationSource: "disabled",
            error: "disabled plugin ignored",
          },
          {
            id: "enabled-plugin",
            activated: true,
            activationSource: "explicit",
            error: "dependency missing",
          },
        ],
      },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["PluginLoadFailures"]);
    expect(
      readiness.conditions.find((condition) => condition.type === "PluginsLoaded"),
    ).toMatchObject({
      status: "False",
      reason: "PluginLoadFailures",
      message: "Plugin load failures: enabled-plugin: dependency missing",
    });
  });

  it("adds node-mode conditions when the node-mode profile is selected", () => {
    const readiness = buildNodeModeHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      nodeMode: {
        pairing: { pairedCount: 1, pendingCount: 0 },
        targets: { count: 1, connectedCount: 1 },
        commandApproval: { configured: true, approvedCommandCount: 2 },
        controlChannel: { status: "ready", target: "gateway.example:11912" },
        state: { workspaceUsable: true },
      },
    });

    expect(readiness).toMatchObject({
      profile: "node-mode",
      ready: true,
      failures: [],
    });
    const conditionStatuses = readiness.conditions.map((condition) => [
      condition.type,
      condition.status,
    ]);
    expect(conditionStatuses).toContainEqual(["NodePairingReady", "True"]);
    expect(conditionStatuses).toContainEqual(["ControlledTargetsReady", "True"]);
    expect(conditionStatuses).toContainEqual(["CommandApprovalReady", "True"]);
    expect(conditionStatuses).toContainEqual(["ControlChannelReady", "True"]);
    expect(conditionStatuses).toContainEqual(["StateReady", "True"]);
  });

  it("reports a stable not-ready reason when node-mode pairing is missing", () => {
    const readiness = buildNodeModeHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      nodeMode: {
        pairing: { pairedCount: 0, pendingCount: 0 },
        targets: { count: 0 },
        commandApproval: { configured: false, approvedCommandCount: 0 },
      },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("NodePairingMissing");
    expect(
      readiness.conditions.find((condition) => condition.type === "NodePairingReady"),
    ).toMatchObject({
      status: "False",
      reason: "NodePairingMissing",
    });
  });

  it("reports a stable not-ready reason when node-mode target inventory is missing", () => {
    const readiness = buildNodeModeHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      nodeMode: {
        pairing: { pairedCount: 1, pendingCount: 0 },
        targets: { count: 0 },
        commandApproval: { configured: true, approvedCommandCount: 1 },
      },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("ControlledTargetsMissing");
    expect(
      readiness.conditions.find((condition) => condition.type === "ControlledTargetsReady"),
    ).toMatchObject({
      status: "False",
      reason: "ControlledTargetsMissing",
    });
  });

  it("represents node-mode command approval posture in readiness evidence", () => {
    const readiness = buildNodeModeHostingReadiness({
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      nodeMode: {
        pairing: { pairedCount: 1, pendingCount: 0 },
        targets: { count: 1 },
        commandApproval: { configured: false, approvedCommandCount: 0 },
      },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("CommandApprovalMissing");
    expect(
      readiness.conditions.find((condition) => condition.type === "CommandApprovalReady"),
    ).toMatchObject({
      status: "False",
      reason: "CommandApprovalMissing",
    });
  });

  it("leaves local and container readiness on the base condition set", () => {
    const local = buildHostingReadiness({
      profile: "local",
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });
    const container = buildHostingReadiness({
      profile: "container",
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
      nodeMode: {
        pairing: { pairedCount: 0, pendingCount: 0 },
        targets: { count: 0 },
      },
    });

    expect(local.conditions.map((condition) => condition.type)).not.toContain("NodePairingReady");
    expect(container.conditions.map((condition) => condition.type)).not.toContain(
      "NodePairingReady",
    );
    expect(local.ready).toBe(true);
    expect(container.ready).toBe(true);
  });

  it("adds custom profile readiness conditions without redefining built-in checks", () => {
    const readiness = buildHostingReadiness({
      profile: "acme.managed",
      config: {
        hosting: {
          criteria: {
            "acme.backup-ready": {
              status: "True",
              reason: "BackupReady",
              message: "Backup volume restored.",
            },
          },
          profiles: {
            "acme.managed": {
              extends: "container",
              readiness: {
                requiredCriteria: ["acme.backup-ready"],
              },
            },
          },
        },
      },
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(readiness).toMatchObject({
      profile: "acme.managed",
      ready: true,
      failures: [],
    });
    expect(readiness.conditions.find((condition) => condition.type === "ProfileSelected"))
      .toMatchObject({
        status: "True",
      });
    expect(readiness.conditions.find((condition) => condition.type === "acme.backup-ready"))
      .toMatchObject({
        status: "True",
        reason: "BackupReady",
      });
  });

  it("supports warning-only custom readiness conditions", () => {
    const readiness = buildHostingReadiness({
      profile: "container",
      config: {
        hosting: {
          criteria: {
            "acme.telemetry-ready": {
              status: "False",
              reason: "TelemetryUnavailable",
              message: "Telemetry sink is unavailable.",
            },
          },
          readiness: {
            optionalCriteria: ["acme.telemetry-ready"],
          },
        },
      },
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.failures).toEqual([]);
    expect(readiness.conditions.find((condition) => condition.type === "acme.telemetry-ready"))
      .toMatchObject({
        status: "False",
        reason: "TelemetryUnavailable",
        blocking: false,
      });
  });

  it("blocks readiness on required custom conditions", () => {
    const readiness = buildHostingReadiness({
      profile: "container",
      config: {
        hosting: {
          criteria: {
            "acme.storage-ready": {
              status: "False",
              reason: "StorageUnavailable",
              message: "Storage is unavailable.",
            },
          },
          readiness: {
            requiredCriteria: ["acme.storage-ready"],
          },
        },
      },
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["StorageUnavailable"]);
  });

  it("blocks readiness when a referenced criterion is missing", () => {
    const readiness = buildHostingReadiness({
      profile: "container",
      config: {
        hosting: {
          readiness: {
            requiredCriteria: ["acme.missing-ready"],
          },
        },
      },
      configLoaded: true,
      gateway: "responding",
      workspaceUsable: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["CriterionMissing"]);
    expect(readiness.conditions.find((condition) => condition.type === "acme.missing-ready"))
      .toMatchObject({
        status: "False",
        reason: "CriterionMissing",
      });
  });
});
