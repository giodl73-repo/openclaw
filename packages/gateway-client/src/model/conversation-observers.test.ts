import { describe, expect, it, vi } from "vitest";
import { getGatewaySessionMessageSubscriptionCoordinator } from "../session-subscriptions.js";
import { createHarness, flush } from "./conversation.test-harness.js";
import { createControlModel } from "./index.js";

describe("Control Model session message observers", () => {
  it("never retires, downgrades, or unsubscribes a lease another owner holds", async () => {
    // The host deliberately skips its own retirement here so only the model can
    // touch the shared coordinator across the reconnect.
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { hostRetiresObservers: false },
    );
    const coordinator = getGatewaySessionMessageSubscriptionCoordinator(
      harness.subscriptionClient,
      { keysEquivalent: harness.sessionMessageKeysEquivalent },
    );
    const external = await coordinator.acquire("agent:main:one", { includeApprovals: true });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    model.conversation("agent:main:one");
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(1));

    harness.setConnection({ status: "reconnecting", epoch: 1 });
    harness.setConnection({ status: "connected", epoch: 2 });
    await flush();

    // The shared observer is never downgraded to a plain subscription, and the
    // model's retired leases are discarded instead of unsubscribed.
    expect(
      harness.callsFor("sessions.messages.subscribe").map((call) => call.params.includeApprovals),
    ).toEqual([true, true, true]);
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);

    model.dispose();
    await flush();
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);

    // A retired coordinator rejects every acquire, so the host's lease set
    // survived both the model's reconnect and its disposal.
    await expect(coordinator.acquire("agent:main:two")).resolves.toMatchObject({
      key: "agent:main:two",
    });
    await coordinator.release(external);
  });

  it("re-leases the host's replacement coordinator without unsubscribing retired observers", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const coordinator = getGatewaySessionMessageSubscriptionCoordinator(
      harness.subscriptionClient,
      { keysEquivalent: harness.sessionMessageKeysEquivalent },
    );
    const external = await coordinator.acquire("agent:main:one");
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    model.conversation("agent:main:one");
    // One shared observer serves both owners: only the approval upgrade is new.
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(4));
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);

    model.dispose();
    await coordinator.release(external);
  });

  it("retires its own coordinator when no host owns the connection's observers", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({
      gateway: { ...harness.gateway, getSessionMessageSubscriptionClient: () => null },
    });
    model.start();
    model.conversation("agent:main:one");
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(4));
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);
    model.dispose();
  });
});
