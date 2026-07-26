import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginReadinessCriterionRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import { READINESS_REASON_PATTERN, sanitizeProviderReadinessMessage } from "./sanitize.js";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_PENDING_RETRY_MS = 30_000;
const MAX_PENDING_CHECKS_PER_CRITERION = 2;

export type ResolvedPluginReadinessCondition = Readonly<{
  type: string;
  status: "True" | "False" | "Unknown";
  reason: string;
  message: string;
}>;

type CachedEvaluation = {
  expiresAt: number;
  value: Promise<ResolvedPluginReadinessCondition>;
  rawPending: boolean;
  pendingRetryAt: number;
};

type ResolverScope = {
  cache: WeakMap<PluginReadinessCriterionRegistration, CachedEvaluation>;
  inFlightCounts: WeakMap<PluginReadinessCriterionRegistration, number>;
};

function unavailableCondition(
  registration: PluginReadinessCriterionRegistration,
  reason: string,
  message: string,
): ResolvedPluginReadinessCondition {
  return Object.freeze({ type: registration.id, status: "Unknown", reason, message });
}

async function evaluateRegistration(params: {
  registration: PluginReadinessCriterionRegistration;
  raw: Promise<Awaited<ReturnType<PluginReadinessCriterionRegistration["criterion"]["check"]>>>;
  controller: AbortController;
  timeoutMs: number;
}): Promise<ResolvedPluginReadinessCondition> {
  const { registration } = params;
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      params.raw,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          params.controller.abort();
          reject(new Error("readiness criterion timed out"));
        }, params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
    const message =
      result && typeof result.message === "string"
        ? sanitizeProviderReadinessMessage(result.message)
        : undefined;
    if (
      !result ||
      !["True", "False", "Unknown"].includes(result.status) ||
      typeof result.reason !== "string" ||
      !READINESS_REASON_PATTERN.test(result.reason) ||
      !message
    ) {
      return unavailableCondition(
        registration,
        "CriterionInvalidResult",
        "Readiness criterion " + registration.id + " returned an invalid result.",
      );
    }
    return Object.freeze({
      type: registration.id,
      status: result.status,
      reason: result.reason,
      message,
    });
  } catch {
    return unavailableCondition(
      registration,
      timedOut ? "CriterionTimedOut" : "CriterionCheckFailed",
      timedOut
        ? "Readiness criterion " + registration.id + " exceeded " + params.timeoutMs + "ms."
        : "Readiness criterion " + registration.id + " could not be evaluated.",
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Resolves selected plugin criteria with bounded, cancellable, registry-scoped caching. */
export function createPluginReadinessResolver(options?: {
  timeoutMs?: number;
  cacheTtlMs?: number;
  pendingRetryMs?: number;
  now?: () => number;
}) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const pendingRetryMs = options?.pendingRetryMs ?? DEFAULT_PENDING_RETRY_MS;
  const now = options?.now ?? Date.now;
  const scopes = new WeakMap<
    Pick<PluginRegistry, "readinessCriteria">,
    WeakMap<OpenClawConfig, ResolverScope>
  >();
  const resolveScope = (
    registry: Pick<PluginRegistry, "readinessCriteria">,
    config: OpenClawConfig,
  ): ResolverScope => {
    let configScopes = scopes.get(registry);
    if (!configScopes) {
      configScopes = new WeakMap();
      scopes.set(registry, configScopes);
    }
    let scope = configScopes.get(config);
    if (!scope) {
      scope = { cache: new WeakMap(), inFlightCounts: new WeakMap() };
      configScopes.set(config, scope);
    }
    return scope;
  };

  return async (params: {
    registry: Pick<PluginRegistry, "readinessCriteria">;
    config: OpenClawConfig;
    criterionIds?: ReadonlySet<string>;
  }): Promise<readonly ResolvedPluginReadinessCondition[]> => {
    const scope = resolveScope(params.registry, params.config);
    const registrations = params.criterionIds
      ? params.registry.readinessCriteria.filter((entry) => params.criterionIds?.has(entry.id))
      : params.registry.readinessCriteria;
    const evaluated = registrations.map((registration) => {
      const cached = scope.cache.get(registration);
      const currentTime = now();
      if (cached) {
        const pendingChecks = scope.inFlightCounts.get(registration) ?? 0;
        if (
          cached.expiresAt > currentTime ||
          (cached.rawPending &&
            (cached.pendingRetryAt > currentTime ||
              pendingChecks >= MAX_PENDING_CHECKS_PER_CRITERION))
        ) {
          return cached.value;
        }
      }
      const controller = new AbortController();
      scope.inFlightCounts.set(registration, (scope.inFlightCounts.get(registration) ?? 0) + 1);
      const raw = Promise.resolve().then(() =>
        registration.criterion.check({
          config: params.config,
          pluginConfig: registration.pluginConfig,
          signal: controller.signal,
        }),
      );
      const value = evaluateRegistration({ registration, raw, controller, timeoutMs });
      const entry: CachedEvaluation = {
        expiresAt: currentTime + cacheTtlMs,
        value,
        rawPending: true,
        pendingRetryAt: currentTime + pendingRetryMs,
      };
      scope.cache.set(registration, entry);
      const settleRaw = () => {
        entry.rawPending = false;
        const remaining = (scope.inFlightCounts.get(registration) ?? 1) - 1;
        if (remaining > 0) {
          scope.inFlightCounts.set(registration, remaining);
        } else {
          scope.inFlightCounts.delete(registration);
        }
      };
      void raw.then(settleRaw, settleRaw);
      return value;
    });
    return Object.freeze(await Promise.all(evaluated));
  };
}
