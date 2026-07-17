import { describe, expect, it } from "vitest";
import { deriveContinuityWakeDescriptor } from "./wake-descriptor.js";

describe("continuity wake descriptor", () => {
  it("binds the earliest enabled semantic deadline to a stable scheduler generation", () => {
    const jobs = [
      {
        id: "later",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        state: { nextRunAtMs: Date.parse("2026-07-17T09:00:00.000Z") },
      },
      {
        id: "earlier",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        state: { nextRunAtMs: Date.parse("2026-07-17T03:00:00.000Z") },
      },
      {
        id: "disabled",
        enabled: false,
        schedule: { kind: "at", at: "2026-07-17T01:00:00.000Z" },
        state: { nextRunAtMs: Date.parse("2026-07-17T01:00:00.000Z") },
      },
    ];

    const reconcileAtMs = Date.parse("2026-07-17T00:00:00.000Z");
    const descriptor = deriveContinuityWakeDescriptor(jobs, true, reconcileAtMs);
    const reordered = deriveContinuityWakeDescriptor(jobs.toReversed(), true, reconcileAtMs);

    expect(descriptor).toMatchObject({
      version: "continuity-wake-descriptor/v1",
      nextRequiredAt: "2026-07-17T03:00:00.000Z",
      reasonClass: "cron",
    });
    expect(descriptor.schedulerGeneration).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reordered).toStrictEqual(descriptor);
  });

  it("represents a closed scheduler with no semantic deadline", () => {
    const descriptor = deriveContinuityWakeDescriptor([
      {
        id: "watcher",
        schedule: { kind: "on-exit", command: "worker" },
        state: {},
      },
    ]);

    expect(descriptor).toMatchObject({
      nextRequiredAt: null,
      reasonClass: "none",
    });
  });

  it("does not advertise persisted deadlines when the scheduler is globally disabled", () => {
    const jobs = [
      {
        id: "job",
        schedule: { kind: "every", everyMs: 60_000 },
        state: { nextRunAtMs: Date.parse("2026-07-17T03:00:00.000Z") },
      },
    ];

    const disabled = deriveContinuityWakeDescriptor(jobs, false);
    const enabled = deriveContinuityWakeDescriptor(jobs, true);

    expect(disabled).toMatchObject({
      nextRequiredAt: null,
      reasonClass: "none",
    });
    expect(disabled.schedulerGeneration).not.toBe(enabled.schedulerGeneration);
  });

  it("derives the natural run for an enabled timed job with no persisted deadline", () => {
    const reconcileAtMs = Date.parse("2026-07-17T02:00:00.000Z");
    const descriptor = deriveContinuityWakeDescriptor(
      [
        {
          id: "job",
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          state: {},
        },
      ],
      true,
      reconcileAtMs,
    );

    expect(descriptor).toMatchObject({
      nextRequiredAt: "2026-07-17T09:00:00.000Z",
      reasonClass: "cron",
    });
  });

  it("falls back instead of throwing for a deadline outside the date range", () => {
    const reconcileAtMs = Date.parse("2026-07-17T02:00:00.000Z");
    const descriptor = deriveContinuityWakeDescriptor(
      [
        {
          id: "job",
          schedule: { kind: "every", everyMs: 60_000 },
          state: { nextRunAtMs: Number.MAX_VALUE },
        },
      ],
      true,
      reconcileAtMs,
    );

    expect(descriptor.nextRequiredAt).toBe("2026-07-17T02:00:00.000Z");
  });

  it("falls back for a nonpositive persisted deadline", () => {
    const reconcileAtMs = Date.parse("2026-07-17T02:00:00.000Z");
    const descriptor = deriveContinuityWakeDescriptor(
      [
        {
          id: "job",
          schedule: { kind: "at", at: "2026-07-17T03:00:00.000Z" },
          state: { nextRunAtMs: 0 },
        },
      ],
      true,
      reconcileAtMs,
    );

    expect(descriptor.nextRequiredAt).toBe("2026-07-17T02:00:00.000Z");
  });

  it("does not let a stale future cron deadline skip the natural next run", () => {
    const reconcileAtMs = Date.parse("2026-07-17T02:00:00.000Z");
    const staleFuture = Date.parse("2026-07-24T09:00:00.000Z");
    const descriptor = deriveContinuityWakeDescriptor(
      [
        {
          id: "daily",
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC", staggerMs: 0 },
          state: { nextRunAtMs: staleFuture },
        },
      ],
      true,
      reconcileAtMs,
    );

    expect(descriptor.nextRequiredAt).toBe("2026-07-17T09:00:00.000Z");
  });

  it("changes generation when scheduler inputs change", () => {
    const before = deriveContinuityWakeDescriptor([
      {
        id: "job",
        schedule: { kind: "every", everyMs: 60_000 },
        state: { nextRunAtMs: 1000 },
      },
    ]);
    const after = deriveContinuityWakeDescriptor([
      {
        id: "job",
        schedule: { kind: "every", everyMs: 120_000 },
        state: { nextRunAtMs: 2000 },
      },
    ]);

    expect(after.schedulerGeneration).not.toBe(before.schedulerGeneration);
  });
});
