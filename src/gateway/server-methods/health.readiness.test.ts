import { describe, expect, it, vi } from "vitest";

const getStatusSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("../../status/summary.js", () => ({
  getStatusSummary: getStatusSummaryMock,
}));

import { healthHandlers } from "./health.js";

describe("healthHandlers readiness", () => {
  const readyHandler = healthHandlers.ready;
  if (!readyHandler) {
    throw new Error("healthHandlers.ready must be registered");
  }

  it("returns the live canonical Gateway readiness result", async () => {
    const readiness = {
      ready: true,
      conditions: [],
      failures: [],
      advisories: [],
    };
    const respond = vi.fn();

    await readyHandler({
      req: {} as never,
      params: {},
      respond,
      context: { getReadiness: async () => readiness } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, readiness, undefined);
  });

  it("fails closed when live readiness is unavailable", async () => {
    const respond = vi.fn();

    await readyHandler({
      req: {} as never,
      params: {},
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "readiness unavailable" }),
    );
  });

  it.each(["cached", "refreshed"] as const)(
    "keeps ordinary %s health independent from extensible readiness",
    async (source) => {
      const health = {
        ok: true,
        ts: Date.now(),
        durationMs: 1,
        channels: {},
        channelOrder: [],
        channelLabels: {},
        heartbeatSeconds: 0,
        defaultAgentId: "main",
        agents: [],
        sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
      };
      const respond = vi.fn();
      const healthHandler = healthHandlers.health;
      if (!healthHandler) {
        throw new Error("healthHandlers.health must be registered");
      }

      await healthHandler({
        req: {} as never,
        params: { probe: false },
        respond,
        context: {
          getHealthCache: () => (source === "cached" ? health : null),
          refreshHealthSnapshot: async () => health,
          getReadiness: () => {
            throw new Error("ordinary health must not run readiness callbacks");
          },
          getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
          logHealth: { error: vi.fn() },
        } as never,
        client: { connect: { scopes: ["operator.read"] } } as never,
        isWebchatConnect: () => false,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toEqual(expect.objectContaining(health));
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    },
  );

  it("keeps ordinary status independent from extensible readiness", async () => {
    const status = { ok: true };
    const respond = vi.fn();
    getStatusSummaryMock.mockResolvedValueOnce(status);
    const statusHandler = healthHandlers.status;
    if (!statusHandler) {
      throw new Error("healthHandlers.status must be registered");
    }

    await statusHandler({
      req: {} as never,
      params: { includeChannelSummary: true },
      respond,
      context: {
        getReadiness: () => {
          throw new Error("ordinary status must not run readiness callbacks");
        },
      } as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(status), undefined);
  });
});
