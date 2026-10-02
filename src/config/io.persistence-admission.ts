import {
  createAsyncSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";

/** The remote source guard runs at each native write boundary, before the local final grant. */
export function createConfigPersistenceAdmission(
  databasePath: string,
  assertCurrent: () => void,
  assertAdmissionCurrentAsync: () => Promise<void>,
): SqliteWorkerAdmissionFactory {
  return () => {
    let stage: "transaction" | "commit" | "complete" = "transaction";
    return {
      nativeLocations: [databasePath],
      admission: createAsyncSqliteWorkerOperationAdmission(async (request, grant) => {
        if (stage === "complete" || request.stage !== stage) {
          throw new Error("Config persistence admission requested out of order");
        }
        await assertAdmissionCurrentAsync();
        assertCurrent();
        if (!grant()) {
          throw new Error("Config persistence admission expired");
        }
        stage = stage === "transaction" ? "commit" : "complete";
      }),
    };
  };
}
