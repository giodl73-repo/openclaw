import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionEventRefreshCoordinator } from "./session-event-refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session event refresh coordinator", () => {
  it("coalesces bursts and runs one bounded trailing refresh after failure", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      refresh,
    });

    coordinator.schedule();
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1);

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    first.reject(new Error("transient failure"));
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retires pending work on reset", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      refresh,
    });
    coordinator.schedule();
    coordinator.reset();
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("contains synchronous refresh failures and remains reusable", async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("synchronous failure");
      })
      .mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      refresh,
    });

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("defers hidden work and redeems it once after activation", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: false,
      refresh,
    });

    coordinator.schedule();
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();

    coordinator.setActive(true);
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates the completion guard when pending work is absorbed", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    let isCurrent: (() => boolean) | undefined;
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      refresh: vi.fn((current) => {
        isCurrent = current;
        return pending.promise;
      }),
    });

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(isCurrent?.()).toBe(true);
    coordinator.absorb();
    expect(isCurrent?.()).toBe(false);
    pending.resolve();
    coordinator.dispose();
  });
});
