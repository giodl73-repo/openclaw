import { describe, expect, it, vi } from "vitest";
import { createHarness, flush } from "./conversation.test-harness.js";
import { createControlModel } from "./index.js";

/**
 * One session key plus agent addresses one shared conversation instance, so the
 * model owner — not any single consumer — decides when it is retired.
 */
describe("Control Model conversation leases", () => {
  it("keeps a shared conversation alive until its last named owner releases", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    // Two chat panes on one session address the same conversation instance.
    const first = model.conversation("agent:main:one", { owner: "pane-one" });
    const second = model.conversation("agent:main:one", { owner: "pane-two" });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    await model.releaseConversation("agent:main:one", { owner: "pane-one" });
    await flush();
    expect(first.isDisposed).toBe(false);
    expect(first.getSnapshot().status).not.toBe("disposed");
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);
    // The surviving pane keeps the same live instance, and renewing its lease
    // does not add a second one.
    expect(model.conversation("agent:main:one", { owner: "pane-two" })).toBe(first);

    await model.releaseConversation("agent:main:one", { owner: "pane-two" });
    await vi.waitFor(() =>
      expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(1),
    );
    expect(first.isDisposed).toBe(true);
    expect(first.getSnapshot().status).toBe("disposed");
    expect(model.conversation("agent:main:one", { owner: "pane-two" })).not.toBe(first);
    model.dispose();
  });

  it("ignores a release from an owner that never leased the conversation", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation("agent:main:one", { owner: "pane-one" });
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    await model.releaseConversation("agent:main:one", { owner: "pane-unknown" });
    await flush();
    expect(conversation.isDisposed).toBe(false);

    await model.releaseConversation("agent:main:one", { owner: "pane-one" });
    await flush();
    expect(conversation.isDisposed).toBe(true);
    model.dispose();
  });

  it("separates leases by agent so one route cannot retire another's conversation", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const main = model.conversation("global", { agentId: "main", owner: "pane-one" });
    const work = model.conversation("global", { agentId: "work", owner: "pane-one" });
    expect(work).not.toBe(main);

    await model.releaseConversation("global", { agentId: "main", owner: "pane-one" });
    await flush();
    expect(main.isDisposed).toBe(true);
    expect(work.isDisposed).toBe(false);
    model.dispose();
  });

  it("retires an unleased handle for a consumer that holds the instance directly", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation("agent:main:one");
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    await conversation.release();
    await flush();
    expect(conversation.isDisposed).toBe(true);
    expect(model.conversation("agent:main:one")).not.toBe(conversation);
    model.dispose();
  });
});
