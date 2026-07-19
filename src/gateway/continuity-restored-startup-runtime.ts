import { setTimeout as sleep } from "node:timers/promises";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import { getCurrentProviderAuthStates } from "../agents/model-provider-auth-state.js";
import { warmCurrentProviderAuthStateOffMainThread } from "../agents/model-provider-auth.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveModelRefFromString } from "../agents/model-selection-shared.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ContinuityRestoreCompleteDependencies,
  GatewayReadinessEvidence,
  OwnerReadinessFinding,
  RequiredOwnerReadinessRequirement,
} from "../continuity/restore-complete.js";
import { resolveContinuityWakeDescriptorFromStore } from "../continuity/wake-descriptor.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { buildPluginDependencyStatus } from "../plugins/status-dependencies-core.js";
import type { PluginDependencySpecMap } from "../plugins/status-dependencies-core.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime-state.js";
import {
  runContinuityRestoredStartupFromEnvironment,
  type ContinuityRestoredStartupResult,
} from "./continuity-restored-startup.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";
import type { ReadinessChecker, ReadinessResult } from "./server/readiness.js";

const RESTORED_STARTUP_READINESS_TIMEOUT_MS = 30_000;
const RESTORED_STARTUP_READINESS_POLL_MS = 100;

type SecretsReadinessSnapshot = {
  warnings: ReadonlyArray<{ code: string; path: string }>;
  authStores: ReadonlyArray<{ agentDir: string }>;
} | null;

type ProviderAuthReadinessState = ReadonlyMap<
  string,
  {
    agentId: string;
    configFingerprint: string;
    providers: ReadonlyMap<string, boolean>;
  }
> | null;

type PluginDependencyMetadata = ReadonlyMap<
  string,
  {
    packageDependencies?: PluginDependencySpecMap;
    packageOptionalDependencies?: PluginDependencySpecMap;
  }
> | null;

type RequiredProviderAuth = ReadonlyMap<string, readonly string[]>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function evidenceIdentity(value: unknown): string {
  const payload = JSON.stringify(canonicalize(value));
  if (payload === undefined) {
    throw new Error("Continuity readiness evidence is not JSON-serializable.");
  }
  return `sha256:${sha256Hex(payload)}`;
}

function pluginReadinessFinding(
  requirement: RequiredOwnerReadinessRequirement,
  registry: PluginRegistry,
  metadata: PluginDependencyMetadata,
  expectedPluginIds: readonly string[] | null,
  diagnostics: readonly PluginDiagnostic[] | null,
): OwnerReadinessFinding {
  const expectedIds = new Set(expectedPluginIds ?? []);
  const recordsById = new Map(registry.plugins.map((plugin) => [plugin.id, plugin]));
  const relevantIds = new Set([
    ...expectedIds,
    ...registry.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
  ]);
  const plugins = [...relevantIds]
    .map((pluginId) => {
      const plugin = recordsById.get(pluginId);
      if (!plugin) {
        return {
          id: pluginId,
          enabled: true,
          status: "missing",
          dependencyMetadataAvailable: false,
          requiredDependenciesInstalled: false,
        };
      }
      const manifest = metadata?.get(plugin.id);
      const dependencyStatus =
        plugin.dependencyStatus ??
        (manifest
          ? buildPluginDependencyStatus({
              rootDir: plugin.rootDir,
              dependencies: manifest.packageDependencies,
              optionalDependencies: manifest.packageOptionalDependencies,
            })
          : null);
      return {
        id: plugin.id,
        enabled: plugin.enabled,
        status: plugin.status,
        dependencyMetadataAvailable: dependencyStatus !== null,
        requiredDependenciesInstalled: dependencyStatus?.requiredInstalled ?? false,
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const blockingDiagnostics =
    diagnostics
      ?.filter(
        (diagnostic) =>
          diagnostic.level === "error" &&
          (!diagnostic.pluginId || expectedIds.has(diagnostic.pluginId)),
      )
      .map((diagnostic) => ({ pluginId: diagnostic.pluginId ?? null })) ?? [];
  const ready =
    metadata !== null &&
    expectedPluginIds !== null &&
    diagnostics !== null &&
    blockingDiagnostics.length === 0 &&
    plugins.every(
      (plugin) =>
        !plugin.enabled ||
        (plugin.status === "loaded" && plugin.requiredDependenciesInstalled === true),
    );
  return {
    ...requirement,
    ready,
    evidenceIdentity: evidenceIdentity({ blockingDiagnostics, plugins }),
    ...(!ready
      ? {
          detail: "enabled plugin runtime or required dependencies are not ready",
        }
      : {}),
  };
}

function secretsReadinessFinding(
  requirement: RequiredOwnerReadinessRequirement,
  snapshot: SecretsReadinessSnapshot,
): OwnerReadinessFinding {
  const warnings =
    snapshot?.warnings
      .map((warning) => ({ code: warning.code, path: warning.path }))
      .toSorted((left, right) =>
        left.code === right.code
          ? left.path.localeCompare(right.path)
          : left.code.localeCompare(right.code),
      ) ?? [];
  const blockingWarnings = warnings.filter((warning) => warning.code.endsWith("_NO_FALLBACK"));
  const ready = snapshot !== null && blockingWarnings.length === 0;
  return {
    ...requirement,
    ready,
    evidenceIdentity: evidenceIdentity({ active: snapshot !== null, warnings }),
    ...(!ready
      ? {
          detail: "active secret resolution contains unresolved required references",
        }
      : {}),
  };
}

function authProfileReadinessFinding(
  requirement: RequiredOwnerReadinessRequirement,
  secretsSnapshot: SecretsReadinessSnapshot,
  providerStates: ProviderAuthReadinessState,
  requiredProviders: RequiredProviderAuth,
): OwnerReadinessFinding {
  const authStores =
    secretsSnapshot?.authStores
      .map((entry) => entry.agentDir)
      .toSorted((left, right) => left.localeCompare(right)) ?? [];
  const providers = providerStates
    ? [...providerStates.values()]
        .map((state) => ({
          agentId: state.agentId,
          configFingerprint: state.configFingerprint,
          providers: [...state.providers.entries()].toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        }))
        .toSorted((left, right) => left.agentId.localeCompare(right.agentId))
    : [];
  const unavailableAgents = [...requiredProviders.entries()]
    .filter(([agentId, providerIds]) => {
      const state = providerStates?.get(agentId);
      return !state || !providerIds.some((providerId) => state.providers.get(providerId) === true);
    })
    .map(([agentId]) => agentId)
    .toSorted();
  const ready =
    secretsSnapshot !== null && providerStates !== null && unavailableAgents.length === 0;
  return {
    ...requirement,
    ready,
    evidenceIdentity: evidenceIdentity({
      authStores,
      providers,
      requiredProviders: [...requiredProviders.entries()].toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    }),
    ...(!ready
      ? {
          detail:
            unavailableAgents.length > 0
              ? `configured provider auth is unavailable for agents: ${unavailableAgents.join(", ")}`
              : "auth-profile runtime state has not been prepared",
        }
      : {}),
  };
}

export function resolveContinuityOwnerReadiness(params: {
  requirements: readonly RequiredOwnerReadinessRequirement[];
  pluginRegistry: PluginRegistry;
  pluginDependencyMetadata: PluginDependencyMetadata;
  expectedPluginIds: readonly string[] | null;
  pluginDiagnostics: readonly PluginDiagnostic[] | null;
  secretsSnapshot: SecretsReadinessSnapshot;
  providerAuthStates: ProviderAuthReadinessState;
  requiredProviderAuth: RequiredProviderAuth;
}): OwnerReadinessFinding[] {
  return params.requirements.map((requirement) => {
    switch (requirement.owner) {
      case "plugins":
        return pluginReadinessFinding(
          requirement,
          params.pluginRegistry,
          params.pluginDependencyMetadata,
          params.expectedPluginIds,
          params.pluginDiagnostics,
        );
      case "secrets":
        return secretsReadinessFinding(requirement, params.secretsSnapshot);
      case "auth-profiles":
        return authProfileReadinessFinding(
          requirement,
          params.secretsSnapshot,
          params.providerAuthStates,
          params.requiredProviderAuth,
        );
    }
  });
}

export function resolveRequiredProviderAuth(config: OpenClawConfig): RequiredProviderAuth {
  return new Map(
    listAgentIds(config).map((agentId) => {
      const primary = resolveDefaultModelForAgent({ cfg: config, agentId });
      const fallbacks =
        resolveAgentModelFallbacksOverride(config, agentId) ??
        resolveAgentModelFallbackValues(config.agents?.defaults?.model);
      const providerIds = new Set([primary.provider]);
      for (const fallback of fallbacks) {
        const resolved = resolveModelRefFromString({
          cfg: config,
          raw: fallback,
          defaultProvider: primary.provider,
        });
        if (resolved) {
          providerIds.add(resolved.ref.provider);
        }
      }
      return [agentId, [...providerIds].toSorted()] as const;
    }),
  );
}

function gatewayReadinessEvidence(readiness: ReadinessResult): GatewayReadinessEvidence {
  const failing = [...readiness.failing].toSorted();
  const suppressed = [...(readiness.suppressed ?? [])].toSorted();
  return {
    ready: readiness.ready,
    failing,
    generation: evidenceIdentity({
      ready: readiness.ready,
      failing,
      suppressed,
    }),
  };
}

export async function waitForContinuityGatewayReadiness(params: {
  getReadiness: ReadinessChecker;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<GatewayReadinessEvidence> {
  const timeoutMs = params.timeoutMs ?? RESTORED_STARTUP_READINESS_TIMEOUT_MS;
  const pollMs = params.pollMs ?? RESTORED_STARTUP_READINESS_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let readiness = params.getReadiness();
  while (!readiness.ready && Date.now() < deadline) {
    await sleep(pollMs);
    readiness = params.getReadiness();
  }
  return gatewayReadinessEvidence(readiness);
}

export function createGatewayContinuityRestoreDependencies(params: {
  config: OpenClawConfig;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  markCronStartHandled: () => void;
  getPluginRegistry: () => PluginRegistry;
  getPluginDependencyMetadata?: () => PluginDependencyMetadata;
  getExpectedPluginIds?: () => readonly string[] | null;
  getPluginDiagnostics?: () => readonly PluginDiagnostic[] | null;
  getReadiness: ReadinessChecker;
  isClosing: () => boolean;
  warmProviderAuthState?: () => Promise<void>;
  getSecretsSnapshot?: () => SecretsReadinessSnapshot;
  getProviderAuthStates?: () => ProviderAuthReadinessState;
}): ContinuityRestoreCompleteDependencies {
  return {
    reconcileScheduler: async () => {
      const reconciliation = params.cronReconciliation.arm({
        reason: "startup",
        config: params.config,
        cronState: params.cronState,
      });
      params.markCronStartHandled();
      await params.cronState.cron.start();
      await reconciliation.complete();
    },
    resolveWakeDescriptor: () =>
      resolveContinuityWakeDescriptorFromStore(
        params.cronState.storePath,
        params.cronState.cronEnabled,
      ),
    resolveOwnerReadiness: async (requirements) => {
      await (
        params.warmProviderAuthState ??
        (() =>
          warmCurrentProviderAuthStateOffMainThread(params.config, {
            isCancelled: params.isClosing,
          }))
      )();
      return resolveContinuityOwnerReadiness({
        requirements,
        pluginRegistry: params.getPluginRegistry(),
        pluginDependencyMetadata: params.getPluginDependencyMetadata?.() ?? null,
        expectedPluginIds: params.getExpectedPluginIds?.() ?? null,
        pluginDiagnostics: params.getPluginDiagnostics?.() ?? null,
        secretsSnapshot:
          params.getSecretsSnapshot?.() ??
          (() => {
            const snapshot = getActiveSecretsRuntimeSnapshot();
            return snapshot
              ? {
                  warnings: snapshot.warnings,
                  authStores: snapshot.authStores.map((entry) => ({
                    agentDir: entry.agentDir,
                  })),
                }
              : null;
          })(),
        providerAuthStates: params.getProviderAuthStates?.() ?? getCurrentProviderAuthStates(),
        requiredProviderAuth: resolveRequiredProviderAuth(params.config),
      });
    },
    resolveGatewayReadiness: () =>
      waitForContinuityGatewayReadiness({ getReadiness: params.getReadiness }),
  };
}

export async function runGatewayContinuityRestoredStartup(params: {
  env?: NodeJS.ProcessEnv;
  dependencies: ContinuityRestoreCompleteDependencies;
  writeLine?: (line: string) => void;
  beforeSuccessResult?: () => void | Promise<void>;
}): Promise<ContinuityRestoredStartupResult | null> {
  let resultLine: string | undefined;
  const result = await runContinuityRestoredStartupFromEnvironment(
    params.env ?? process.env,
    params.dependencies,
    (line) => {
      resultLine = line;
    },
  );
  if (!result) {
    return null;
  }
  if (result.ok) {
    await params.beforeSuccessResult?.();
  }
  if (resultLine === undefined) {
    throw new Error("Continuity restored-startup did not produce a result line.");
  }
  (params.writeLine ?? ((line) => process.stdout.write(`${line}\n`)))(resultLine);
  return result;
}
