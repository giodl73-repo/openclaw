import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { StatusSummary } from "../commands/status.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

export type HealthFindingSeverity = "info" | "warning" | "error";

export const HEALTH_FINDING_SEVERITY_RANK: Record<HealthFindingSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export function parseHealthFindingSeverity(
  input: string | undefined,
): HealthFindingSeverity | null {
  if (input === "info" || input === "warning" || input === "error") {
    return input;
  }
  return null;
}

export function healthFindingMeetsSeverity(
  finding: Pick<HealthFinding, "severity">,
  severityMin: HealthFindingSeverity,
): boolean {
  return (
    HEALTH_FINDING_SEVERITY_RANK[finding.severity] >= HEALTH_FINDING_SEVERITY_RANK[severityMin]
  );
}

export interface HealthFinding {
  readonly checkId: string;
  readonly severity: HealthFindingSeverity;
  readonly message: string;
  readonly source?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly ocPath?: string;
  readonly fixHint?: string;
}

export type HealthCheckMode = "doctor" | "lint" | "fix";

export interface HealthCheckContext {
  readonly mode: HealthCheckMode;
  readonly runtime: RuntimeEnv;
  readonly cfg: OpenClawConfig;
  readonly cwd?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sourceConfigValid?: boolean;
  readonly sourceLastTouchedVersion?: string;
  readonly facts?: {
    readonly gatewayStatus?: StatusSummary;
    readonly gatewayMemoryProbe?: {
      readonly checked: boolean;
      readonly ready: boolean;
      readonly error?: string;
      readonly skipped: boolean;
    };
    readonly healthOk?: boolean;
    readonly gatewayDetailsMessage?: string;
  };
  readonly doctor?: {
    readonly options?: {
      readonly nonInteractive?: boolean;
      readonly deep?: boolean;
    };
    readonly confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
    readonly prompter?: DoctorPrompter;
  };
}

export interface HealthRepairContext extends Omit<HealthCheckContext, "mode"> {
  readonly mode: "fix";
}

export interface HealthRepairResult {
  readonly status?: "repaired" | "skipped" | "failed";
  readonly reason?: string;
  readonly config?: OpenClawConfig;
  readonly facts?: HealthCheckContext["facts"];
  readonly changes: readonly string[];
  readonly warnings?: readonly string[];
}

export interface HealthCheckScope {
  readonly findings?: readonly HealthFinding[];
  readonly paths?: readonly string[];
  readonly ocPaths?: readonly string[];
}

export interface HealthCheck {
  readonly id: string;
  readonly kind: "core" | "plugin";
  readonly description: string;
  readonly source?: string;
  detect(ctx: HealthCheckContext, scope?: HealthCheckScope): Promise<readonly HealthFinding[]>;
  repair?(
    ctx: HealthRepairContext,
    findings: readonly HealthFinding[],
  ): Promise<HealthRepairResult>;
}
