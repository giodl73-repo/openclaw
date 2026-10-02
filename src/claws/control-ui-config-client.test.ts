import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { ConfigAuditRecord } from "../config/io.audit.js";
import type { ConfigHealthSnapshot } from "../config/io.health-state.types.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { createClawConfigPersistenceClient } from "./control-ui-config-client.js";
import type { ClawConfigRequest } from "./control-ui-config-contract.js";
import { collectClawRollbackFailures, isClawRollbackMetadata } from "./update-rollback.js";

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: false,
}));

const deps = {
  env: { OPENCLAW_STATE_DIR: "synthetic-state" },
  homedir: () => "synthetic-home",
  logger: console,
};
const configPath = "synthetic-config.json";
const snapshot: ConfigHealthSnapshot = { state: {}, basis: null };
const changes = { lastObservedSuspiciousSignature: null };
const record: ConfigAuditRecord = {
  ts: "2026-09-01T00:00:00.000Z",
  source: "config-io",
  event: "config.external",
  detectedBy: "write",
  configPath,
  previousHash: null,
  nextHash: "synthetic-hash",
  valid: true,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

function connect(handle: (request: ClawConfigRequest) => unknown) {
  const { port1, port2 } = new MessageChannel();
  const client = createClawConfigPersistenceClient(port1, new SharedArrayBuffer(8));
  const requests: ClawConfigRequest[] = [];
  const replies = new Set<MessagePort>();
  const receive = (message: { request: ClawConfigRequest; reply: MessagePort }) => {
    requests.push(message.request);
    replies.add(message.reply);
    const send = (reply: unknown) => {
      message.reply.postMessage(reply);
      message.reply.close();
      replies.delete(message.reply);
    };
    const reject = (error: unknown) =>
      send({
        ok: false,
        error,
        payload: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
      });
    try {
      const value = handle(message.request);
      if (value instanceof Promise) {
        void value.then((value) => send({ ok: true, value }), reject);
      } else {
        send({ ok: true, value });
      }
    } catch (error) {
      reject(error);
    }
  };
  port2.on("message", receive);
  // The sync client still posts and receives real MessagePorts; only its native wait is replaced.
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    const queued = receiveMessageOnPort(port2);
    if (!queued) {
      throw new Error("No deterministic host response was queued");
    }
    receive(queued.message);
    return "ok";
  });
  cleanup.push(async () => {
    await client.close();
    port2.off("message", receive);
    port2.close();
    for (const reply of replies) {
      reply.close();
    }
  });
  const checkGuard = async (guard: number) => {
    const channel = new MessageChannel();
    try {
      const reply = new Promise<{ ok: boolean; error?: Error }>((resolve) =>
        channel.port1.once("message", resolve),
      );
      port2.postMessage({ request: { guard }, reply: channel.port2 }, [channel.port2]);
      const result = await reply;
      if (!result.ok) {
        throw result.error;
      }
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  };
  return { client, requests, checkGuard };
}

it("dispatches synchronous operations and retains the original guard after store disposal", async () => {
  let next = 0;
  const guard = vi.fn();
  const { client, requests, checkGuard } = connect((request) => {
    if (request.operation === "capture" || request.operation === "continue") {
      return ++next;
    }
    if (request.operation === "current") {
      return true;
    }
    if (request.operation === "readHealth") {
      return {};
    }
  });
  const store = client.provider.captureHealth(deps, configPath, guard);
  expect(store.isCurrent()).toBe(true);
  store[Symbol.dispose]();
  const continuation = store.captureContinuation();
  expect(continuation.isCurrent()).toBe(true);
  client.provider.patchHealth(deps, configPath, changes);
  client.provider.supersedeHealth(deps, configPath);
  expect(client.provider.readHealth(deps)).toEqual({});
  client.provider.appendAuditSync({ ...deps, record });
  expect(requests.map((request) => request.operation)).toEqual([
    "capture",
    "current",
    "dispose",
    "continue",
    "current",
    "patchHealth",
    "supersede",
    "readHealth",
    "audit",
  ]);
  expect(requests[0]).toEqual({
    operation: "capture",
    location: { env: deps.env, homedir: deps.homedir() },
    configPath,
    guard: 1,
  });
  expect(requests[3]).toEqual({ operation: "continue", observation: 1 });
  expect(requests[4]).toEqual({ operation: "current", observation: 2 });
  guard.mockClear();
  await checkGuard(1);
  expect(guard).toHaveBeenCalledOnce();
});

it("samples artifact-preserving scope at read time and preserves null/CAS payloads", async () => {
  const { client, requests } = connect((request) => {
    if (request.operation === "capture") {
      return 1;
    }
    if (request.operation === "read") {
      return Promise.resolve(null);
    }
    if (request.operation === "readHealth") {
      return {};
    }
  });
  const store = client.provider.captureHealth(deps, configPath);
  expect(await withArtifactPreservingStateReads(() => store.read())).toBeNull();
  expect(await store.read()).toBeNull();
  withArtifactPreservingStateReads(() => client.provider.readHealth(deps));
  client.provider.readHealth(deps);
  await store.update(changes, snapshot);
  await store.updateAfterFileCommit(changes, snapshot);
  expect(requests.slice(1)).toEqual([
    { operation: "read", observation: 1, artifactPreserving: true },
    { operation: "read", observation: 1, artifactPreserving: false },
    {
      operation: "readHealth",
      location: { env: deps.env, homedir: deps.homedir() },
      artifactPreserving: true,
    },
    {
      operation: "readHealth",
      location: { env: deps.env, homedir: deps.homedir() },
      artifactPreserving: false,
    },
    { operation: "update", observation: 1, changes, previous: snapshot },
    { operation: "updateAfterFileCommit", observation: 1, changes, previous: snapshot },
  ]);
});

it("checks local custody before sync capture and hydrates a typed sync host refusal", () => {
  const refusal = new OpenClawStateOwnershipError("Synthetic config lock refused");
  const { client, requests } = connect(() => {
    throw refusal;
  });
  expect(() =>
    client.provider.captureHealth(deps, configPath, () => {
      throw refusal;
    }),
  ).toThrow(refusal);
  expect(requests).toEqual([]);
  expect(() => client.provider.readHealth(deps)).toThrow(OpenClawStateOwnershipError);
  expect(requests).toHaveLength(1);
});

it("runs audit callbacks in their original context and refuses revoked or unknown guards", async () => {
  const context = new AsyncLocalStorage<string>();
  let current = true;
  const effect = vi.fn();
  const { client, checkGuard } = connect(async (request) => {
    if (request.operation === "audit") {
      await checkGuard(request.guard);
      effect();
    }
  });
  const guard = vi.fn(() => {
    expect(context.getStore()).toBe("config-lock");
    if (!current) {
      throw new OpenClawStateOwnershipError("Synthetic config guard revoked");
    }
  });
  await context.run("config-lock", () => client.provider.appendAudit({ ...deps, record }, guard));
  expect(effect).toHaveBeenCalledOnce();
  current = false;
  await expect(
    context.run("config-lock", () => client.provider.appendAudit({ ...deps, record }, guard)),
  ).rejects.toThrow("Synthetic config guard revoked");
  await expect(checkGuard(999)).rejects.toThrow("no longer retained");
  expect(effect).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledTimes(2);
});

it("limits rollback metadata to the canonical step lifetime and retains its source guard", async () => {
  const sourceGuard = vi.fn();
  const { client, requests, checkGuard } = connect(async (request) => {
    if (request.operation === "audit") {
      await checkGuard(request.guard);
    }
  });
  expect(isClawRollbackMetadata()).toBe(false);
  expect(
    await collectClawRollbackFailures([
      async () => {
        expect(isClawRollbackMetadata()).toBe(true);
        await client.provider.appendAudit({ ...deps, record }, sourceGuard);
      },
    ]),
  ).toEqual([]);
  expect(requests[0]).toMatchObject({ operation: "audit", rollbackMetadata: true });
  expect(sourceGuard).toHaveBeenCalledOnce();
  expect(isClawRollbackMetadata()).toBe(false);
  await expect(checkGuard(1)).rejects.toThrow("rollback metadata owner is no longer active");
  await client.provider.appendAudit({ ...deps, record });
  expect(requests[1]).not.toHaveProperty("rollbackMetadata");
  expect(
    await collectClawRollbackFailures([
      async () => {
        await client.provider.appendAudit({ ...deps, record }, () => {
          throw new OpenClawStateOwnershipError("Rollback source changed");
        });
      },
    ]),
  ).toEqual(["Rollback source changed"]);
  expect(isClawRollbackMetadata()).toBe(false);
});
