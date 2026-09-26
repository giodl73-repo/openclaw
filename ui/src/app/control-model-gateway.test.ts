// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlModelGatewayBridge } from "./control-model-gateway.ts";

describe("Control Model Gateway catalog admission", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defers hidden-page invalidations and flushes one visible catch-up", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    const client = { request: vi.fn() } as never;
    const bridge = createControlModelGatewayBridge({
      getGatewaySnapshot: () => ({ phase: "connected", lastError: null, lastErrorCode: null }),
      getConnectionEpoch: () => 1,
      getClient: () => client,
      isCurrentClient: (candidate) => candidate === client,
      sessionMessageKeysEquivalent: (left, right) => left === right,
    });
    const invalidated = vi.fn();
    bridge.binding.subscribeSessionCatalogInvalidations(invalidated);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    bridge.queueEvent(
      { type: "event", event: "sessions.changed", payload: { sessionKey: "main" } } as never,
      client,
    );
    bridge.queueEvent(
      { type: "event", event: "session.message", payload: { sessionKey: "main" } } as never,
      client,
    );
    await Promise.resolve();
    expect(invalidated).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidated).toHaveBeenCalledTimes(1);

    bridge.queueEvent(
      { type: "event", event: "sessions.changed", payload: { sessionKey: "main" } } as never,
      client,
    );
    await Promise.resolve();
    expect(invalidated).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });
});
