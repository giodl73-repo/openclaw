import { describe, expect, it, vi } from "vitest";
import type { CanonicalReadinessResult } from "../readiness/conditions.js";
import { readyCommand, readyCriteriaCommand } from "./ready.js";

const ready: CanonicalReadinessResult = {
  contractVersion: 1,
  evaluatedAtMs: 1_000,
  identity: {
    producerRef: "openclaw/gateway/current",
    subjects: [
      {
        ref: "openclaw/gateway/current",
        kind: "openclaw.gateway",
        id: "gateway-1",
      },
      { ref: "openclaw/plugins/active", kind: "openclaw.plugins" },
      { ref: "openclaw/workspace/default", kind: "openclaw.workspace" },
    ],
  },
  ready: true,
  conditions: [
    {
      type: "GatewayResponding",
      subjectRef: "openclaw/gateway/current",
      status: "True",
      requirement: "required",
      reason: "GatewayResponding",
      message: "Gateway is responding.",
    },
    {
      type: "PluginsLoaded",
      subjectRef: "openclaw/plugins/active",
      status: "False",
      requirement: "advisory",
      reason: "PluginLoadFailed",
      message: "One plugin failed to load.",
    },
  ],
  failures: [],
  advisories: ["PluginLoadFailed"],
};

const notReady: CanonicalReadinessResult = {
  ...ready,
  ready: false,
  conditions: [
    ...ready.conditions,
    {
      type: "openclaw.workspace-writable",
      subjectRef: "openclaw/workspace/default",
      status: "False",
      requirement: "required",
      reason: "WorkspaceStorageFull",
      message: "The effective workspace is full.",
    },
  ],
  failures: ["WorkspaceStorageFull"],
};

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function createWatchProcess() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    process: {
      on: vi.fn((signal: string, handler: () => void) => handlers.set(signal, handler)),
      off: vi.fn((signal: string) => handlers.delete(signal)),
    },
  };
}

describe("readyCommand", () => {
  it("writes the canonical result as JSON and keeps advisory-only results successful", async () => {
    const runtime = createRuntime();
    const callReady = vi.fn().mockResolvedValue(ready);
    await readyCommand({ json: true, timeoutMs: 2500 }, runtime, {
      callReady,
    });
    expect(callReady).toHaveBeenCalledWith({ timeoutMs: 2500 });
    expect(runtime.log).toHaveBeenCalledWith(JSON.stringify(ready, null, 2));
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("prints structured findings and exits one for required failures", async () => {
    const runtime = createRuntime();
    await readyCommand({}, runtime, {
      callReady: async () => notReady,
    });
    expect(runtime.log.mock.calls[0]?.[0]).toContain("Ready: no");
    expect(runtime.log.mock.calls[0]?.[0]).toContain("WorkspaceStorageFull");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed with JSON when the Gateway is unavailable", async () => {
    const runtime = createRuntime();
    await readyCommand({ json: true }, runtime, {
      callReady: async () => {
        throw new Error("connection refused");
      },
    });
    expect(runtime.log.mock.calls[0]?.[0]).toContain('"reason": "GatewayReadinessUnavailable"');
    expect(runtime.log.mock.calls[0]?.[0]).toContain("connection refused");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when an older Gateway does not expose the readiness method", async () => {
    const runtime = createRuntime();
    await readyCommand({}, runtime, {
      callReady: async () => {
        throw new Error("unknown method: ready");
      },
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "GatewayReadinessUnavailable: unknown method: ready",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("renders a legacy result from an older Gateway without crashing", async () => {
    const runtime = createRuntime();
    await readyCommand({}, runtime, {
      callReady: async () => ({
        ready: true,
        conditions: [],
        failures: [],
        advisories: [],
      }),
    });

    expect(runtime.log.mock.calls[0]?.[0]).toContain("Producer: legacy Gateway");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("waits through unavailable and not-ready observations until ready", async () => {
    const runtime = createRuntime();
    const callReady = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(notReady)
      .mockResolvedValueOnce(ready);
    let nowMs = 0;

    await readyCommand({ waitMs: 2_000, intervalMs: 500, timeoutMs: 700 }, runtime, {
      callReady,
      now: () => nowMs,
      delay: async (ms) => {
        nowMs += ms;
      },
    });

    expect(callReady).toHaveBeenCalledTimes(3);
    expect(callReady).toHaveBeenCalledWith({
      timeoutMs: 700,
      signal: expect.any(AbortSignal),
    });
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toContain("Ready: yes");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("caps each call by the remaining wait budget and emits the last result", async () => {
    const runtime = createRuntime();
    const callReady = vi.fn().mockResolvedValue(notReady);
    let nowMs = 0;

    await readyCommand({ waitMs: 750, intervalMs: 500, timeoutMs: 1_000 }, runtime, {
      callReady,
      now: () => nowMs,
      delay: async (ms) => {
        nowMs += ms;
      },
    });

    expect(callReady.mock.calls.map(([params]) => params.timeoutMs)).toEqual([750, 250]);
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toContain("WorkspaceStorageFull");
    expect(runtime.error).toHaveBeenCalledWith(
      "Timed out after 750ms waiting for Gateway readiness.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("returns a structured timeout when the Gateway is never reachable", async () => {
    const runtime = createRuntime();
    let nowMs = 0;

    await readyCommand({ waitMs: 500, json: true }, runtime, {
      callReady: async () => {
        throw new Error("connection refused");
      },
      now: () => nowMs,
      delay: async (ms) => {
        nowMs += ms;
      },
    });

    expect(runtime.log.mock.calls[0]?.[0]).toContain('"reason": "GatewayReadinessTimeout"');
    expect(runtime.log.mock.calls[0]?.[0]).toContain("connection refused");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("aborts slow pre-request setup at the total wait deadline", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime();
      const pending = readyCommand({ waitMs: 500, json: true }, runtime, {
        callReady: async ({ signal }) =>
          await new Promise<CanonicalReadinessResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      });

      await vi.advanceTimersByTimeAsync(500);
      await pending;

      expect(runtime.log.mock.calls[0]?.[0]).toContain('"reason": "GatewayReadinessTimeout"');
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watches semantic transitions as JSON Lines and ignores timestamp churn", async () => {
    const runtime = createRuntime();
    const watchProcess = createWatchProcess();
    const unavailableWorkspace: CanonicalReadinessResult = {
      ...ready,
      evaluatedAtMs: 3_000,
      ready: false,
      conditions: [
        ready.conditions[0],
        {
          type: "WorkspaceWritable",
          subjectRef: "openclaw/workspace/default",
          status: "False",
          requirement: "required",
          reason: "WorkspaceUnavailable",
          message: "Workspace is unavailable.",
        },
      ],
      failures: ["WorkspaceUnavailable"],
    };
    const callReady = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({
        ...ready,
        evaluatedAtMs: 2_000,
        conditions: ready.conditions.map((condition) => ({
          ...condition,
          observedAtMs: 2_000,
        })),
      })
      .mockResolvedValueOnce(unavailableWorkspace);
    let delays = 0;

    await readyCommand({ watch: true, json: true, intervalMs: 25, timeoutMs: 500 }, runtime, {
      callReady,
      process: watchProcess.process,
      now: () => 10_000 + delays,
      delay: async (intervalMs) => {
        expect(intervalMs).toBe(25);
        delays += 1;
        if (delays === 3) {
          watchProcess.handlers.get("SIGINT")?.();
        }
      },
    });

    expect(callReady).toHaveBeenCalledTimes(3);
    expect(callReady).toHaveBeenCalledWith({
      timeoutMs: 500,
      signal: expect.any(AbortSignal),
    });
    const events = runtime.log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventVersion: 1, event: "snapshot", ready: true });
    expect(events[1]).toMatchObject({ eventVersion: 1, event: "transition", ready: false });
    expect(events[1].changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ready", before: true, after: false }),
        expect.objectContaining({ kind: "condition", change: "added" }),
      ]),
    );
    expect(runtime.exit).toHaveBeenCalledWith(130);
    expect(watchProcess.process.off).toHaveBeenCalledTimes(2);
    expect(watchProcess.handlers.size).toBe(0);
  });

  it("keeps watching through Gateway unavailability and recovery", async () => {
    const runtime = createRuntime();
    const watchProcess = createWatchProcess();
    const recoveredNotReady: CanonicalReadinessResult = {
      ...ready,
      ready: false,
      conditions: [
        {
          ...ready.conditions[0],
          status: "False",
          reason: "GatewayDegraded",
          message: "Gateway recovered but remains degraded.",
        },
      ],
      failures: ["GatewayDegraded"],
    };
    const callReady = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(recoveredNotReady);
    let delays = 0;

    await readyCommand({ watch: true }, runtime, {
      callReady,
      process: watchProcess.process,
      now: () => 20_000 + delays,
      delay: async () => {
        delays += 1;
        if (delays === 2) {
          watchProcess.handlers.get("SIGTERM")?.();
        }
      },
    });

    expect(runtime.log.mock.calls[0]?.[0]).toContain("Ready: unavailable");
    expect(runtime.log.mock.calls[1]?.[0]).toContain("availability unavailable -> available");
    expect(runtime.log.mock.calls[1]?.[0]).toContain("Ready: no");
    expect(runtime.log.mock.calls[1]?.[0]).toContain("GatewayDegraded");
    expect(runtime.exit).toHaveBeenCalledWith(143);
  });

  it("cancels an active Gateway call without emitting a false unavailable result", async () => {
    const runtime = createRuntime();
    const watchProcess = createWatchProcess();
    const delay = vi.fn();

    await readyCommand({ watch: true }, runtime, {
      process: watchProcess.process,
      delay,
      callReady: async ({ signal }) =>
        await new Promise<CanonicalReadinessResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          watchProcess.handlers.get("SIGINT")?.();
        }),
    });

    expect(runtime.log).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(130);
    expect(watchProcess.handlers.size).toBe(0);
  });

  it("shows the Gateway error when an available watch becomes unavailable", async () => {
    const runtime = createRuntime();
    const watchProcess = createWatchProcess();
    const callReady = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error("connection reset"));
    let delays = 0;

    await readyCommand({ watch: true }, runtime, {
      callReady,
      process: watchProcess.process,
      delay: async () => {
        delays += 1;
        if (delays === 2) {
          watchProcess.handlers.get("SIGINT")?.();
        }
      },
    });

    expect(runtime.log.mock.calls[1]?.[0]).toContain("availability available -> unavailable");
    expect(runtime.log.mock.calls[1]?.[0]).toContain(
      "GatewayReadinessUnavailable: connection reset",
    );
  });
});

describe("readyCriteriaCommand", () => {
  const catalog = {
    catalogVersion: 1 as const,
    criteria: [
      {
        id: "openclaw.workspace-writable",
        description: "Checks workspace writes.",
        owner: { kind: "core" as const },
        registered: true,
        selection: "required" as const,
      },
    ],
  };

  it("lists the live descriptor catalog without evaluating readiness", async () => {
    const runtime = createRuntime();
    const callCatalog = vi.fn().mockResolvedValue(catalog);

    await readyCriteriaCommand({}, runtime, { callCatalog });

    expect(callCatalog).toHaveBeenCalledWith({ timeoutMs: undefined });
    expect(runtime.log.mock.calls[0]?.[0]).toContain("openclaw.workspace-writable");
    expect(runtime.log.mock.calls[0]?.[0]).toContain("required");
  });

  it("inspects one descriptor as JSON", async () => {
    const runtime = createRuntime();

    await readyCriteriaCommand({ id: "openclaw.workspace-writable", json: true }, runtime, {
      callCatalog: async () => catalog,
    });

    expect(runtime.log).toHaveBeenCalledWith(JSON.stringify(catalog.criteria[0], null, 2));
  });

  it("fails when an inspected descriptor is absent", async () => {
    const runtime = createRuntime();

    await readyCriteriaCommand({ id: "plugin.missing.check" }, runtime, {
      callCatalog: async () => catalog,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      "Readiness criterion not found: plugin.missing.check",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("readyCommand", () => {
  it("summarizes required and advisory conditions", async () => {
    const runtime = createRuntime();
    await readyCommand({}, runtime, { callReady: async () => ready });

    const output = String(runtime.log.mock.calls[0]?.[0]);
    expect(output).toContain("Ready: yes");
    expect(output).toContain("Producer: openclaw/gateway/current (gateway-1)");
    expect(output).toContain("Required: 1/1");
    expect(output).toContain("Advisories: 1");
    expect(output).toContain("WARN");
    expect(output).toContain("PluginLoadFailed");
    expect(output).toContain("openclaw/plugins/active");
  });
});
