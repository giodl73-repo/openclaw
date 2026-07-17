import { readConfigFileSnapshot } from "../config/io.js";
import { tryCronScheduleIdentity } from "../cron/schedule-identity.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { sha256Hex } from "../infra/crypto-digest.js";

export const CONTINUITY_WAKE_DESCRIPTOR_VERSION = "continuity-wake-descriptor/v1" as const;

export type ContinuityWakeDescriptor = {
  version: typeof CONTINUITY_WAKE_DESCRIPTOR_VERSION;
  schedulerGeneration: string;
  nextRequiredAt: string | null;
  reasonClass: "cron" | "none";
};

type WakeDescriptorJob = {
  id: string;
  enabled: boolean;
  timed: boolean;
  scheduleIdentity: string | null;
  nextRunAtMs: number | null;
  naturalNextRunAtMs: number | null;
};

function isRepresentableDateMs(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function resolveNaturalNextRunAtMs(job: unknown, nowMs: number): number | null {
  const nextRunAtMs = computeJobNextRunAtMs(job as CronJob, nowMs);
  return typeof nextRunAtMs === "number" && isRepresentableDateMs(nextRunAtMs) ? nextRunAtMs : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deriveContinuityWakeDescriptor(
  jobs: ReadonlyArray<{
    id: string;
    enabled?: boolean;
    schedule: unknown;
    state?: { nextRunAtMs?: number };
  }>,
  schedulerEnabled = true,
  reconcileAtMs = Date.now(),
): ContinuityWakeDescriptor {
  const snapshot: WakeDescriptorJob[] = jobs
    .map((job) => {
      const nextRunAtMs = job.state?.nextRunAtMs;
      const scheduleKind =
        job.schedule && typeof job.schedule === "object" && "kind" in job.schedule
          ? job.schedule.kind
          : undefined;
      const timed = scheduleKind === "at" || scheduleKind === "every" || scheduleKind === "cron";
      return {
        id: job.id,
        enabled: job.enabled !== false,
        timed,
        scheduleIdentity:
          tryCronScheduleIdentity(job as unknown as Record<string, unknown>) ?? null,
        nextRunAtMs:
          typeof nextRunAtMs === "number" && nextRunAtMs > 0 && isRepresentableDateMs(nextRunAtMs)
            ? nextRunAtMs
            : null,
        naturalNextRunAtMs:
          schedulerEnabled && job.enabled !== false && scheduleKind === "cron"
            ? resolveNaturalNextRunAtMs(job, reconcileAtMs)
            : null,
      };
    })
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const nextRequiredAtMs = snapshot.reduce<number | undefined>((earliest, job) => {
    if (!schedulerEnabled || !job.enabled) {
      return earliest;
    }
    const candidates = [job.nextRunAtMs, job.naturalNextRunAtMs]
      .filter((value): value is number => value !== null)
      .map((value) => Math.max(value, reconcileAtMs));
    const requiredAtMs =
      candidates.length > 0
        ? Math.min(...candidates)
        : job.timed && isRepresentableDateMs(reconcileAtMs)
          ? reconcileAtMs
          : null;
    if (requiredAtMs === null) {
      return earliest;
    }
    return earliest === undefined ? requiredAtMs : Math.min(earliest, requiredAtMs);
  }, undefined);
  return {
    version: CONTINUITY_WAKE_DESCRIPTOR_VERSION,
    schedulerGeneration: `sha256:${sha256Hex(canonicalJson({ schedulerEnabled, jobs: snapshot }))}`,
    nextRequiredAt:
      nextRequiredAtMs === undefined ? null : new Date(nextRequiredAtMs).toISOString(),
    reasonClass: nextRequiredAtMs === undefined ? "none" : "cron",
  };
}

export async function resolveContinuityWakeDescriptor(): Promise<ContinuityWakeDescriptor> {
  const snapshot = await readConfigFileSnapshot({ observe: false, isolateEnv: true });
  return resolveContinuityWakeDescriptorFromStore(
    snapshot.config.cron?.store,
    process.env.OPENCLAW_SKIP_CRON !== "1" && snapshot.config.cron?.enabled !== false,
  );
}

export async function resolveContinuityWakeDescriptorFromStore(
  configuredStorePath: string | undefined,
  schedulerEnabled = true,
  reconcileAtMs = Date.now(),
): Promise<ContinuityWakeDescriptor> {
  if (!schedulerEnabled) {
    return deriveContinuityWakeDescriptor([], false, reconcileAtMs);
  }
  const storePath = resolveCronJobsStorePath(configuredStorePath);
  const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
  return deriveContinuityWakeDescriptor(loaded.store.jobs, schedulerEnabled, reconcileAtMs);
}
