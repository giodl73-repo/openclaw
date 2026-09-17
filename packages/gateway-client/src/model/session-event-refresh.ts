const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_WAIT_MS = 1_000;

export type SessionEventRefreshCoordinatorOptions = Readonly<{
  active: boolean;
  refresh: (isCurrent: () => boolean) => Promise<void>;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}>;

/**
 * Canonical bounded event-refresh policy shared by Control Model and Control UI.
 * Hidden owners defer work; one in-flight refresh may acquire one trailing run.
 */
export function createSessionEventRefreshCoordinator({
  active: initialActive,
  refresh,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
}: SessionEventRefreshCoordinatorOptions) {
  let active = initialActive;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let deadline: number | null = null;
  let nextAllowed = 0;
  let pending: object | null = null;
  let queued = false;
  let generation = 0;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    deadline = null;
  };

  const start = () => {
    clearTimer();
    if (disposed || !active || pending || !queued) {
      return;
    }
    queued = false;
    const request = {};
    pending = request;
    const started = now();
    const requestGeneration = generation;
    void refresh(() => pending === request && requestGeneration === generation)
      .catch(() => undefined)
      .finally(() => {
        if (pending !== request) {
          return;
        }
        pending = null;
        const completed = now();
        nextAllowed = completed + Math.min(15_000, Math.max(1_000, 3 * (completed - started)));
        arm();
      });
  };

  const arm = (debounce = true) => {
    if (disposed || !active || pending || !queued) {
      return;
    }
    const currentTime = now();
    deadline ??= currentTime + maxWaitMs;
    if (timer !== null) {
      globalThis.clearTimeout(timer);
    }
    const delay = debounce ? Math.min(debounceMs, deadline - currentTime) : 0;
    timer = globalThis.setTimeout(start, Math.max(delay, nextAllowed - currentTime));
  };

  const absorb = () => {
    generation += 1;
    clearTimer();
    queued = false;
  };

  const reset = () => {
    absorb();
    pending = null;
    nextAllowed = 0;
  };

  return {
    schedule() {
      if (disposed) {
        return;
      }
      queued = true;
      arm();
    },
    flush() {
      if (timer === null) {
        return;
      }
      start();
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        arm(false);
        return;
      }
      queued ||= markDirty || timer !== null;
      clearTimer();
    },
    absorb,
    reset,
    dispose() {
      reset();
      disposed = true;
    },
  };
}
