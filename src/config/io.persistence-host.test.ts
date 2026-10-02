import { expect, it, vi } from "vitest";
import { appendConfigAuditRecord, appendConfigAuditRecordSync } from "./io.audit.js";
import {
  captureConfigHealthStateStore,
  patchConfigHealthEntryToStore,
  readConfigHealthStateFromStore,
  supersedeConfigHealthObservations,
  type ConfigHealthStateStore,
} from "./io.health-state.js";
import {
  getConfigPersistenceProvider,
  withConfigPersistenceProvider,
  type ConfigPersistenceProvider,
} from "./io.persistence-host.js";

it("routes sync and async persistence without replacing the caller's retained guard or store", async () => {
  const deps = { env: {}, homedir: () => "/synthetic-home", logger: { warn: vi.fn() } };
  const configPath = "/synthetic-home/openclaw.json";
  const assertCurrent = vi.fn();
  const store: ConfigHealthStateStore = {
    isCurrent: () => true,
    captureContinuation: () => store,
    read: async () => null,
    update: async () => undefined,
    updateAfterFileCommit: async () => undefined,
    [Symbol.dispose]() {},
  };
  const provider = {
    captureHealth: vi.fn(() => store),
    readHealth: vi.fn(() => ({})),
    patchHealth: vi.fn(),
    supersedeHealth: vi.fn(),
    appendAudit: vi.fn(async () => undefined),
    appendAuditSync: vi.fn(),
  } satisfies ConfigPersistenceProvider;
  const changes = { lastObservedSuspiciousSignature: undefined };
  const audit = {
    ...deps,
    record: {
      ts: "2026-10-01T00:00:00.000Z",
      source: "config-io" as const,
      event: "config.external" as const,
      detectedBy: "write" as const,
      configPath,
      previousHash: null,
      nextHash: "synthetic-next",
      valid: true,
    },
  };
  await withConfigPersistenceProvider(provider, async () => {
    expect(captureConfigHealthStateStore(deps, configPath, assertCurrent)).toBe(store);
    expect(readConfigHealthStateFromStore(deps)).toEqual({});
    patchConfigHealthEntryToStore(deps, configPath, changes);
    supersedeConfigHealthObservations(deps, configPath);
    await appendConfigAuditRecord(audit, assertCurrent);
    appendConfigAuditRecordSync(audit);
    expect(getConfigPersistenceProvider()).toBe(provider);
    withConfigPersistenceProvider(undefined, () => {
      expect(getConfigPersistenceProvider()).toBeUndefined();
    });
    expect(getConfigPersistenceProvider()).toBe(provider);
  });
  expect(getConfigPersistenceProvider()).toBeUndefined();
  expect(provider.captureHealth).toHaveBeenCalledWith(deps, configPath, assertCurrent);
  expect(provider.readHealth).toHaveBeenCalledWith(deps);
  expect(provider.patchHealth).toHaveBeenCalledWith(deps, configPath, changes);
  expect(provider.supersedeHealth).toHaveBeenCalledWith(deps, configPath);
  expect(provider.appendAudit).toHaveBeenCalledWith(audit, assertCurrent);
  expect(provider.appendAuditSync).toHaveBeenCalledWith(audit);

  const failure = new Error("Synthetic audit transport failure");
  provider.appendAudit.mockRejectedValue(failure);
  provider.appendAuditSync.mockImplementation(() => {
    throw failure;
  });
  await withConfigPersistenceProvider(provider, async () => {
    await expect(appendConfigAuditRecord(audit, assertCurrent)).resolves.toBeUndefined();
    expect(() => appendConfigAuditRecordSync(audit)).not.toThrow();

    let revoked = false;
    const refusal = new Error("Synthetic config guard revoked");
    provider.appendAudit.mockImplementation(async () => {
      revoked = true;
      throw failure;
    });
    await expect(
      appendConfigAuditRecord(audit, () => {
        if (revoked) {
          throw refusal;
        }
      }),
    ).rejects.toBe(refusal);
  });
});
