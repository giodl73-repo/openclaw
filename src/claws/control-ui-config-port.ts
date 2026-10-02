import { AsyncLocalStorage } from "node:async_hooks";
import {
  MessageChannel,
  MessagePort,
  receiveMessageOnPort,
  isMainThread,
} from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";

type Reply = { ok: true; value: unknown } | { ok: false; error: unknown; payload: unknown };

function result(reply: Reply): unknown {
  if (reply.ok) {
    return reply.value;
  }
  if (reply.error instanceof Error && reply.payload) {
    retainOpenClawStateWorkerErrorPayload(reply.error, reply.payload);
    throw hydrateOpenClawStateWorkerError(reply.error, { includeOrdinary: true });
  }
  throw reply.error;
}

/** Private lifecycle transport. Only the application worker may wait synchronously. */
export function createClawConfigPort<Incoming, Outgoing>(
  port: MessagePort,
  wakeBuffer: SharedArrayBuffer,
  handle: (request: Incoming) => unknown | Promise<unknown>,
) {
  const wake = new Int32Array(wakeBuffer);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const pending = new Set<(error: Error) => void>();
  const active = new Set<Promise<void>>();
  let closed = false;
  const closedError = () => new Error("Claw config persistence is closed.");
  const signal = () => {
    Atomics.add(wake, 0, 1);
    Atomics.notify(wake, 0);
  };
  const receive = (message: unknown) => {
    if (!isRecord(message) || !(message.reply instanceof MessagePort)) {
      return;
    }
    const replyPort = message.reply;
    const send = (reply: Reply) => {
      try {
        replyPort.postMessage(reply);
        signal();
      } finally {
        replyPort.close();
      }
    };
    const reject = (error: unknown) =>
      send({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
        payload: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
      });
    try {
      if (closed) {
        throw closedError();
      }
      // Both endpoints are created by this lifecycle, not by a browser request.
      const value = inOwnerContext(handle, message.request as Incoming);
      if (value instanceof Promise) {
        const task = value.then((value) => send({ ok: true, value }), reject);
        active.add(task);
        void task.finally(() => active.delete(task)).catch(() => {});
      } else {
        send({ ok: true, value });
      }
    } catch (error) {
      reject(error);
    }
  };
  port.on("message", receive);
  const service = () => {
    for (let queued = receiveMessageOnPort(port); queued; queued = receiveMessageOnPort(port)) {
      receive(queued.message);
    }
  };
  const start = (request: Outgoing) => {
    if (closed || Atomics.load(wake, 1) !== 0) {
      throw closedError();
    }
    const { port1, port2 } = new MessageChannel();
    try {
      port.postMessage({ request, reply: port2 }, [port2]);
      signal();
      return port1;
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  };
  return {
    async call<T>(request: Outgoing): Promise<T> {
      const reply = start(request);
      return await new Promise<T>((resolve, reject) => {
        const fail = (error: Error) => {
          pending.delete(fail);
          reply.close();
          reject(error);
        };
        pending.add(fail);
        reply.once("message", (message: Reply) => {
          pending.delete(fail);
          reply.close();
          try {
            resolve(result(message) as T);
          } catch (error) {
            reject(error);
          }
        });
        reply.once("close", () => {
          if (pending.has(fail)) {
            fail(closedError());
          }
        });
      });
    },
    callSync<T>(request: Outgoing): T {
      if (isMainThread) {
        throw new Error("Only the Claw application worker may wait for config persistence.");
      }
      const reply = start(request);
      try {
        while (!closed && Atomics.load(wake, 1) === 0) {
          const version = Atomics.load(wake, 0);
          // A pending native commit may need the original guard while this worker is waiting.
          service();
          const queued = receiveMessageOnPort(reply);
          if (queued) {
            return result(queued.message as Reply) as T;
          }
          Atomics.wait(wake, 0, version);
        }
        throw closedError();
      } finally {
        reply.close();
      }
    },
    async close() {
      closed = true;
      Atomics.store(wake, 1, 1);
      signal();
      for (const fail of pending) {
        fail(closedError());
      }
      // Refuse guard callbacks before joining accepted persistence and releasing its owner.
      while (active.size > 0) {
        await Promise.allSettled([...active]);
      }
      port.off("message", receive);
      port.close();
    },
  };
}
