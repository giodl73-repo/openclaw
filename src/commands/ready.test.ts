import { beforeEach, describe, expect, it, vi } from "vitest";
import { readyCommand } from "./ready.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const callGatewayMock = vi.fn();
const readBestEffortConfigMock = vi.fn(() => ({}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: () => readBestEffortConfigMock(),
}));

function requireFirstRuntimeLog(): string {
  const [call] = runtime.log.mock.calls;
  if (!call) {
    throw new Error("expected runtime log output");
  }
  return String(call[0]);
}

describe("readyCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes gateway readiness JSON and exits zero when ready", async () => {
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 1,
      readiness: {
        profile: "local",
        ready: true,
        failures: [],
        conditions: [],
      },
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    });

    await readyCommand({ json: true, timeoutMs: 1234 }, runtime as never);

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "health", params: { probe: false }, timeoutMs: 1234 }),
    );
    expect(JSON.parse(requireFirstRuntimeLog())).toMatchObject({
      profile: "local",
      ready: true,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("fails when expected profile differs from gateway readiness profile", async () => {
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 1,
      readiness: {
        profile: "local",
        ready: true,
        failures: [],
        conditions: [],
      },
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    });

    await readyCommand({ json: true, expectProfile: "container" }, runtime as never);

    expect(JSON.parse(requireFirstRuntimeLog())).toMatchObject({
      profile: "local",
      expectedProfile: "container",
      ready: false,
      failures: ["ProfileMismatch"],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects invalid expected profile values", async () => {
    await readyCommand({ expectProfile: "bad-profile" as never }, runtime as never);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --expect-profile."),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('declared namespaced custom profile such as "acme.managed"'),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns not ready when the gateway is unreachable", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("connection refused"));

    await readyCommand({ json: false, timeoutMs: 1234 }, runtime as never);

    expect(requireFirstRuntimeLog()).toBe("not ready: GatewayUnavailable");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when the gateway reports failed profile readiness", async () => {
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 1,
      readiness: {
        profile: "local",
        ready: false,
        failures: ["PluginLoadFailures"],
        conditions: [],
      },
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    });

    await readyCommand({ json: false, timeoutMs: 1234 }, runtime as never);

    expect(requireFirstRuntimeLog()).toBe("not ready: PluginLoadFailures");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
