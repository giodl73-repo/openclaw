import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type HealthCheckContext,
} from "openclaw/plugin-sdk/health";
import { evaluatePolicy } from "./doctor/register.js";
import {
  buildPolicySettingsConstraints,
  type PolicySettingsConstraintsReport,
} from "./settings-constraints.js";

export function policyCommandConfig(cfg: HealthCheckContext["cfg"]): HealthCheckContext["cfg"] {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        policy: {
          ...cfg.plugins?.entries?.["policy"],
          enabled: true,
          config: {
            enabled: true,
            ...(typeof cfg.plugins?.entries?.["policy"]?.config === "object" &&
            cfg.plugins.entries["policy"].config !== null
              ? cfg.plugins.entries["policy"].config
              : {}),
          },
        },
      },
    },
  };
}

export async function buildActivePolicySettingsConstraints(params: {
  cfg: HealthCheckContext["cfg"];
  cwd?: string;
  configPath?: string;
}): Promise<PolicySettingsConstraintsReport> {
  const cfg = policyCommandConfig(params.cfg);
  const cwd = params.cwd ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const evaluation = await evaluatePolicy({
    mode: "lint",
    runtime: {
      log() {},
      error() {},
      exit() {},
    },
    cfg,
    cwd,
    ...(params.configPath !== undefined ? { configPath: params.configPath } : {}),
  });
  return buildPolicySettingsConstraints(evaluation.policy?.value, evaluation.policyPath);
}
