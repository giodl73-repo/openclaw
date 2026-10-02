import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendConfigAuditRecord, type ConfigAuditRecord } from "../config/io.audit.js";
import {
  captureConfigHealthStateStore,
  patchConfigHealthEntryToStoreAsync,
  readConfigHealthStateFromStoreAsync,
  supersedeConfigHealthObservations,
  type ConfigHealthStateStore,
} from "../config/io.health-state.js";
import type { ConfigHealthSnapshot } from "../config/io.health-state.types.js";
import {
  getConfigPersistenceProvider,
  withConfigPersistenceProvider,
  type ConfigPersistenceProvider,
} from "../config/io.persistence-host.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import type { ClawConfigGuardRequest, ClawConfigRequest } from "./control-ui-config-contract.js";
import { createClawConfigPersistenceHost } from "./control-ui-config-host.js";
import { createClawConfigPort } from "./control-ui-config-port.js";

vi.mock("../config/io.audit.js", () => ({ appendConfigAuditRecord: vi.fn() }));
vi.mock("../config/io.health-state.js", () => ({
  captureConfigHealthStateStore: vi.fn(),
  patchConfigHealthEntryToStoreAsync: vi.fn(),
  readConfigHealthStateFromStoreAsync: vi.fn(),
  supersedeConfigHealthObservations: vi.fn(),
}));

const location = { env: { OPENCLAW_STATE_DIR: "synthetic-state" }, homedir: "synthetic-home" };
const configPath = "synthetic-config.json";
const snapshot: ConfigHealthSnapshot = {
  state: { entries: { [configPath]: { lastObservedSuspiciousSignature: "previous" } } },
  basis: {
    [configPath]: {
      lastKnownGoodJson: null,
      lastPromotedGoodJson: null,
      suspiciousSignature: "previous",
      updatedAtMs: 17,
    },
  },
};
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

beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

function storeFixture() {
  return {
    isCurrent: vi.fn(() => true),
    captureContinuation: vi.fn<() => ConfigHealthStateStore>(),
    read: vi.fn<ConfigHealthStateStore["read"]>().mockResolvedValue(snapshot),
    update: vi.fn<ConfigHealthStateStore["update"]>().mockResolvedValue(undefined),
    updateAfterFileCommit: vi
      .fn<ConfigHealthStateStore["updateAfterFileCommit"]>()
      .mockResolvedValue(undefined),
    [Symbol.dispose]: vi.fn(),
  } satisfies ConfigHealthStateStore;
}

function connect(
  guard: (request: ClawConfigGuardRequest) => unknown = () => {},
  assertAuthorityCurrent: () => void = () => {},
) {
  const host = createClawConfigPersistenceHost(assertAuthorityCurrent);
  const peer = createClawConfigPort<ClawConfigGuardRequest, ClawConfigRequest>(
    host.port,
    host.wake,
    guard,
  );
  cleanup.push(async () => {
    await peer.close();
    await host.close();
  });
  return { host, peer };
}

async function capture(peer: ReturnType<typeof connect>["peer"]) {
  return await peer.call<number>({ operation: "capture", location, configPath, guard: 7 });
}

it("keeps the original store for continuations after disposal and delegates exact CAS facts", async () => {
  const store = storeFixture();
  const continuation = storeFixture();
  store[Symbol.dispose].mockImplementation(() => {
    store.isCurrent.mockReturnValue(false);
  });
  store.captureContinuation.mockReturnValue(continuation);
  vi.mocked(captureConfigHealthStateStore).mockReturnValue(store);
  const { peer } = connect();
  const id = await capture(peer);
  expect(
    await peer.call({ operation: "read", observation: id, artifactPreserving: false }),
  ).toEqual(snapshot);
  await peer.call({ operation: "update", observation: id, changes, previous: snapshot });
  expect(store.update).toHaveBeenCalledExactlyOnceWith(changes, snapshot);
  await peer.call({ operation: "dispose", observation: id });
  expect(await peer.call({ operation: "current", observation: id })).toBe(false);
  const next = await peer.call<number>({ operation: "continue", observation: id });
  expect(next).not.toBe(id);
  expect(store.captureContinuation).toHaveBeenCalledOnce();
  await peer.call({
    operation: "updateAfterFileCommit",
    observation: next,
    changes,
    previous: snapshot,
  });
  expect(continuation.updateAfterFileCommit).toHaveBeenCalledExactlyOnceWith(changes, snapshot);
  expect(store.updateAfterFileCommit).not.toHaveBeenCalled();
  await expect(peer.call({ operation: "current", observation: next + 1 })).rejects.toThrow(
    "does not belong",
  );
});

it("preserves null reads and samples artifact preservation independently for each request", async () => {
  const store = storeFixture();
  const modes: boolean[] = [];
  store.read.mockImplementation(async () => {
    modes.push(isArtifactPreservingStateRead());
    return null;
  });
  vi.mocked(captureConfigHealthStateStore).mockReturnValue(store);
  vi.mocked(readConfigHealthStateFromStoreAsync).mockImplementation(async () => {
    modes.push(isArtifactPreservingStateRead());
    return {};
  });
  const { peer } = connect();
  const observation = await capture(peer);
  for (const artifactPreserving of [true, false]) {
    expect(await peer.call({ operation: "read", observation, artifactPreserving })).toBeNull();
    expect(await peer.call({ operation: "readHealth", location, artifactPreserving })).toEqual({});
  }
  expect(modes).toEqual([true, true, false, false]);
});

it("leaves provider scope before invoking canonical owners and dispatches patch/supersede/audit", async () => {
  const store = storeFixture();
  const provider: ConfigPersistenceProvider = {
    captureHealth: vi.fn(() => store),
    readHealth: vi.fn(() => ({})),
    patchHealth: vi.fn(),
    supersedeHealth: vi.fn(),
    appendAudit: vi.fn(async () => {}),
    appendAuditSync: vi.fn(),
  };
  vi.mocked(captureConfigHealthStateStore).mockImplementation((deps) => {
    expect(getConfigPersistenceProvider()).toBeUndefined();
    expect(deps.env).toEqual(location.env);
    expect(deps.homedir()).toBe(location.homedir);
    return store;
  });
  const { peer } = withConfigPersistenceProvider(provider, () => connect());
  await capture(peer);
  await peer.call({ operation: "patchHealth", location, configPath, changes });
  expect(vi.mocked(patchConfigHealthEntryToStoreAsync).mock.calls[0]?.slice(1, 3)).toEqual([
    configPath,
    changes,
  ]);
  await peer.call({ operation: "supersede", location, configPath });
  expect(supersedeConfigHealthObservations).toHaveBeenCalledWith(
    expect.objectContaining({ env: location.env }),
    configPath,
  );
  await peer.call({ operation: "audit", location, record, guard: 8 });
  expect(appendConfigAuditRecord).toHaveBeenCalledWith(
    expect.objectContaining({ env: location.env, record }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(provider.captureHealth).not.toHaveBeenCalled();
});

it.each(["read", "updateAfterFileCommit"] as const)(
  "preserves typed ownership refusal from %s",
  async (operation) => {
    const store = storeFixture();
    const refusal = new OpenClawStateOwnershipError("Synthetic ownership refusal");
    store[operation].mockRejectedValue(refusal);
    vi.mocked(captureConfigHealthStateStore).mockReturnValue(store);
    const { peer } = connect();
    const observation = await capture(peer);
    const request: ClawConfigRequest =
      operation === "read"
        ? { operation, observation, artifactPreserving: false }
        : { operation, observation, changes, previous: snapshot };
    await expect(peer.call(request)).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
  },
);

it.each(["health", "audit"] as const)(
  "refuses %s effects when the worker-local guard refuses",
  async (kind) => {
    const written = vi.fn();
    const refusal = new OpenClawStateOwnershipError("Synthetic worker-local guard refusal");
    const guard = vi.fn(() => {
      throw refusal;
    });
    const store = storeFixture();
    vi.mocked(captureConfigHealthStateStore).mockImplementation((_deps, _path, _current, check) => {
      store.update.mockImplementation(async () => {
        await check?.();
        written();
      });
      return store;
    });
    vi.mocked(appendConfigAuditRecord).mockImplementation(async (_params, _current, check) => {
      await check?.();
      written();
    });
    const { peer } = connect(guard);
    const observation = await capture(peer);
    const request: ClawConfigRequest =
      kind === "health"
        ? { operation: "update", observation, changes, previous: snapshot }
        : { operation: "audit", location, record, guard: 7 };
    await expect(peer.call(request)).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
    expect(guard).toHaveBeenCalledExactlyOnceWith({ guard: 7 });
    expect(written).not.toHaveBeenCalled();
  },
);

it.each(["health", "audit"] as const)(
  "rechecks browser authority before %s admission after the worker guard completes",
  async (kind) => {
    const checked = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let current = true;
    const written = vi.fn();
    const workerGuard = vi.fn();
    const assertAuthorityCurrent = () => {
      if (!current) {
        throw new OpenClawStateOwnershipError("Synthetic browser authority revoked");
      }
    };
    const admit = async (assertCurrent?: () => void, check?: () => Promise<void>) => {
      await check?.();
      checked.resolve();
      await resume.promise;
      assertCurrent?.();
      written();
    };
    const store = storeFixture();
    vi.mocked(captureConfigHealthStateStore).mockImplementation(
      (_deps, _path, assertCurrent, check) => {
        store.update.mockImplementation(() => admit(assertCurrent, check));
        return store;
      },
    );
    vi.mocked(appendConfigAuditRecord).mockImplementation((_params, assertCurrent, check) =>
      admit(assertCurrent, check),
    );
    const { peer } = connect(workerGuard, assertAuthorityCurrent);
    const observation = await capture(peer);
    const request: ClawConfigRequest =
      kind === "health"
        ? { operation: "update", observation, changes, previous: snapshot }
        : { operation: "audit", location, record, guard: 7 };
    const result = peer.call(request).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await checked.promise;
      expect(workerGuard).toHaveBeenCalledExactlyOnceWith({ guard: 7 });
      current = false;
      resume.resolve();
      expect(await result).toBeInstanceOf(OpenClawStateOwnershipError);
      expect(written).not.toHaveBeenCalled();
      await peer.call({ operation: "dispose", observation });
      expect(store[Symbol.dispose]).toHaveBeenCalledOnce();
    } finally {
      resume.resolve();
      await result;
    }
  },
);

it("refuses an accepted plain health patch after the host closes", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const written = vi.fn();
  vi.mocked(patchConfigHealthEntryToStoreAsync).mockImplementation(
    async (_deps, _path, _changes, assertCurrent) => {
      entered.resolve();
      await resume.promise;
      assertCurrent?.();
      written();
    },
  );
  const { host, peer } = connect();
  const result = peer.call({ operation: "patchHealth", location, configPath, changes }).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  try {
    await entered.promise;
    const closing = host.close();
    resume.resolve();
    await closing;
    const outcome = await result;
    expect(written).not.toHaveBeenCalled();
    expect(outcome.error).toBeInstanceOf(Error);
  } finally {
    resume.resolve();
    await result;
  }
});

it.each(["health", "audit"] as const)(
  "settles owned rollback %s metadata after revocation without waiving source custody",
  async (kind) => {
    let sourceCurrent = true;
    const written = vi.fn();
    const store = storeFixture();
    const admit = async (assertCurrent?: () => void, check?: () => Promise<void>) => {
      await check?.();
      assertCurrent?.();
      written();
    };
    vi.mocked(captureConfigHealthStateStore).mockImplementation(
      (_deps, _path, assertCurrent, check) => {
        assertCurrent?.();
        store.update.mockImplementation(() => admit(assertCurrent, check));
        return store;
      },
    );
    vi.mocked(appendConfigAuditRecord).mockImplementation((_params, assertCurrent, check) =>
      admit(assertCurrent, check),
    );
    const { peer } = connect(
      () => {
        if (!sourceCurrent) {
          throw new OpenClawStateOwnershipError("Rollback source changed");
        }
      },
      () => {
        throw new Error("Browser authority revoked");
      },
    );
    await expect(capture(peer)).rejects.toThrow("Browser authority revoked");
    const observation = await peer.call<number>({
      operation: "capture",
      location,
      configPath,
      guard: 7,
      rollbackMetadata: true,
    });
    const request: ClawConfigRequest =
      kind === "health"
        ? { operation: "update", observation, changes, previous: snapshot }
        : { operation: "audit", location, record, guard: 7, rollbackMetadata: true };
    await peer.call(request);
    expect(written).toHaveBeenCalledOnce();
    sourceCurrent = false;
    await expect(peer.call(request)).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
    expect(written).toHaveBeenCalledOnce();
    await expect(peer.call({ operation: "audit", location, record, guard: 7 })).rejects.toThrow(
      "Browser authority revoked",
    );
  },
);
