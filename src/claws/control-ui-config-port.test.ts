import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { createClawConfigPort } from "./control-ui-config-port.js";

const thread = vi.hoisted(() => ({ main: true }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return thread.main;
  },
}));
afterEach(() => {
  thread.main = true;
  vi.restoreAllMocks();
});

it("refuses synchronous calls on the host before posting any request", async () => {
  const { port1, port2 } = new MessageChannel();
  const endpoint = createClawConfigPort(port1, new SharedArrayBuffer(8), () => {});
  try {
    expect(() => endpoint.callSync("read")).toThrow("Only the Claw application worker");
    expect(receiveMessageOnPort(port2)).toBeUndefined();
  } finally {
    await endpoint.close();
    port2.close();
  }
});

it("services the original guard while its synchronous caller waits on a real reply port", async () => {
  thread.main = false;
  const context = new AsyncLocalStorage<string>();
  const { port1, port2 } = new MessageChannel();
  const guard = new MessageChannel();
  const wake = new SharedArrayBuffer(8);
  const handled = vi.fn((request: string) => {
    expect(context.getStore()).toBe("worker-owner");
    expect(request).toBe("guard");
    return "guarded";
  });
  const endpoint = context.run("worker-owner", () =>
    createClawConfigPort<string, string>(port1, wake, handled),
  );
  let response: MessagePort | undefined;
  const wait = vi
    .spyOn(Atomics, "wait")
    .mockImplementationOnce(() => {
      const message = receiveMessageOnPort(port2)?.message;
      expect(message.request).toBe("write");
      response = message.reply;
      port2.postMessage({ request: "guard", reply: guard.port2 }, [guard.port2]);
      return "ok";
    })
    .mockImplementationOnce(() => {
      expect(receiveMessageOnPort(guard.port1)?.message).toEqual({ ok: true, value: "guarded" });
      response?.postMessage({ ok: true, value: "committed" });
      response?.close();
      return "ok";
    })
    .mockImplementation(() => {
      throw new Error("Unexpected native wait: no deterministic reply");
    });
  try {
    expect(endpoint.callSync("write")).toBe("committed");
    expect(handled).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(2);
  } finally {
    response?.close();
    guard.port1.close();
    guard.port2.close();
    await endpoint.close();
    port2.close();
  }
});

it("wakes a synchronous caller when the shared lifecycle closes", async () => {
  thread.main = false;
  const { port1, port2 } = new MessageChannel();
  const wake = new SharedArrayBuffer(8);
  const endpoint = createClawConfigPort(port1, wake, () => {});
  let response: MessagePort | undefined;
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    response = receiveMessageOnPort(port2)?.message.reply;
    Atomics.store(new Int32Array(wake), 1, 1);
    return "ok";
  });
  try {
    expect(() => endpoint.callSync("read")).toThrow("persistence is closed");
  } finally {
    response?.close();
    await endpoint.close();
    port2.close();
  }
});

it("keeps concurrent asynchronous replies separate and hydrates typed errors", async () => {
  const { port1, port2 } = new MessageChannel();
  const wake = new SharedArrayBuffer(8);
  const ready = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const host = createClawConfigPort<string, string>(port1, wake, async (request) => {
    if (request === "slow") {
      started.resolve();
      await ready.promise;
      return "first";
    }
    if (request === "refuse") {
      throw new OpenClawStateOwnershipError("Synthetic refusal");
    }
    return "second";
  });
  const client = createClawConfigPort<string, string>(port2, wake, () => {});
  const slow = client.call("slow");
  try {
    await started.promise;
    expect(await client.call("fast")).toBe("second");
    await expect(client.call("refuse")).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
    ready.resolve();
    expect(await slow).toBe("first");
  } finally {
    ready.resolve();
    await slow.catch(() => {});
    await client.close();
    await host.close();
  }
});

it("refuses a late async call after only the peer endpoint closes", async () => {
  const { port1, port2 } = new MessageChannel();
  const wake = new SharedArrayBuffer(8);
  const handle = vi.fn();
  const host = createClawConfigPort<string, string>(port1, wake, handle);
  const client = createClawConfigPort<string, string>(port2, wake, () => {});
  try {
    await host.close();
    await expect(client.call("late")).rejects.toThrow("persistence is closed");
    expect(handle).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await host.close();
  }
});

it("joins accepted work on close and rejects outstanding callers without a host wait", async () => {
  const { port1, port2 } = new MessageChannel();
  const wake = new SharedArrayBuffer(8);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const host = createClawConfigPort<string, string>(port1, wake, async () => {
    started.resolve();
    await finish.promise;
  });
  const client = createClawConfigPort<string, string>(port2, wake, () => {});
  const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
    throw new Error("Host must not wait");
  });
  const result = client.call("write").catch((error: unknown) => error);
  let joined = false;
  try {
    await started.promise;
    const closing = host.close().then(() => {
      joined = true;
    });
    await client.close();
    expect(await result).toBeInstanceOf(Error);
    expect(joined).toBe(false);
    finish.resolve();
    await closing;
    expect(joined).toBe(true);
    expect(wait).not.toHaveBeenCalled();
    await expect(host.call("late")).rejects.toThrow("persistence is closed");
  } finally {
    finish.resolve();
    await client.close();
    await host.close();
    await result;
  }
});
