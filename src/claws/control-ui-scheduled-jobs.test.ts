import { describe, expect, it } from "vitest";
import {
  buildClawAddScheduledJobs,
  buildClawUpdateScheduledJobs,
} from "./control-ui-scheduled-jobs.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron.js";
import { digestClawValue } from "./digest.js";
import type { ClawCronJob } from "./types.js";
import type { ClawUpdateAction } from "./update-plan-types.js";

const job: ClawCronJob = {
  id: "daily",
  name: "private-name",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  session: "isolated",
  message: "private-message",
};
const safeJob = { schedule: job.schedule, session: "isolated", delivery: "none" };
const ref: PersistedClawCronRef = {
  schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
  agentId: "assistant",
  manifestId: job.id,
  declarationKey: "claw:assistant:daily",
  schedulerJobId: "private-scheduler-id",
  status: "complete",
  job,
  error: "private-error",
  createdAtMs: 1,
  updatedAtMs: 2,
};
const action: ClawUpdateAction = {
  kind: "cronJob",
  id: job.id,
  action: "unchanged",
  blocked: false,
  target: "private-target",
  reason: "private-reason",
  currentDigest: digestClawValue(job),
  desiredDigest: digestClawValue(job),
};

describe("Claw scheduled declaration disclosure", () => {
  it.each([
    undefined,
    { mode: "none" as const },
    { mode: "announce" as const, channel: "last" as const },
  ])("projects only declaration fields using Claw delivery semantics: %j", (delivery) => {
    const result = buildClawAddScheduledJobs({
      agent: { finalId: "assistant" },
      actions: [
        {
          kind: "cronJob",
          id: job.id,
          action: "schedule",
          target: "private-target",
          blocked: false,
          details: {
            ...job,
            delivery,
            agentId: "assistant",
            expectedState: "absent",
            deliveryResolution: "private-routing",
          },
        },
      ],
    });
    expect(result).toEqual({
      coverage: "package-declarations",
      jobs: [
        {
          id: job.id,
          action: "schedule",
          blocked: false,
          proposed: {
            ...safeJob,
            delivery: delivery?.mode === "announce" ? "last-channel" : "none",
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|enabled|toolsAllow|stagger|declarationKey/u,
    );
  });

  it("preserves manual, removed, released, and unchanged rows without claiming live state", () => {
    const unchangedJob = { ...job, id: "unchanged" };
    const manualJob = { ...job, id: "manual" };
    const proposed = [unchangedJob, manualJob];
    const recorded = ["unchanged", "manual", "removed", "released"].map(
      (id): PersistedClawCronRef => ({
        ...ref,
        manifestId: id,
        declarationKey: `claw:assistant:${id}`,
        job: { ...job, id },
        status: id === "manual" ? "failed" : id === "removed" ? "removed" : "complete",
        schedulerJobId: id === "manual" ? undefined : ref.schedulerJobId,
      }),
    );
    const actions = recorded.map((current): ClawUpdateAction => ({
      ...action,
      id: current.manifestId,
      action:
        current.manifestId === "released"
          ? "release"
          : current.manifestId === "removed"
            ? "remove"
            : current.manifestId === "manual"
              ? "manual"
              : "unchanged",
      blocked: current.manifestId === "manual",
      currentDigest: digestClawValue(current.job),
      desiredDigest: proposed.some((target) => target.id === current.manifestId)
        ? digestClawValue(current.job)
        : undefined,
    }));
    const result = buildClawUpdateScheduledJobs({
      plan: { agentId: "assistant", actions },
      proposed,
      recorded,
    });
    expect(result.jobs.map(({ id, action, blocked }) => ({ id, action, blocked }))).toEqual([
      { id: "unchanged", action: "unchanged", blocked: false },
      { id: "manual", action: "manual", blocked: true },
      { id: "removed", action: "remove", blocked: false },
      { id: "released", action: "release", blocked: false },
    ]);
    expect(result.jobs[1]).toMatchObject({
      recorded: { state: "declared", status: "failed", schedulerIdRecorded: false },
      proposed: safeJob,
    });
    expect(result.jobs[2]).toEqual({
      id: "removed",
      action: "remove",
      blocked: false,
      recorded: { state: "declared", job: safeJob, status: "removed", schedulerIdRecorded: true },
    });
    expect(result.jobs[3]?.proposed).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    ["missing", []],
    ["duplicate", [ref, ref]],
    ["other agent only", [{ ...ref, agentId: "private-other-agent" }]],
    ["stale message", [{ ...ref, job: { ...job, message: "private-changed" } }]],
    ["wrong id", [{ ...ref, job: { ...job, id: "different" } }]],
    ["wrong key", [{ ...ref, declarationKey: "private-wrong" }]],
    [
      "invalid cron",
      [{ ...ref, job: { ...job, schedule: { ...job.schedule, cron: "not cron" } } }],
    ],
    [
      "invalid timezone",
      [{ ...ref, job: { ...job, schedule: { ...job.schedule, timezone: "not-a-timezone" } } }],
    ],
    ["invalid delivery", [{ ...ref, job: { ...job, delivery: { mode: "announce" as const } } }]],
    ["unknown declaration fields", [{ ...ref, job: { ...job, privateExtension: true } }]],
    ["unknown status", [{ ...ref, status: "future" as PersistedClawCronRef["status"] }]],
    [
      "future schema",
      [{ ...ref, schemaVersion: "future" as PersistedClawCronRef["schemaVersion"] }],
    ],
  ] as const)("marks %s recorded provenance unresolved", (name, recorded) => {
    // Malformed records can already be bound by the canonical planner's digest.
    const currentDigest =
      name === "stale message" || !recorded[0]
        ? action.currentDigest
        : digestClawValue(recorded[0].job);
    const result = buildClawUpdateScheduledJobs({
      plan: { agentId: "assistant", actions: [{ ...action, currentDigest }] },
      proposed: [job],
      recorded,
    });
    expect(result.jobs).toEqual([
      {
        id: job.id,
        action: "unchanged",
        blocked: false,
        recorded: { state: "unresolved" },
        proposed: safeJob,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("ignores other-agent refs and discloses pending records as provenance only", () => {
    const result = buildClawUpdateScheduledJobs({
      plan: { agentId: "assistant", actions: [{ ...action, action: "manual", blocked: true }] },
      proposed: [job],
      recorded: [
        { ...ref, status: "pending", schedulerJobId: undefined },
        {
          ...ref,
          agentId: "private-other-agent",
          job: { ...job, message: "private-other-message" },
        },
      ],
    });
    expect(result.jobs[0]?.recorded).toEqual({
      state: "declared",
      job: safeJob,
      status: "pending",
      schedulerIdRecorded: false,
    });
    const added = buildClawUpdateScheduledJobs({
      plan: {
        agentId: "assistant",
        actions: [{ ...action, action: "add", currentDigest: undefined }],
      },
      proposed: [job],
      recorded: [{ ...ref, agentId: "private-other-agent" }],
    });
    expect(added.jobs[0]?.recorded).toBeUndefined();
    expect(added.jobs[0]?.proposed).toEqual(safeJob);
    expect(JSON.stringify([result, added])).not.toContain("private");
  });

  it("rejects inconsistent proposed data with a static error instead of hiding a job", () => {
    for (const proposed of [[], [job, job], [{ ...job, message: "private-change" }]]) {
      expect(() =>
        buildClawUpdateScheduledJobs({
          plan: { agentId: "assistant", actions: [action] },
          proposed,
          recorded: [ref],
        }),
      ).toThrow(/^Claw scheduled declaration preview is unavailable\.$/u);
    }
    expect(() =>
      buildClawAddScheduledJobs({
        agent: { finalId: "assistant" },
        actions: [
          {
            kind: "cronJob",
            id: job.id,
            action: "schedule",
            target: "private",
            blocked: false,
            details: { ...job, message: undefined },
          },
        ],
      }),
    ).toThrow(/^Claw scheduled declaration preview is unavailable\.$/u);
  });
});
