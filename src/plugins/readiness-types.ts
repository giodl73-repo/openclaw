import type { OpenClawConfig } from "../config/types.openclaw.js";

export type OpenClawPluginReadinessResult = Readonly<{
  status: "True" | "False" | "Unknown";
  reason: string;
  message: string;
}>;

/** One plugin-owned readiness check. Core publishes it as plugin.<plugin-id>.<id>. */
export type OpenClawPluginReadinessCriterion = Readonly<{
  id: string;
  description: string;
  check: (ctx: {
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    signal: AbortSignal;
  }) => OpenClawPluginReadinessResult | Promise<OpenClawPluginReadinessResult>;
}>;
