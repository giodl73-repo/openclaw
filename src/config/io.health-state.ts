import { formatErrorMessage } from "../infra/errors.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import {
  isArtifactPreservingStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  prepareConfigHealthPatch,
  readConfigHealthStateInDatabase,
  writeConfigHealthPatchInDatabase,
} from "./io.health-state.kernel.js";
import type {
  ConfigHealthEntryChanges,
  ConfigHealthState,
  ConfigHealthSnapshot,
} from "./io.health-state.types.js";
import { createConfigPersistenceAdmission } from "./io.persistence-admission.js";
import { getConfigPersistenceProvider } from "./io.persistence-host.js";
import { setBoundedConfigIoWarningEntry } from "./io.state.js";

type HealthObservation = {
  databasePath: string;
  configPath: string;
  identity: () => string | undefined;
};
const observations = resolveGlobalSet<HealthObservation>(
  Symbol.for("openclaw.configHealthObservations"),
  "close-and-restart",
);
const supersededObservation = new Error("Config health observation was superseded");
const pendingHealthPublications = resolveGlobalSet<() => void>(
  Symbol.for("openclaw.configHealthPublications"),
  "close-and-restart",
);

function publishCommittedHealthChanges(): void {
  for (const publish of pendingHealthPublications) {
    publish();
  }
}

function matchingObservations(next: HealthObservation): HealthObservation[] {
  publishCommittedHealthChanges();
  const matches: HealthObservation[] = [];
  for (const current of observations) {
    if (
      current.configPath === next.configPath &&
      (current.databasePath === next.databasePath ||
        (next.identity() !== undefined && current.identity() === next.identity()))
    ) {
      matches.push(current);
    }
  }
  return matches;
}

function supersedeMatchingObservations(next: HealthObservation): void {
  for (const current of matchingObservations(next)) {
    observations.delete(current);
  }
}

/** Synchronous producers invalidate in-flight observations without retaining a scope. */
export function supersedeConfigHealthObservations(
  deps: ConfigHealthStateDeps,
  configPath: string,
): void {
  const provider = getConfigPersistenceProvider();
  if (provider) {
    return provider.supersedeHealth(deps, configPath);
  }
  if (observations.size === 0) {
    return;
  }
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  let context: ReturnType<typeof captureOpenClawStateWorkerContext> | undefined;
  try {
    context = captureOpenClawStateWorkerContext({ path: databasePath, env });
  } catch {
    // Native admission still owns synchronous diagnostics; a sealed read scope is already invalid.
  }
  supersedeMatchingObservations({
    databasePath,
    configPath,
    identity: () => context?.admission.identity.key,
  });
}

// Fresh config snapshots share a database; retain failures until a write recovers.
const loggedHealthWriteFailures = new Map<string, string>();

export type ConfigHealthStateDeps = {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: Pick<typeof console, "warn">;
};

export function resolveConfigHealthStateEnv(deps: ConfigHealthStateDeps): NodeJS.ProcessEnv {
  if (deps.env.OPENCLAW_HOME || deps.env.HOME || deps.env.USERPROFILE || deps.env.PREFIX) {
    return deps.env;
  }
  return { ...deps.env, HOME: deps.homedir() };
}

function handleHealthReadFailure(error: unknown): ConfigHealthState {
  if (error instanceof OpenClawStateOwnershipError) {
    throw error;
  }
  return {};
}

function handleHealthWriteFailure(
  deps: ConfigHealthStateDeps,
  databasePath: string,
  error: unknown,
): void {
  if (error instanceof OpenClawStateOwnershipError || findStartupMaintenanceRequiredError(error)) {
    throw error;
  }
  const message = formatErrorMessage(error);
  const repeated = loggedHealthWriteFailures.get(databasePath) === message;
  setBoundedConfigIoWarningEntry(loggedHealthWriteFailures, databasePath, message);
  if (!repeated) {
    deps.logger.warn(`Config health-state write failed: ${message}`);
  }
}

export function readConfigHealthStateFromStore(deps: ConfigHealthStateDeps): ConfigHealthState {
  const provider = getConfigPersistenceProvider();
  if (provider) {
    return provider.readHealth(deps);
  }
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => readConfigHealthStateInDatabase(db), {
        env: resolveConfigHealthStateEnv(deps),
      }) ?? {}
    );
  } catch (error) {
    return handleHealthReadFailure(error);
  }
}

export function patchConfigHealthEntryToStore(
  deps: ConfigHealthStateDeps,
  configPath: string,
  changes: ConfigHealthEntryChanges,
): void {
  const provider = getConfigPersistenceProvider();
  if (provider) {
    return provider.patchHealth(deps, configPath, changes);
  }
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  try {
    const patch = prepareConfigHealthPatch(changes);
    if (Object.keys(patch).length === 0) {
      return;
    }
    const updatedAtMs = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        let pending: HealthObservation[] = [];
        if (observations.size > 0) {
          let context: ReturnType<typeof captureOpenClawStateWorkerContext> | undefined;
          try {
            context = captureOpenClawStateWorkerContext({ path: databasePath, env });
          } catch {
            // Maintenance may seal read admission while retaining the native writer.
          }
          pending = matchingObservations({
            databasePath,
            configPath,
            identity: () => context?.admission.identity.key,
          });
        }
        writeConfigHealthPatchInDatabase(db, configPath, patch, updatedAtMs);
        const publish = () => {
          for (const observation of pending) {
            observations.delete(observation);
          }
          loggedHealthWriteFailures.delete(databasePath);
        };
        if (!deferSqlitePostCommitPublication(db, publish)) {
          publish();
        }
      },
      { env, path: databasePath },
    );
  } catch (error) {
    handleHealthWriteFailure(deps, databasePath, error);
  }
}

/** A plain broker read does not create or supersede an observation. */
export async function readConfigHealthStateFromStoreAsync(
  deps: ConfigHealthStateDeps,
  assertCurrent?: () => void,
): Promise<ConfigHealthState> {
  const artifactPreserving = isArtifactPreservingStateRead();
  assertCurrent?.();
  try {
    const context = captureOpenClawStateWorkerContext({ env: resolveConfigHealthStateEnv(deps) });
    const snapshot = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "config.health.read", input: { artifactPreserving } }),
      { existingOnly: true, assertCurrent },
    );
    context.admission.assertCurrent();
    assertCurrent?.();
    return snapshot?.state ?? {};
  } catch (error) {
    assertCurrent?.();
    return handleHealthReadFailure(error);
  }
}

/** Sync producers borrow this unconditional broker write without changing their merge contract. */
export async function patchConfigHealthEntryToStoreAsync(
  deps: ConfigHealthStateDeps,
  configPath: string,
  changes: ConfigHealthEntryChanges,
  assertCurrent?: () => void,
): Promise<void> {
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  let admission: SqliteWorkerOperationAdmission | undefined;
  let pending: HealthObservation[] = [];
  const publish = () => {
    // Drain the retained port before granting another observation on the same native actor.
    if (admission?.committed?.facts !== configPath) {
      return;
    }
    for (const observation of pending) {
      observations.delete(observation);
    }
    loggedHealthWriteFailures.delete(databasePath);
    pendingHealthPublications.delete(publish);
  };
  assertCurrent?.();
  try {
    const patch = prepareConfigHealthPatch(changes);
    if (Object.keys(patch).length === 0) {
      return;
    }
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env });
    await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "config.health.patchUnconditional",
          input: { configPath, patch, updatedAtMs: Date.now() },
        }),
      {
        assertCurrent,
        createAdmission: () => {
          let stage: "transaction" | "commit" | "complete" = "transaction";
          admission = createSqliteWorkerOperationAdmission((request, grant) => {
            context.admission.assertCurrent();
            assertCurrent?.();
            if (stage === "complete" || request.stage !== stage) {
              throw new Error("Config health patch admission requested out of order");
            }
            if (stage === "commit") {
              pending = matchingObservations({
                databasePath,
                configPath,
                identity: () => context.admission.identity.key,
              });
              pendingHealthPublications.add(publish);
            }
            if (!grant()) {
              throw new Error("Config health patch admission expired");
            }
            stage = stage === "transaction" ? "commit" : "complete";
          });
          return { admission, nativeLocations: [databasePath] };
        },
      },
    );
  } catch (error) {
    assertCurrent?.();
    handleHealthWriteFailure(deps, databasePath, error);
  } finally {
    // A receipt survives result delivery failure; rollback must publish no invalidation.
    publish();
    pendingHealthPublications.delete(publish);
  }
}

export type ConfigHealthStateStore = Disposable & {
  isCurrent(): boolean;
  captureContinuation(): ConfigHealthStateStore;
  read(): Promise<ConfigHealthSnapshot | null>;
  update(changes: ConfigHealthEntryChanges, previous: ConfigHealthSnapshot): Promise<void>;
  updateAfterFileCommit(
    changes: ConfigHealthEntryChanges,
    previous: ConfigHealthSnapshot,
  ): Promise<void>;
};

/** Bind one asynchronous observation/recovery to its original shared-state owner. */
export function captureConfigHealthStateStore(
  deps: ConfigHealthStateDeps,
  configPath: string,
  assertAdmissionCurrent?: () => void,
  assertAdmissionCurrentAsync?: () => Promise<void>,
): ConfigHealthStateStore {
  const provider = getConfigPersistenceProvider();
  if (provider) {
    return provider.captureHealth(deps, configPath, assertAdmissionCurrent);
  }
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  let captured:
    | { context: ReturnType<typeof captureOpenClawStateWorkerContext> }
    | { error: unknown };
  try {
    captured = { context: captureOpenClawStateWorkerContext({ path: databasePath, env }) };
  } catch (error) {
    // Capture is eager, but failures retain the health owner's read/write policy.
    captured = { error };
  }
  const captureScope = (continuation = false): ConfigHealthStateStore => {
    assertAdmissionCurrent?.();
    const observation: HealthObservation = {
      databasePath,
      configPath,
      identity: () => ("context" in captured ? captured.context.admission.identity.key : undefined),
    };
    if (!continuation) {
      supersedeMatchingObservations(observation);
    }
    if (matchingObservations(observation).length === 0) {
      observations.add(observation);
    }
    const isCurrent = () => {
      publishCommittedHealthChanges();
      assertAdmissionCurrent?.();
      if ("context" in captured) {
        captured.context.admission.assertCurrent();
      }
      return observations.has(observation);
    };
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw supersededObservation;
      }
    };
    const createOperationGuard = () => {
      let guardFailed = false;
      return {
        assertAdmissionCurrentAsync: async () => {
          try {
            await assertAdmissionCurrentAsync?.();
            assertCurrent();
          } catch (error) {
            guardFailed = true;
            throw error;
          }
        },
        rethrowIfInvalid: (error: unknown) => {
          if (guardFailed && error !== supersededObservation) {
            throw error;
          }
          try {
            isCurrent();
          } catch {
            throw error;
          }
        },
        assertCurrent: () => {
          try {
            assertCurrent();
          } catch (error) {
            guardFailed = true;
            throw error;
          }
        },
      };
    };
    const store: ConfigHealthStateStore = {
      isCurrent,
      captureContinuation: () => captureScope(true),
      [Symbol.dispose]() {
        observations.delete(observation);
      },
      async read(): Promise<ConfigHealthSnapshot | null> {
        const artifactPreserving = isArtifactPreservingStateRead();
        const guard = createOperationGuard();
        try {
          if (assertAdmissionCurrentAsync) {
            await guard.assertAdmissionCurrentAsync();
          }
          if ("error" in captured) {
            throw captured.error;
          }
          const snapshot = (await runOpenClawStateWorkerOperation(
            captured.context,
            (scope) => scope.execute({ type: "config.health.read", input: { artifactPreserving } }),
            { existingOnly: true, assertCurrent: guard.assertCurrent },
          )) ?? { state: {}, basis: {} };
          if (assertAdmissionCurrentAsync) {
            await guard.assertAdmissionCurrentAsync();
          }
          return isCurrent() ? snapshot : null;
        } catch (error) {
          guard.rethrowIfInvalid(error);
          if (error === supersededObservation) {
            return null;
          }
          const state = handleHealthReadFailure(error);
          return isCurrent() ? { state, basis: null } : null;
        }
      },
      async update(
        changes: ConfigHealthEntryChanges,
        previous: ConfigHealthSnapshot,
      ): Promise<void> {
        const guard = createOperationGuard();
        try {
          const patch = prepareConfigHealthPatch(changes);
          if (Object.keys(patch).length === 0) {
            return;
          }
          if ("error" in captured) {
            throw captured.error;
          }
          if (assertAdmissionCurrentAsync) {
            await guard.assertAdmissionCurrentAsync();
          }
          const prior = previous.basis?.[configPath];
          const expected = previous.basis === null ? undefined : prior ? { ...prior } : null;
          const updatedAtMs = Date.now();
          const applied = await runOpenClawStateWorkerOperation(
            captured.context,
            (scope) =>
              scope.execute({
                type: "config.health.patch",
                input: { configPath, patch, expected, updatedAtMs },
              }),
            {
              assertCurrent: guard.assertCurrent,
              createAdmission: createConfigPersistenceAdmission(
                databasePath,
                guard.assertCurrent,
                guard.assertAdmissionCurrentAsync,
              ),
            },
          );
          if (applied && observations.has(observation)) {
            loggedHealthWriteFailures.delete(databasePath);
          }
        } catch (error) {
          guard.rethrowIfInvalid(error);
          if (error === supersededObservation) {
            return;
          }
          handleHealthWriteFailure(deps, databasePath, error);
        }
      },
      async updateAfterFileCommit(changes, previous): Promise<void> {
        try {
          await store.update(changes, previous);
        } catch (error) {
          // Ownership and maintenance refusals still propagate after the file commits.
          handleHealthWriteFailure(deps, databasePath, error);
        }
      },
    };
    return store;
  };
  return captureScope();
}
