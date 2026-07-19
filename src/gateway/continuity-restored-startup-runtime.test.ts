import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  createGatewayContinuityRestoreDependencies,
  resolveContinuityOwnerReadiness,
  resolveRequiredProviderAuth,
  runGatewayContinuityRestoredStartup,
  waitForContinuityGatewayReadiness,
} from "./continuity-restored-startup-runtime.js";

function pluginRegistry(status: "loaded" | "error" = "loaded"): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: "calendar",
    name: "calendar",
    source: "fixture",
    origin: "workspace",
    enabled: true,
    status,
  } as (typeof registry.plugins)[number]);
  return registry;
}

const requirements = [
  {
    obligationId: "reconstructed.pluginRuntimeDependencies" as const,
    owner: "plugins" as const,
  },
  {
    obligationId: "external.configSecretReferences" as const,
    owner: "secrets" as const,
  },
  {
    obligationId: "external.authProfileCredentials" as const,
    owner: "auth-profiles" as const,
  },
];
const pluginDependencyMetadata = new Map([["calendar", {}]]);
const expectedPluginIds = ["calendar"];
const pluginDiagnostics: [] = [];
const requiredProviderAuth = new Map([["main", ["openai"]]]);

describe("continuity restored-startup runtime", () => {
  it("does not activate restored owners during ordinary startup", async () => {
    const dependencies = {
      reconcileScheduler: vi.fn(async () => {}),
      resolveWakeDescriptor: vi.fn(),
      resolveOwnerReadiness: vi.fn(),
      resolveGatewayReadiness: vi.fn(),
    };
    const writeLine = vi.fn();

    await expect(
      runGatewayContinuityRestoredStartup({
        env: {},
        dependencies,
        writeLine,
      }),
    ).resolves.toBeNull();

    expect(dependencies.reconcileScheduler).not.toHaveBeenCalled();
    expect(dependencies.resolveWakeDescriptor).not.toHaveBeenCalled();
    expect(dependencies.resolveOwnerReadiness).not.toHaveBeenCalled();
    expect(dependencies.resolveGatewayReadiness).not.toHaveBeenCalled();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it("derives primary and fallback provider requirements from active config", () => {
    expect(
      resolveRequiredProviderAuth({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      }),
    ).toEqual(new Map([["main", ["anthropic", "openai"]]]));
  });

  it("derives exact owner findings from native runtime snapshots", () => {
    const findings = resolveContinuityOwnerReadiness({
      requirements,
      pluginRegistry: pluginRegistry(),
      pluginDependencyMetadata,
      expectedPluginIds,
      pluginDiagnostics,
      secretsSnapshot: {
        warnings: [],
        authStores: [{ agentDir: "/agent/main" }],
      },
      providerAuthStates: new Map([
        [
          "main",
          {
            agentId: "main",
            configFingerprint: "config-1",
            providers: new Map([["openai", true]]),
          },
        ],
      ]),
      requiredProviderAuth,
    });

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.ready)).toBe(true);
    expect(
      findings.every((finding) => /^sha256:[a-f0-9]{64}$/.test(finding.evidenceIdentity)),
    ).toBe(true);
  });

  it("fails closed for plugin errors and unresolved secret references", () => {
    const findings = resolveContinuityOwnerReadiness({
      requirements,
      pluginRegistry: pluginRegistry("error"),
      pluginDependencyMetadata,
      expectedPluginIds,
      pluginDiagnostics,
      secretsSnapshot: {
        warnings: [
          {
            code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
            path: "tools.web.search",
          },
        ],
        authStores: [],
      },
      providerAuthStates: null,
      requiredProviderAuth,
    });

    expect(findings.map((finding) => finding.ready)).toEqual([false, false, false]);
  });

  it("fails plugin readiness without authoritative dependency metadata", () => {
    const findings = resolveContinuityOwnerReadiness({
      requirements,
      pluginRegistry: pluginRegistry(),
      pluginDependencyMetadata: null,
      expectedPluginIds,
      pluginDiagnostics,
      secretsSnapshot: {
        warnings: [],
        authStores: [{ agentDir: "/agent/main" }],
      },
      providerAuthStates: new Map([
        [
          "main",
          {
            agentId: "main",
            configFingerprint: "config-1",
            providers: new Map([["openai", true]]),
          },
        ],
      ]),
      requiredProviderAuth,
    });

    expect(findings.map((finding) => finding.ready)).toEqual([false, true, true]);
  });

  it("fails plugin readiness when expected plugin discovery reports an error", () => {
    const registry = createEmptyPluginRegistry();
    const findings = resolveContinuityOwnerReadiness({
      requirements,
      pluginRegistry: registry,
      pluginDependencyMetadata,
      expectedPluginIds,
      pluginDiagnostics: [
        {
          level: "error",
          pluginId: "calendar",
          message: "configured plugin manifest is missing",
        },
      ],
      secretsSnapshot: {
        warnings: [],
        authStores: [{ agentDir: "/agent/main" }],
      },
      providerAuthStates: new Map([
        [
          "main",
          {
            agentId: "main",
            configFingerprint: "config-1",
            providers: new Map([["openai", true]]),
          },
        ],
      ]),
      requiredProviderAuth,
    });

    expect(findings.map((finding) => finding.ready)).toEqual([false, true, true]);
  });

  it("accepts a prepared auth snapshot with unconfigured catalog providers", () => {
    const findings = resolveContinuityOwnerReadiness({
      requirements,
      pluginRegistry: pluginRegistry(),
      pluginDependencyMetadata,
      expectedPluginIds,
      pluginDiagnostics,
      secretsSnapshot: {
        warnings: [],
        authStores: [{ agentDir: "/agent/main" }],
      },
      providerAuthStates: new Map([
        [
          "main",
          {
            agentId: "main",
            configFingerprint: "config-1",
            providers: new Map([
              ["openai", true],
              ["anthropic", false],
            ]),
          },
        ],
      ]),
      requiredProviderAuth,
    });

    expect(findings.map((finding) => finding.ready)).toEqual([true, true, true]);
  });

  it("fails when every configured provider for an agent is unavailable", () => {
    const findings = resolveContinuityOwnerReadiness({
      requirements,
      pluginRegistry: pluginRegistry(),
      pluginDependencyMetadata,
      expectedPluginIds,
      pluginDiagnostics,
      secretsSnapshot: {
        warnings: [],
        authStores: [{ agentDir: "/agent/main" }],
      },
      providerAuthStates: new Map([
        [
          "main",
          {
            agentId: "main",
            configFingerprint: "config-1",
            providers: new Map([["openai", false]]),
          },
        ],
      ]),
      requiredProviderAuth,
    });

    expect(findings.map((finding) => finding.ready)).toEqual([true, true, false]);
  });

  it("waits for base Gateway readiness without consulting continuity admission", async () => {
    const getReadiness = vi
      .fn()
      .mockReturnValueOnce({
        ready: false,
        failing: ["startup-sidecars"],
        uptimeMs: 1,
      })
      .mockReturnValue({ ready: true, failing: [], uptimeMs: 2 });

    const result = await waitForContinuityGatewayReadiness({
      getReadiness,
      timeoutMs: 50,
      pollMs: 1,
    });

    expect(result).toMatchObject({ ready: true, failing: [] });
    expect(result.generation).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reconciles the live cron service before owner and Gateway readiness", async () => {
    const events: string[] = [];
    const complete = vi.fn(async () => {
      events.push("cron-reconciled");
    });
    const dependencies = createGatewayContinuityRestoreDependencies({
      config: {},
      cronState: {
        cron: {
          start: async () => {
            events.push("cron-started");
          },
        } as never,
        storePath: "/cron/jobs.json",
        cronEnabled: true,
      },
      cronReconciliation: {
        arm: () => ({ complete }),
        invalidate: () => undefined,
      },
      markCronStartHandled: () => {
        events.push("cron-owned");
      },
      getPluginRegistry: () => pluginRegistry(),
      getPluginDependencyMetadata: () => pluginDependencyMetadata,
      getExpectedPluginIds: () => expectedPluginIds,
      getPluginDiagnostics: () => pluginDiagnostics,
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
      isClosing: () => false,
      warmProviderAuthState: async () => {
        events.push("auth-warmed");
      },
      getSecretsSnapshot: () => ({ warnings: [], authStores: [] }),
      getProviderAuthStates: () => new Map(),
    });

    await dependencies.reconcileScheduler();
    await dependencies.resolveOwnerReadiness(requirements);
    await dependencies.resolveGatewayReadiness();

    expect(events).toEqual(["cron-owned", "cron-started", "cron-reconciled", "auth-warmed"]);
  });
});
