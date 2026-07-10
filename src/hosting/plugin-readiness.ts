import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginReadinessCriterionRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import type { HostingReadinessCondition } from "./readiness.js";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

export type PluginReadinessProviderDescriptor = {
  id: string;
  pluginId: string;
  pluginName?: string;
  description: string;
};

export function listPluginReadinessProviders(
  registry: Pick<PluginRegistry, "readinessCriteria">,
): PluginReadinessProviderDescriptor[] {
  return registry.readinessCriteria.map((registration) => ({
    id: registration.id,
    pluginId: registration.pluginId,
    ...(registration.pluginName ? { pluginName: registration.pluginName } : {}),
    description: registration.criterion.description,
  }));
}

type CachedEvaluation = {
  expiresAt: number;
  value: Promise<HostingReadinessCondition>;
};

function unavailableCondition(
  registration: PluginReadinessCriterionRegistration,
  reason: string,
  message: string,
): HostingReadinessCondition {
  return {
    type: registration.id,
    status: "Unknown",
    requirement: "advisory",
    reason,
    message,
  };
}

async function evaluateRegistration(params: {
  registration: PluginReadinessCriterionRegistration;
  config: OpenClawConfig;
  timeoutMs: number;
}): Promise<HostingReadinessCondition> {
  const { registration } = params;
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(
        registration.criterion.check({
          config: params.config,
          pluginConfig: registration.pluginConfig,
          signal: controller.signal,
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("readiness criterion timed out"));
        }, params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (
      !result ||
      !["True", "False", "Unknown"].includes(result.status) ||
      typeof result.reason !== "string" ||
      !result.reason.trim() ||
      typeof result.message !== "string" ||
      !result.message.trim()
    ) {
      return unavailableCondition(
        registration,
        "CriterionInvalidResult",
        `Readiness criterion ${registration.id} returned an invalid result.`,
      );
    }
    return {
      type: registration.id,
      status: result.status,
      requirement: "advisory",
      reason: result.reason,
      message: result.message,
    };
  } catch {
    const timedOut = controller.signal.aborted;
    return unavailableCondition(
      registration,
      timedOut ? "CriterionTimedOut" : "CriterionCheckFailed",
      timedOut
        ? `Readiness criterion ${registration.id} exceeded ${params.timeoutMs}ms.`
        : `Readiness criterion ${registration.id} could not be evaluated.`,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createPluginReadinessResolver(options?: {
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options?.now ?? Date.now;
  const cache = new WeakMap<PluginReadinessCriterionRegistration, CachedEvaluation>();

  return async (params: {
    registry: Pick<PluginRegistry, "readinessCriteria">;
    config: OpenClawConfig;
  }): Promise<HostingReadinessCondition[]> => {
    const evaluated = params.registry.readinessCriteria.map((registration) => {
      const cached = cache.get(registration);
      const currentTime = now();
      if (cached && cached.expiresAt > currentTime) {
        return cached.value;
      }
      const value = evaluateRegistration({ registration, config: params.config, timeoutMs });
      cache.set(registration, { expiresAt: currentTime + cacheTtlMs, value });
      return value;
    });
    return Promise.all(evaluated);
  };
}
