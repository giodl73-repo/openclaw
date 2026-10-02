import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as sharedWorker from "../state/openclaw-state-worker-store.js";
import {
  captureConfigHealthStateStore,
  readConfigHealthStateFromStore,
  readConfigHealthStateFromStoreAsync,
  patchConfigHealthEntryToStore,
  patchConfigHealthEntryToStoreAsync,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import { createConfigIO } from "./io.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const home = directories.make("openclaw-health-scope-");
  const deps = {
    env: { HOME: home, OPENCLAW_STATE_DIR: home },
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  const configPath = path.join(home, "openclaw.json");
  patchConfigHealthEntryToStore(deps, configPath, {
    lastObservedSuspiciousSignature: "before",
  });
  return { deps, configPath };
}

it("plain broker reads retain observations and unconditional patches merge only supplied fields", async () => {
  const { deps, configPath } = fixture();
  const fingerprint = createConfigHealthFingerprint({ raw: "{}", parsed: {}, stat: null });
  patchConfigHealthEntryToStore(deps, configPath, { lastPromotedGood: fingerprint });
  using observation = captureConfigHealthStateStore(deps, configPath);
  using sibling = captureConfigHealthStateStore(deps, `${configPath}.other`);
  expect((await readConfigHealthStateFromStoreAsync(deps)).entries?.[configPath]).toMatchObject({
    lastObservedSuspiciousSignature: "before",
  });
  expect(observation.isCurrent()).toBe(true);
  await patchConfigHealthEntryToStoreAsync(deps, configPath, {
    lastObservedSuspiciousSignature: undefined,
  });
  expect(observation.isCurrent()).toBe(false);
  expect(sibling.isCurrent()).toBe(true);
  expect((await readConfigHealthStateFromStoreAsync(deps)).entries?.[configPath]).toMatchObject({
    lastObservedSuspiciousSignature: null,
    lastPromotedGood: fingerprint,
  });
});

it.each([false, true])(
  "publishes unconditional patch invalidation only with a commit receipt (committed: %s)",
  async (committed) => {
    const { deps, configPath } = fixture();
    using observation = captureConfigHealthStateStore(deps, configPath);
    const snapshot = await observation.read();
    if (!snapshot) {
      throw new Error("Expected current health snapshot");
    }
    const execute = sharedWorker.runOpenClawStateWorkerOperation;
    const failure = new Error("synthetic persistence delivery failure");
    let intercepted = false;
    let currentBeforeReturn: boolean | undefined;
    const spy = vi.spyOn(sharedWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      new Proxy(execute, {
        async apply(target, receiver, args) {
          if (intercepted) {
            return Reflect.apply(target, receiver, args);
          }
          intercepted = true;
          if (committed) {
            await Reflect.apply(target, receiver, args);
            // A prior observer resumes before the sync producer receives its result.
            await observation.update({ lastObservedSuspiciousSignature: "stale" }, snapshot);
          }
          currentBeforeReturn = observation.isCurrent();
          throw failure;
        },
      }),
    );
    try {
      await patchConfigHealthEntryToStoreAsync(deps, configPath, {
        lastObservedSuspiciousSignature: "after",
      });
    } finally {
      spy.mockRestore();
    }
    expect(currentBeforeReturn).toBe(!committed);
    expect(observation.isCurrent()).toBe(!committed);
    expect(
      (await readConfigHealthStateFromStoreAsync(deps)).entries?.[configPath]
        ?.lastObservedSuspiciousSignature,
    ).toBe(committed ? "after" : "before");
  },
);

it.each(["refuse", "supersede"] as const)(
  "rechecks the remote source and host observation at native commit (%s)",
  async (mode) => {
    const { deps, configPath } = fixture();
    using before = captureConfigHealthStateStore(deps, configPath);
    const snapshot = await before.read();
    if (!snapshot) {
      throw new Error("Expected current health snapshot");
    }
    const refusal = new Error("synthetic worker config lock closed");
    let checks = 0;
    const assertRemote = vi.fn(async () => {
      checks += 1;
      // Initial dispatch, native BEGIN, then native COMMIT.
      if (checks === 3) {
        if (mode === "refuse") {
          throw refusal;
        }
        using newer = captureConfigHealthStateStore(deps, configPath);
        expect(newer.isCurrent()).toBe(true);
      }
    });
    using observation = captureConfigHealthStateStore(deps, configPath, undefined, assertRemote);
    const update = observation.update({ lastObservedSuspiciousSignature: "stale" }, snapshot);
    if (mode === "refuse") {
      await expect(update).rejects.toThrow(refusal);
    } else {
      await update;
    }
    expect(assertRemote).toHaveBeenCalledTimes(3);
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(
      (await readConfigHealthStateFromStoreAsync(deps)).entries?.[configPath]
        ?.lastObservedSuspiciousSignature,
    ).toBe("before");
  },
);

it("refuses a plain broker patch when its host closes before native commit", async () => {
  const { deps, configPath } = fixture();
  using observation = captureConfigHealthStateStore(deps, configPath);
  let closed = false;
  const refusal = new Error("synthetic config persistence host closed");
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const spy = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          closed = true;
        }
        admit(request, grant);
      }, attachment),
    );
  try {
    await expect(
      patchConfigHealthEntryToStoreAsync(
        deps,
        configPath,
        { lastObservedSuspiciousSignature: "stale" },
        () => {
          if (closed) {
            throw refusal;
          }
        },
      ),
    ).rejects.toThrow(refusal);
  } finally {
    spy.mockRestore();
  }
  expect(closed).toBe(true);
  expect(observation.isCurrent()).toBe(true);
  expect(deps.logger.warn).not.toHaveBeenCalled();
});

it.each([false, true])(
  "publishes nested health invalidation only on outer commit (rollback: %s)",
  async (rollback) => {
    const { deps, configPath } = fixture();
    using observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    expect(before?.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
    const abort = new Error("fixture outer rollback");
    const mutate = () =>
      runOpenClawStateWriteTransaction(
        () => {
          patchConfigHealthEntryToStore(deps, configPath, {
            lastObservedSuspiciousSignature: "after",
          });
          expect(observation.isCurrent()).toBe(true);
          if (rollback) {
            throw abort;
          }
        },
        { env: deps.env },
      );
    if (rollback) {
      expect(mutate).toThrow(abort);
    } else {
      mutate();
    }
    expect(
      readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
    ).toBe(rollback ? "before" : "after");
    if (rollback) {
      expect(await observation.read()).toEqual(before);
    } else {
      expect(await observation.read()).toBeNull();
    }
  },
);

it("disposes newer scopes without reviving superseded observations and preserves other paths", async () => {
  const { deps, configPath } = fixture();
  using older = captureConfigHealthStateStore(deps, configPath);
  using otherPath = captureConfigHealthStateStore(deps, path.join(deps.env.HOME, "other.json"));
  expect(older.isCurrent()).toBe(true);
  {
    using newer = captureConfigHealthStateStore(deps, configPath);
    expect(await older.read()).toBeNull();
    expect(await newer.read()).not.toBeNull();
    expect(otherPath.isCurrent()).toBe(true);
  }
  expect(await older.read()).toBeNull();
  expect(await otherPath.read()).not.toBeNull();
});

it("continuations retain their captured database after planning scope disposal", async () => {
  const { deps, configPath } = fixture();
  let continueObservation: () => ReturnType<typeof captureConfigHealthStateStore>;
  {
    using planning = captureConfigHealthStateStore(deps, configPath);
    expect(await planning.read()).not.toBeNull();
    continueObservation = () => planning.captureContinuation();
  }
  deps.env.OPENCLAW_STATE_DIR = directories.make("openclaw-other-health-store-");
  patchConfigHealthEntryToStore(deps, configPath, {
    lastObservedSuspiciousSignature: "other-store",
  });
  using continuation = continueObservation();
  expect(
    (await continuation.read())?.state.entries?.[configPath]?.lastObservedSuspiciousSignature,
  ).toBe("before");
});

it("keeps sibling health rows and pending async observations independent of a sync observation", async () => {
  const { deps, configPath } = fixture();
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
  const snapshot = await createConfigIO({
    ...deps,
    configPath,
    observe: false,
  }).readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  const siblingPath = path.join(deps.env.HOME, "sibling.json");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  patchConfigHealthEntryToStore(deps, siblingPath, {
    lastObservedSuspiciousSignature: "sibling-before",
  });
  using sibling = captureConfigHealthStateStore(deps, siblingPath);
  const before = await sibling.read();
  expect(before?.basis?.[siblingPath]).toBeDefined();
  if (!before) {
    throw new Error("Expected current sibling observation");
  }

  now.mockReturnValue(1_700_000_000_001);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  expect(sibling.isCurrent()).toBe(true);
  expect((await sibling.read())?.basis?.[siblingPath]).toEqual(before.basis?.[siblingPath]);
  await sibling.update({ lastObservedSuspiciousSignature: "sibling-after" }, before);
  await closeOpenClawStateDatabaseAsync();
  expect(
    readConfigHealthStateFromStore(deps).entries?.[siblingPath]?.lastObservedSuspiciousSignature,
  ).toBe("sibling-after");
});

it("preserves worker-updated fields omitted by an already-read synchronous observation", async () => {
  const { deps, configPath } = fixture();
  const raw = JSON.stringify({ gateway: { mode: "local" } });
  fs.writeFileSync(configPath, raw);
  const snapshot = await createConfigIO({
    ...deps,
    configPath,
    observe: false,
  }).readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  const priorState = readConfigHealthStateFromStore(deps);
  const promoted = createConfigHealthFingerprint({
    raw,
    parsed: snapshot.parsed,
    stat: fs.statSync(configPath),
  });
  using workerObservation = captureConfigHealthStateStore(deps, configPath);
  const basis = await workerObservation.read();
  if (!basis) {
    throw new Error("Expected current worker observation");
  }
  await workerObservation.update({ lastPromotedGood: promoted }, basis);
  const committed = readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastPromotedGood;
  expect(committed).toEqual(promoted);

  const read = vi
    .spyOn(healthOwner, "readConfigHealthStateFromStore")
    .mockReturnValueOnce(priorState);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  read.mockRestore();
  await closeOpenClawStateDatabaseAsync();
  const after = readConfigHealthStateFromStore(deps).entries?.[configPath];
  expect(after?.lastKnownGood?.hash).toBe(promoted.hash);
  expect(after?.lastPromotedGood).toEqual(committed);
});

it.each(["read", "update"] as const)(
  "rejects retired database admission during health %s",
  async (operation) => {
    const { deps, configPath } = fixture();
    using observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    if (!before) {
      throw new Error("Expected current observation");
    }
    await closeOpenClawStateDatabaseAsync();
    await expect(
      operation === "read"
        ? observation.read()
        : observation.update({ lastObservedSuspiciousSignature: "stale" }, before),
    ).rejects.toThrow("read admission");
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(
      readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
    ).toBe("before");
  },
);

it("keeps a confirmed health write successful when its database is then closed", async () => {
  const { deps, configPath } = fixture();
  using observation = captureConfigHealthStateStore(deps, configPath);
  const before = await observation.read();
  if (!before) {
    throw new Error("Expected current observation");
  }
  const execute = sharedWorker.runOpenClawStateWorkerOperation;
  let applied: unknown;
  const spy = vi.spyOn(sharedWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(execute, {
      async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        applied = result;
        await closeOpenClawStateDatabaseAsync();
        return result;
      },
    }),
  );
  try {
    await observation.update({ lastObservedSuspiciousSignature: "committed" }, before);
  } finally {
    spy.mockRestore();
  }
  expect(applied).toBe(true);
  expect(deps.logger.warn).not.toHaveBeenCalled();
  expect(
    readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
  ).toBe("committed");
});
