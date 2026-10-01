import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";

describe("plugin interruptible calls", () => {
  it("retains module custody until an abort-ignoring callback settles", async () => {
    const instance = new PluginInstance("readiness-custody");
    const settle = createDeferredCore<void>();
    const events: string[] = [];
    let moduleResourceOpen = true;
    let signal: AbortSignal | undefined;
    instance.onModuleDispose(() => {
      moduleResourceOpen = false;
      events.push("module disposed");
    });
    const pending = instance.runInterruptible(new AbortController().signal, async (current) => {
      signal = current;
      await settle.promise;
      events.push(moduleResourceOpen ? "callback retained custody" : "callback lost custody");
      return "stale success";
    });
    void pending.catch(() => {});

    const disposal = instance.dispose().then(() => {
      events.push("instance disposed");
    });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(moduleResourceOpen).toBe(true);
    expect(events).toEqual([]);

    settle.resolve();
    await expect(pending).rejects.toBeInstanceOf(PluginInstanceUnavailableError);
    await disposal;
    expect(events).toEqual(["callback retained custody", "module disposed", "instance disposed"]);
  });
});
