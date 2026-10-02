import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireGatewayStateOwner,
  assertStateDatabaseAccessAllowed,
} from "./gateway-state-owner.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  createAsyncSqliteWorkerOperationAdmission,
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
  requestSqliteWorkerSchemaMaintenance,
  settleSqliteWorkerOperationContext,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-admission.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["grant", "self-fence", "revoke"] as const)(
  "retains async admission until its %s decision and rechecks database custody",
  async (outcome) => {
    const ready = Promise.withResolvers<void>();
    const revoked = new Error("Synthetic database authority revoked");
    const context = new AsyncLocalStorage<string>();
    let requestCurrent = true;
    let databaseCurrent = true;
    let completed: Promise<void> | undefined;
    const assertRequest = vi.fn(() => {
      if (!requestCurrent) {
        throw revoked;
      }
    });
    const assertAccess = vi.fn(() => {
      expect(context.getStore()).toBe("owner");
      if (!databaseCurrent) {
        throw revoked;
      }
    });
    const admission = context.run("owner", () =>
      createAsyncSqliteWorkerOperationAdmission((request, grant) => {
        expect(request).toEqual({ stage: "commit", facts: "prepared config" });
        completed = ready.promise.then(() => {
          expect(context.getStore()).toBe("owner");
          expect(grant()).toBe(outcome !== "revoke");
        });
        return completed;
      }),
    );
    admission.bindDatabaseAuthority({
      databasePath: path.resolve("synthetic-async-writer.sqlite"),
      assertRequest,
      assertAccess,
      acquireSchema() {
        throw new Error("Ordinary admission must not acquire schema authority");
      },
    });
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      admission.port.postMessage({
        stage: "commit",
        facts: "prepared config",
        decision: decision.buffer,
      });
      admission.service();
      expect(completed).toBeDefined();
      expect(Atomics.load(decision, 0)).toBe(0);
      expect(admission.failure).toBeUndefined();
      requestCurrent = outcome !== "self-fence";
      databaseCurrent = outcome !== "revoke";
      ready.resolve();
      await completed;
      expect(Atomics.load(decision, 0)).toBe(outcome === "revoke" ? 2 : 1);
      expect(assertRequest).toHaveBeenCalledOnce();
      expect(assertAccess).toHaveBeenCalledTimes(2);
      expect(admission.failure).toBe(outcome === "revoke" ? revoked : undefined);
      expect(admission.failureSource).toBe(outcome === "revoke" ? "authority" : undefined);
    } finally {
      admission.finish();
      ready.resolve();
      await completed?.catch(() => {});
    }
  },
);

it.each(["resolve", "reject", "grant-then-reject"] as const)(
  "settles async admission on %s without allowing a late grant",
  async (outcome) => {
    const ready = Promise.withResolvers<void>();
    const rejected = new Error("Synthetic domain refusal");
    let grantLater: (() => boolean) | undefined;
    const admission = createAsyncSqliteWorkerOperationAdmission((_request, grant) => {
      grantLater = grant;
      if (outcome === "grant-then-reject") {
        expect(grant()).toBe(true);
      }
      return ready.promise;
    });
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      admission.port.postMessage({ stage: "transaction", decision: decision.buffer });
      admission.service();
      expect(grantLater).toBeDefined();
      expect(Atomics.load(decision, 0)).toBe(outcome === "grant-then-reject" ? 1 : 0);
      if (outcome === "resolve") {
        ready.resolve();
      } else {
        ready.reject(rejected);
      }
      // Admission registered its settlement handlers before this await continuation.
      await ready.promise.catch(() => {});
      expect(grantLater?.()).toBe(false);
      if (outcome === "grant-then-reject") {
        expect(Atomics.load(decision, 0)).toBe(1);
        expect(admission.failure).toBeUndefined();
        expect(admission.failureSource).toBeUndefined();
        expect(admission.cleanupFailures).toEqual([rejected]);
      } else {
        expect(Atomics.load(decision, 0)).toBe(2);
        expect(admission.failureSource).toBe("domain");
        if (outcome === "reject") {
          expect(admission.failure).toBe(rejected);
        } else {
          expect(admission.failure).toMatchObject({
            message: "SQLite worker admission was not granted",
          });
        }
        expect(admission.cleanupFailures).toEqual([]);
      }
    } finally {
      admission.finish();
      ready.resolve();
      await ready.promise.catch(() => {});
    }
  },
);

it("finish refuses every pending async decision and observes rejection after close", async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const grants: Array<() => boolean> = [];
  const admission = createAsyncSqliteWorkerOperationAdmission((_request, grant) => {
    const gate = gates[grants.length];
    grants.push(grant);
    return gate.promise;
  });
  const decisions = gates.map(
    () => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
  );
  try {
    for (const decision of decisions) {
      admission.port.postMessage({ stage: "transaction", decision: decision.buffer });
    }
    admission.service();
    expect(grants).toHaveLength(2);
    expect(decisions.map((decision) => Atomics.load(decision, 0))).toEqual([0, 0]);
    admission.finish();
    expect(decisions.map((decision) => Atomics.load(decision, 0))).toEqual([2, 2]);
    expect(grants.map((grant) => grant())).toEqual([false, false]);
    gates[0].resolve();
    gates[1].reject(new Error("Synthetic late rejection"));
    await Promise.all(gates.map((gate) => gate.promise.catch(() => {})));
    expect(grants.map((grant) => grant())).toEqual([false, false]);
    expect(admission.failure).toMatchObject({ message: "SQLite worker admission is closed" });
    expect(admission.failureSource).toBe("authority");
    expect(admission.cleanupFailures).toEqual([]);
  } finally {
    admission.finish();
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(gates.map((gate) => gate.promise.catch(() => {})));
  }
});

it.each(["sync", "async"] as const)(
  "refuses %s admission when the callback throws synchronously",
  (mode) => {
    const rejected = new Error("Synthetic synchronous refusal");
    const factory =
      mode === "sync"
        ? createSqliteWorkerOperationAdmission
        : createAsyncSqliteWorkerOperationAdmission;
    const admission = factory(() => {
      throw rejected;
    });
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      admission.port.postMessage({ stage: "open", decision: decision.buffer });
      admission.service();
      expect(Atomics.load(decision, 0)).toBe(2);
      expect(admission.failure).toBe(rejected);
      expect(admission.failureSource).toBe("domain");
    } finally {
      admission.finish();
    }
  },
);

it("refuses a synchronous callback without a grant before service returns", () => {
  let grantLater: (() => boolean) | undefined;
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    grantLater = grant;
  });
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    admission.port.postMessage({ stage: "transaction", decision: decision.buffer });
    admission.service();
    expect(Atomics.load(decision, 0)).toBe(2);
    expect(grantLater).toBeDefined();
    expect(grantLater?.()).toBe(false);
    expect(admission.failure).toMatchObject({ message: "SQLite worker admission was not granted" });
    expect(admission.failureSource).toBe("domain");
  } finally {
    admission.finish();
  }
});

it.each(["grant", "revoke", "close", "self-fence", "request-revoke", "late-revoke"] as const)(
  "waits for the live owner's %s decision when host scheduling is delayed",
  (outcome) => {
    const revoked = new Error("Synthetic owner authority revoked");
    let requestCurrent = outcome !== "request-revoke";
    let databaseCurrent = true;
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
      if (outcome === "revoke") {
        throw revoked;
      }
      if (outcome === "self-fence") {
        requestCurrent = false;
      }
      if (outcome === "late-revoke") {
        databaseCurrent = false;
      }
      grant();
    });
    admission.bindDatabaseAuthority({
      databasePath: path.resolve("synthetic-delayed-writer.sqlite"),
      assertRequest() {
        if (!requestCurrent) {
          throw revoked;
        }
      },
      assertAccess() {
        if (!databaseCurrent) {
          throw revoked;
        }
      },
      acquireSchema() {
        throw new Error("Ordinary admission must not acquire schema authority");
      },
    });
    const mutate = vi.fn();
    // Advance a delayed native wait without sleeping or blocking the test host.
    // The host has not run yet: elapsed time is not an authority decision.
    vi.spyOn(Atomics, "wait")
      .mockImplementationOnce(() => "timed-out")
      .mockImplementationOnce(() => {
        if (outcome === "close") {
          admission.finish();
        } else {
          admission.service();
        }
        return "ok";
      });
    const write = () =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        mutate();
      });
    try {
      if (outcome === "grant" || outcome === "self-fence") {
        expect(write).not.toThrow();
        expect(mutate).toHaveBeenCalledOnce();
        expect(admission.failure).toBeUndefined();
        expect(admission.failureSource).toBeUndefined();
      } else {
        expect(write).toThrow("SQLite transaction admission was refused");
        expect(mutate).not.toHaveBeenCalled();
        expect(admission.failure).toMatchObject({
          message: outcome === "close" ? "SQLite worker admission is closed" : revoked.message,
        });
        expect(admission.failureSource).toBe(outcome === "revoke" ? "domain" : "authority");
      }
    } finally {
      admission.finish();
    }
  },
);

it("rechecks database ownership after a worker request crosses the message port", () => {
  const root = tempDirs.make("openclaw-worker-admission-maintenance-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const admit = vi.fn((_request: SqliteWorkerAdmissionRequest, grant: () => boolean) => grant());
  const admission = createSqliteWorkerOperationAdmission(admit);
  let maintenance: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  try {
    admission.bindDatabaseAuthority({
      databasePath,
      assertAccess: () => assertStateDatabaseAccessAllowed(databasePath),
      acquireSchema() {
        throw new Error("Ordinary admission must not acquire schema authority");
      },
    });
    const queueRequest = () => {
      const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      admission.port.postMessage({ stage: "transaction", decision: decision.buffer }, []);
      return decision;
    };
    const allowed = queueRequest();
    admission.service();
    expect(Atomics.load(allowed, 0)).toBe(1);
    expect(admit).toHaveBeenCalledOnce();
    admit.mockClear();

    const pending = queueRequest();
    maintenance = acquireGatewayStateOwner({ databasePath });
    admission.service();
    expect(Atomics.load(pending, 0)).toBe(2);
    expect(admit).not.toHaveBeenCalled();
    expect(admission.failure).toMatchObject({
      message: expect.stringContaining("undergoing offline maintenance"),
    });
    expect(admission.failureSource).toBe("authority");
  } finally {
    admission.finish();
    maintenance?.release();
  }
});

it("retains exact-target schema authority until settlement and rechecks access for later grants", () => {
  const databasePath = path.resolve("synthetic-schema.sqlite");
  const revoked = new Error("Database owner revoked");
  let current = true;
  const release = vi.fn();
  const acquireSchema = vi.fn(() => ({ assertCurrent() {}, release }));
  const admit = vi.fn((_request: SqliteWorkerAdmissionRequest, grant: () => boolean) => grant());
  const admission = createSqliteWorkerOperationAdmission(admit);
  admission.bindDatabaseAuthority({
    databasePath,
    assertAccess() {
      if (!current) {
        throw revoked;
      }
    },
    acquireSchema,
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
      expect(requestSqliteWorkerSchemaMaintenance(databasePath)).toBe(true);
      expect(requestSqliteWorkerSchemaMaintenance(databasePath)).toBe(true);
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: "ordinary write" });
      current = false;
      expect(() =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "revoked write" }),
      ).toThrow("SQLite transaction admission was refused");
    });
    expect(acquireSchema).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledExactlyOnceWith(
      { stage: "transaction", facts: "ordinary write" },
      expect.any(Function),
    );
    expect(admission.failure).toBe(revoked);
    expect(release).not.toHaveBeenCalled();
    admission.finish();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    admission.finish();
  }
});

it("refuses schema maintenance for a different database before acquiring authority", () => {
  const databasePath = path.resolve("synthetic-schema.sqlite");
  const admit = vi.fn();
  const acquireSchema = vi.fn(() => ({ assertCurrent() {}, release() {} }));
  const admission = createSqliteWorkerOperationAdmission(admit);
  admission.bindDatabaseAuthority({ databasePath, assertAccess() {}, acquireSchema });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        requestSqliteWorkerSchemaMaintenance(path.resolve("another-schema.sqlite")),
      ),
    ).toThrow("SQLite transaction admission was refused");
    expect(admission.failure).toMatchObject({
      message: "SQLite schema maintenance target differs from its admitted database",
    });
    expect(acquireSchema).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  } finally {
    admission.finish();
  }
});

it("reads a queued worker commit before settlement and message callbacks run", async () => {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const posted = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const posted = new Int32Array(workerData.posted);
    workerData.port.postMessage({ kind: "native-commit", committed: { facts: { count: 1 } } });
    Atomics.store(posted, 0, 1);
    Atomics.notify(posted, 0);
    Atomics.wait(posted, 1, 0, 10_000);
    workerData.port.postMessage({ kind: "native-settlement", settlement: {
      kind: "unknown", committed: { facts: { count: 1 } },
    } });
    workerData.port.close();
    Atomics.store(posted, 0, 2);
    Atomics.notify(posted, 0);
    parentPort.close();
  `,
    {
      eval: true,
      workerData: { port: admission.port, posted: posted.buffer },
      transferList: [admission.port],
    },
  );
  const joined = new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  try {
    if (Atomics.load(posted, 0) === 0) {
      Atomics.wait(posted, 0, 0, 10_000);
    }
    expect(Atomics.load(posted, 0)).toBe(1);
    expect(admission.settlement).toBeUndefined();
    expect(admission.committed).toEqual({ facts: { count: 1 } });
    expect(admission.settlement).toBeUndefined();
    Atomics.store(posted, 1, 1);
    Atomics.notify(posted, 1);
    if (Atomics.load(posted, 0) === 1) {
      Atomics.wait(posted, 0, 1, 10_000);
    }
    expect(Atomics.load(posted, 0)).toBe(2);
    expect(admission.settlement).toBeUndefined();
    admission.finish();
    expect(admission.committed).toEqual({ facts: { count: 1 } });
    expect(admission.settlement).toEqual({ kind: "unknown", committed: { facts: { count: 1 } } });
    expect(await joined).toBe(0);
  } finally {
    Atomics.store(posted, 1, 1);
    Atomics.notify(posted, 1);
    admission.finish();
    await worker.terminate();
  }
});

it.each(["commit", "rollback", "unknown", "later rollback", "later commit"] as const)(
  "keeps committed facts distinct from %s settlement",
  (outcome) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proof (value INTEGER)");
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    const owner: SqliteWorkerOperationContext = { port: admission.port };
    try {
      const write = (value: number, rollback = false) =>
        withSqliteWorkerOperationAdmission(owner, () =>
          withSqlitePostCommitPublications(db, () =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO proof VALUES (?)").run(value);
              deferSqliteWorkerCommitReceipt(db, { value });
              if (rollback) {
                throw new Error("Rollback the synthetic write");
              }
            }),
          ),
        );
      if (outcome === "rollback") {
        expect(() => write(1, true)).toThrow("Rollback the synthetic write");
      } else {
        write(1);
        if (outcome === "later rollback") {
          expect(() => write(2, true)).toThrow("Rollback the synthetic write");
        } else if (outcome === "later commit") {
          write(2);
        }
      }
      const committed =
        outcome === "rollback"
          ? undefined
          : { facts: { value: outcome === "later commit" ? 2 : 1 } };
      expect(admission.settlement).toBeUndefined();
      expect(admission.committed).toEqual(committed);
      expect(admission.settlement).toBeUndefined();
      expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
      settleSqliteWorkerOperationContext(owner, outcome === "unknown" ? "unknown" : "completed");
      if (outcome === "unknown") {
        expect(() => admission.waitForSettlement(performance.now())).toThrow(
          "settlement is unknown",
        );
        expect(admission.settlement).toEqual({
          kind: "unknown",
          committed: { facts: { value: 1 } },
        });
      } else {
        expect(admission.waitForSettlement(performance.now())).toEqual(
          committed ? { kind: "completed", committed } : { kind: "completed" },
        );
      }
      expect(db.prepare("SELECT value FROM proof ORDER BY value").all()).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "later commit"
            ? [{ value: 1 }, { value: 2 }]
            : [{ value: 1 }],
      );
      admission.finish();
      expect(admission.committed).toEqual(committed);
      if (outcome === "commit") {
        expect(admission.waitForSettlement(performance.now()).committed?.facts).toEqual({
          value: 1,
        });
      }
    } finally {
      admission.finish();
      db.close();
    }
  },
);

it("does not treat a grant or a lost settlement message as a committed receipt", () => {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    admission.port.postMessage(
      {
        stage: "transaction",
        facts: undefined,
        decision: decision.buffer,
      },
      [],
    );
    admission.service();
    expect(Atomics.load(decision, 0)).toBe(1);
    expect(admission.committed).toBeUndefined();
    expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
    expect(admission.settlement).toBeUndefined();
  } finally {
    admission.finish();
  }
});

it.each(["malformed", "after settlement"] as const)(
  "retains confirmed facts when a later commit receipt is %s",
  (receipt) => {
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    try {
      admission.port.postMessage({ kind: "native-commit", committed: { facts: { value: 1 } } }, []);
      if (receipt === "after settlement") {
        admission.port.postMessage(
          {
            kind: "native-settlement",
            settlement: { kind: "completed", committed: { facts: { value: 1 } } },
          },
          [],
        );
      }
      admission.port.postMessage(
        {
          kind: "native-commit",
          committed: receipt === "malformed" ? null : { facts: { value: 2 } },
        },
        [],
      );
      admission.finish();
      expect(admission.committed).toEqual({ facts: { value: 1 } });
      expect(admission.failure).toMatchObject({
        message: "SQLite worker commit receipt is invalid",
      });
      expect(() => admission.waitForSettlement(performance.now())).toThrow(
        "SQLite worker commit receipt is invalid",
      );
    } finally {
      admission.finish();
    }
  },
);

it("shares the active operation across module copies without mixing nested ports", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  expect(duplicate.withSqliteWorkerOperationAdmission).not.toBe(withSqliteWorkerOperationAdmission);
  const outer = new MessageChannel();
  const inner = new MessageChannel();
  // Only the carrier is under test here. Real cross-thread grants and revocation
  // are covered by the publication and public-runtime reclamation tests.
  const grant = (message: { decision: SharedArrayBuffer }) => {
    Atomics.store(new Int32Array(message.decision), 0, 1);
  };
  const outerRequests = vi.spyOn(outer.port1, "postMessage").mockImplementation(grant);
  const innerRequests = vi.spyOn(inner.port1, "postMessage").mockImplementation(grant);
  const request = (facts: string) =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
  try {
    withSqliteWorkerOperationAdmission({ port: outer.port1 }, () => {
      request("outer-before");
      duplicate.withSqliteWorkerOperationAdmission({ port: inner.port1 }, () => request("inner"));
      request("outer-after");
    });
    expect(outerRequests.mock.calls.map(([message]) => message.facts)).toEqual([
      "outer-before",
      "outer-after",
    ]);
    expect(innerRequests.mock.calls.map(([message]) => message.facts)).toEqual(["inner"]);
    expect(() => request("outside")).toThrow("requires its retained admission");
    expect(outerRequests).toHaveBeenCalledTimes(2);
    expect(innerRequests).toHaveBeenCalledTimes(1);
  } finally {
    outer.port1.close();
    outer.port2.close();
    inner.port1.close();
    inner.port2.close();
  }
});

it("refuses escaped continuations and captured scopes after synchronous operation exit", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  const { port1, port2 } = new MessageChannel();
  const requests = vi.spyOn(port1, "postMessage");
  const schemaRequest = () => duplicate.requestSqliteWorkerSchemaMaintenance("synthetic.sqlite");
  const request = () =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
  try {
    const escaped = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      Promise.resolve().then(request),
    );
    await expect(escaped).rejects.toThrow("requires its retained admission");
    const escapedSchema = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      Promise.resolve().then(schemaRequest),
    );
    await expect(escapedSchema).rejects.toThrow("requires its retained admission");
    expect(schemaRequest()).toBe(false);
    const captured = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      AsyncLocalStorage.snapshot(),
    );
    expect(() => captured(request)).toThrow("requires its retained admission");
    expect(() => captured(schemaRequest)).toThrow("requires its retained admission");
    let failedScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: port1 }, () => {
        failedScope = AsyncLocalStorage.snapshot();
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(failedScope).toBeDefined();
    expect(() => failedScope?.(request)).toThrow("requires its retained admission");
    expect(() => failedScope?.(schemaRequest)).toThrow("requires its retained admission");
    expect(requests).not.toHaveBeenCalled();
  } finally {
    port1.close();
    port2.close();
  }
});
