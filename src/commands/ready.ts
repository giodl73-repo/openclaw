import { readBestEffortConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import {
  buildHostingReadiness,
  formatHostingProfileIds,
  parseHostingProfileId,
  resolveHostingProfile,
  type HostingProfileId,
  type HostingReadinessResult,
  withExpectedHostingProfile,
} from "../hosting/readiness.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { HealthSummary } from "./health.types.js";

type ReadyCommandOptions = {
  json?: boolean;
  timeoutMs?: number;
  config?: OpenClawConfig;
  token?: string;
  password?: string;
  localPortOverride?: number;
  expectProfile?: HostingProfileId;
};

function buildGatewayUnavailableReadiness(params: {
  config: OpenClawConfig;
  expectedProfile?: HostingProfileId;
}): HostingReadinessResult {
  return buildHostingReadiness({
    profile: resolveHostingProfile({ config: params.config, env: process.env }),
    config: params.config,
    expectedProfile: params.expectedProfile,
    configLoaded: true,
    gateway: "unavailable",
    workspaceUsable: true,
  });
}

function formatReadyText(readiness: HostingReadinessResult): string {
  if (readiness.ready) {
    return `ready: ${readiness.profile}`;
  }
  return `not ready: ${readiness.failures.join(", ") || "unknown"}`;
}

export async function readyCommand(opts: ReadyCommandOptions, runtime: RuntimeEnv): Promise<void> {
  const cfg = opts.config ?? (await readBestEffortConfig());
  const expectedProfile =
    opts.expectProfile === undefined ? undefined : parseHostingProfileId(opts.expectProfile);
  if (opts.expectProfile !== undefined && !expectedProfile) {
    runtime.error(`Invalid --expect-profile. Use ${formatHostingProfileIds()}.`);
    runtime.exit(1);
    return;
  }
  let readiness: HostingReadinessResult;
  try {
    const summary = await callGateway<HealthSummary>({
      method: "health",
      params: { probe: false },
      timeoutMs: opts.timeoutMs,
      config: cfg,
      token: opts.token,
      password: opts.password,
      localPortOverride: opts.localPortOverride,
    });
    readiness =
      summary.readiness ??
      buildHostingReadiness({
        profile: resolveHostingProfile({ config: cfg, env: process.env }),
        config: cfg,
        configLoaded: true,
        gateway: "responding",
        workspaceUsable: true,
        plugins: summary.plugins,
      });
    readiness = withExpectedHostingProfile(readiness, expectedProfile);
  } catch {
    readiness = buildGatewayUnavailableReadiness({ config: cfg, expectedProfile });
  }

  if (opts.json) {
    writeRuntimeJson(runtime, readiness);
  } else {
    runtime.log(formatReadyText(readiness));
  }
  if (!readiness.ready) {
    runtime.exit(1);
  }
}
