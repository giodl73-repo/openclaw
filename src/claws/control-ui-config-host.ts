import { MessageChannel } from "node:worker_threads";
import { appendConfigAuditRecord } from "../config/io.audit.js";
import {
  captureConfigHealthStateStore,
  patchConfigHealthEntryToStoreAsync,
  readConfigHealthStateFromStoreAsync,
  supersedeConfigHealthObservations,
  type ConfigHealthStateStore,
} from "../config/io.health-state.js";
import { withConfigPersistenceProvider } from "../config/io.persistence-host.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import type {
  ClawConfigGuardRequest,
  ClawConfigLocation,
  ClawConfigRequest,
} from "./control-ui-config-contract.js";
import { createClawConfigPort } from "./control-ui-config-port.js";

/** Keep metadata observations on the Gateway owner, including disposed continuation factories. */
export function createClawConfigPersistenceHost(assertAuthorityCurrent: () => void) {
  const { port1, port2 } = new MessageChannel();
  const wake = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const observations = new Map<number, ConfigHealthStateStore>();
  let nextObservation = 0;
  let closed = false;
  const assertOwnerCurrent = () => {
    if (closed) {
      throw new Error("Claw config persistence owner is closed.");
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    assertAuthorityCurrent();
  };
  const deps = (location: ClawConfigLocation) => ({
    env: location.env,
    homedir: () => location.homedir,
    logger: console,
  });
  const retain = (store: ConfigHealthStateStore) => {
    const id = ++nextObservation;
    observations.set(id, store);
    return id;
  };
  const observation = (id: number) => {
    const store = observations.get(id);
    if (!store) {
      throw new Error("Claw config observation does not belong to this operation.");
    }
    return store;
  };
  const guard = (id: number, assertMetadataCurrent: () => void) => async () => {
    assertMetadataCurrent();
    await endpoint.call<void>({ guard: id });
    assertMetadataCurrent();
  };
  const dispatch = (request: ClawConfigRequest): unknown | Promise<unknown> => {
    assertOwnerCurrent();
    // Only canonical rollback steps set this private metadata flag. Their original source
    // guards and database ownership remain required; the bridge cannot write config files.
    const assertMetadataCurrent = request.rollbackMetadata ? assertOwnerCurrent : assertCurrent;
    switch (request.operation) {
      case "capture":
        return retain(
          captureConfigHealthStateStore(
            deps(request.location),
            request.configPath,
            assertMetadataCurrent,
            guard(request.guard, assertMetadataCurrent),
          ),
        );
      case "continue":
        return retain(observation(request.observation).captureContinuation());
      case "current":
        return observation(request.observation).isCurrent();
      case "dispose":
        observation(request.observation)[Symbol.dispose]();
        return;
      case "read": {
        const read = () => observation(request.observation).read();
        return request.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
      }
      case "update":
      case "updateAfterFileCommit":
        return observation(request.observation)[request.operation](
          request.changes,
          request.previous,
        );
      case "readHealth": {
        const read = () =>
          readConfigHealthStateFromStoreAsync(deps(request.location), assertMetadataCurrent);
        return request.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
      }
      case "supersede":
        return supersedeConfigHealthObservations(deps(request.location), request.configPath);
      case "patchHealth":
        return patchConfigHealthEntryToStoreAsync(
          deps(request.location),
          request.configPath,
          request.changes,
          assertMetadataCurrent,
        );
      case "audit":
        return appendConfigAuditRecord(
          { ...deps(request.location), record: request.record },
          assertMetadataCurrent,
          guard(request.guard, assertMetadataCurrent),
        );
    }
  };
  const endpoint = createClawConfigPort<ClawConfigRequest, ClawConfigGuardRequest>(
    port1,
    wake,
    (request) => withConfigPersistenceProvider(undefined, () => dispatch(request)),
  );
  return {
    port: port2,
    wake,
    async close() {
      closed = true;
      await endpoint.close();
      for (const store of observations.values()) {
        store[Symbol.dispose]();
      }
      observations.clear();
      port2.close();
    },
  };
}
