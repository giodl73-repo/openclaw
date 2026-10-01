import { AsyncLocalStorage } from "node:async_hooks";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { ClawStateWorkerOperations } from "./state-worker-contract.js";

const mutationGuard = new AsyncLocalStorage<() => void>();

export function assertClawMutationCurrent(): void {
  mutationGuard.getStore()?.();
}

export function withClawMutationGuard<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const parent = mutationGuard.getStore();
  return mutationGuard.run(() => {
    parent?.();
    assertCurrent();
  }, run);
}

async function execute<Key extends keyof ClawStateWorkerOperations>(
  options: OpenClawStateDatabaseOptions,
  command: { type: Key; input: ClawStateWorkerOperations[Key]["input"] },
): Promise<ClawStateWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = mutationGuard.getStore();
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage !== "transaction" && request.stage !== "commit") {
          throw new Error("Claw state mutation requires transaction admission");
        }
        context.admission.assertCurrent();
        assertCurrent?.();
        grant();
      }),
    }),
  });
}

type persistClawInstallRecord = typeof import("./provenance.js").persistClawInstallRecord;
export async function persistClawInstallRecordAsync(
  arg0: Parameters<persistClawInstallRecord>[0],
  options: NonNullable<Parameters<persistClawInstallRecord>[1]> = {},
): Promise<ReturnType<persistClawInstallRecord>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { persistClawInstallRecord } = await import("./provenance.js");
    return persistClawInstallRecord(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.persistClawInstallRecord",
    input: {
      args: [arg0],
      options: {
        status: options.status,
        nowMs: options.nowMs,
        expectedExistingRecord: options.expectedExistingRecord,
        expectedExistingPlan: options.expectedExistingPlan,
        deferLegacyPlanUpgrade: options.deferLegacyPlanUpgrade,
        agentOrigin: options.agentOrigin,
      },
    },
  });
}

type updateClawInstallRecord = typeof import("./provenance.js").updateClawInstallRecord;
export async function updateClawInstallRecordAsync(
  arg0: Parameters<updateClawInstallRecord>[0],
  options: NonNullable<Parameters<updateClawInstallRecord>[1]> = {},
): Promise<ReturnType<updateClawInstallRecord>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { updateClawInstallRecord } = await import("./provenance.js");
    return updateClawInstallRecord(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.updateClawInstallRecord",
    input: {
      args: [arg0],
      options: {
        status: options.status,
        nowMs: options.nowMs,
        expectedClaw: options.expectedClaw,
        agentConfigDigest: options.agentConfigDigest,
      },
    },
  });
}

type updateClawInstallRecordStatus = typeof import("./provenance.js").updateClawInstallRecordStatus;
export async function updateClawInstallRecordStatusAsync(
  arg0: Parameters<updateClawInstallRecordStatus>[0],
  arg1: Parameters<updateClawInstallRecordStatus>[1],
  options: NonNullable<Parameters<updateClawInstallRecordStatus>[2]> = {},
): Promise<ReturnType<updateClawInstallRecordStatus>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { updateClawInstallRecordStatus } = await import("./provenance.js");
    return updateClawInstallRecordStatus(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.updateClawInstallRecordStatus",
    input: {
      args: [arg0, arg1],
      options: { nowMs: options.nowMs, expectedStatuses: options.expectedStatuses },
    },
  });
}

type deleteClawInstallRecord = typeof import("./provenance.js").deleteClawInstallRecord;
export async function deleteClawInstallRecordAsync(
  arg0: Parameters<deleteClawInstallRecord>[0],
  options: NonNullable<Parameters<deleteClawInstallRecord>[1]> = {},
): Promise<ReturnType<deleteClawInstallRecord>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { deleteClawInstallRecord } = await import("./provenance.js");
    return deleteClawInstallRecord(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.deleteClawInstallRecord",
    input: { args: [arg0], options: { expectedStatuses: options.expectedStatuses } },
  });
}

type persistClawPackageRef = typeof import("./provenance.js").persistClawPackageRef;
export async function persistClawPackageRefAsync(
  arg0: Parameters<persistClawPackageRef>[0],
  arg1: Parameters<persistClawPackageRef>[1],
  options: NonNullable<Parameters<persistClawPackageRef>[2]> = {},
): Promise<ReturnType<persistClawPackageRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { persistClawPackageRef } = await import("./provenance.js");
    return persistClawPackageRef(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.persistClawPackageRef",
    input: {
      args: [arg0, arg1],
      options: {
        status: options.status,
        nowMs: options.nowMs,
        relationship: options.relationship,
        origin: options.origin,
        independentOwner: options.independentOwner,
      },
    },
  });
}

type updateClawPackageRefStatus = typeof import("./provenance.js").updateClawPackageRefStatus;
export async function updateClawPackageRefStatusAsync(
  arg0: Parameters<updateClawPackageRefStatus>[0],
  arg1: Parameters<updateClawPackageRefStatus>[1],
  options: NonNullable<Parameters<updateClawPackageRefStatus>[2]> = {},
): Promise<ReturnType<updateClawPackageRefStatus>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { updateClawPackageRefStatus } = await import("./provenance.js");
    return updateClawPackageRefStatus(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.updateClawPackageRefStatus",
    input: { args: [arg0, arg1], options: { nowMs: options.nowMs } },
  });
}

type persistWorkspaceFile = typeof import("./workspace.js").persistWorkspaceFile;
export async function persistWorkspaceFileAsync(
  arg0: Parameters<persistWorkspaceFile>[0],
  options: NonNullable<Parameters<persistWorkspaceFile>[1]> = {},
): Promise<ReturnType<persistWorkspaceFile>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { persistWorkspaceFile } = await import("./workspace.js");
    return persistWorkspaceFile(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.persistWorkspaceFile",
    input: { args: [arg0], options: {} },
  });
}

type updateWorkspaceFileStatus = typeof import("./workspace.js").updateWorkspaceFileStatus;
export async function updateWorkspaceFileStatusAsync(
  arg0: Parameters<updateWorkspaceFileStatus>[0],
  arg1: Parameters<updateWorkspaceFileStatus>[1],
  options: NonNullable<Parameters<updateWorkspaceFileStatus>[2]> = {},
): Promise<ReturnType<updateWorkspaceFileStatus>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { updateWorkspaceFileStatus } = await import("./workspace.js");
    return updateWorkspaceFileStatus(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.updateWorkspaceFileStatus",
    input: { args: [arg0, arg1], options: {} },
  });
}

type upsertClawWorkspaceFile = typeof import("./workspace.js").upsertClawWorkspaceFile;
export async function upsertClawWorkspaceFileAsync(
  arg0: Parameters<upsertClawWorkspaceFile>[0],
  options: NonNullable<Parameters<upsertClawWorkspaceFile>[1]> = {},
): Promise<ReturnType<upsertClawWorkspaceFile>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { upsertClawWorkspaceFile } = await import("./workspace.js");
    return upsertClawWorkspaceFile(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.upsertClawWorkspaceFile",
    input: { args: [arg0], options: {} },
  });
}

type deleteClawWorkspaceFileRecord = typeof import("./workspace.js").deleteClawWorkspaceFileRecord;
export async function deleteClawWorkspaceFileRecordAsync(
  arg0: Parameters<deleteClawWorkspaceFileRecord>[0],
  arg1: Parameters<deleteClawWorkspaceFileRecord>[1],
  options: NonNullable<Parameters<deleteClawWorkspaceFileRecord>[2]> = {},
): Promise<ReturnType<deleteClawWorkspaceFileRecord>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { deleteClawWorkspaceFileRecord } = await import("./workspace.js");
    return deleteClawWorkspaceFileRecord(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.deleteClawWorkspaceFileRecord",
    input: { args: [arg0, arg1], options: {} },
  });
}

type persistClawMcpPendingRef = typeof import("./mcp.js").persistPendingRef;
export async function persistClawMcpPendingRefAsync(
  arg0: Parameters<persistClawMcpPendingRef>[0],
  arg1: Parameters<persistClawMcpPendingRef>[1],
  arg2: Parameters<persistClawMcpPendingRef>[2],
  arg3: Parameters<persistClawMcpPendingRef>[3],
  options: NonNullable<Parameters<persistClawMcpPendingRef>[4]> = {},
): Promise<ReturnType<persistClawMcpPendingRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { persistPendingRef } = await import("./mcp.js");
    return persistPendingRef(arg0, arg1, arg2, arg3, options);
  }
  return await execute(options, {
    type: "claws.state.persistClawMcpPendingRef",
    input: { args: [arg0, arg1, arg2, arg3], options: { nowMs: options.nowMs } },
  });
}

type updateClawMcpRef = typeof import("./mcp.js").updateRef;
export async function updateClawMcpRefAsync(
  arg0: Parameters<updateClawMcpRef>[0],
  arg1: Parameters<updateClawMcpRef>[1],
  options: NonNullable<Parameters<updateClawMcpRef>[2]> = {},
): Promise<ReturnType<updateClawMcpRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { updateRef } = await import("./mcp.js");
    return updateRef(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.updateClawMcpRef",
    input: { args: [arg0, arg1], options: { nowMs: options.nowMs } },
  });
}

type upsertClawMcpServerRef = typeof import("./mcp.js").upsertClawMcpServerRef;
export async function upsertClawMcpServerRefAsync(
  arg0: Parameters<upsertClawMcpServerRef>[0],
  options: NonNullable<Parameters<upsertClawMcpServerRef>[1]> = {},
): Promise<ReturnType<upsertClawMcpServerRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { upsertClawMcpServerRef } = await import("./mcp.js");
    return upsertClawMcpServerRef(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.upsertClawMcpServerRef",
    input: { args: [arg0], options: {} },
  });
}

type deleteClawMcpServerRef = typeof import("./mcp.js").deleteClawMcpServerRef;
export async function deleteClawMcpServerRefAsync(
  arg0: Parameters<deleteClawMcpServerRef>[0],
  arg1: Parameters<deleteClawMcpServerRef>[1],
  options: NonNullable<Parameters<deleteClawMcpServerRef>[2]> = {},
): Promise<ReturnType<deleteClawMcpServerRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { deleteClawMcpServerRef } = await import("./mcp.js");
    return deleteClawMcpServerRef(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.deleteClawMcpServerRef",
    input: { args: [arg0, arg1], options: {} },
  });
}

type persistClawCronPendingRef = typeof import("./cron.js").persistPendingRef;
export async function persistClawCronPendingRefAsync(
  arg0: Parameters<persistClawCronPendingRef>[0],
  arg1: Parameters<persistClawCronPendingRef>[1],
  options: NonNullable<Parameters<persistClawCronPendingRef>[2]> = {},
): Promise<ReturnType<persistClawCronPendingRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { persistPendingRef } = await import("./cron.js");
    return persistPendingRef(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.persistClawCronPendingRef",
    input: { args: [arg0, arg1], options: { nowMs: options.nowMs } },
  });
}

type updateClawCronRef = typeof import("./cron.js").updateRef;
export async function updateClawCronRefAsync(
  arg0: Parameters<updateClawCronRef>[0],
  arg1: Parameters<updateClawCronRef>[1],
  options: NonNullable<Parameters<updateClawCronRef>[2]> = {},
): Promise<ReturnType<updateClawCronRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { updateRef } = await import("./cron.js");
    return updateRef(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.updateClawCronRef",
    input: { args: [arg0, arg1], options: { nowMs: options.nowMs } },
  });
}

type upsertClawCronRef = typeof import("./cron.js").upsertClawCronRef;
export async function upsertClawCronRefAsync(
  arg0: Parameters<upsertClawCronRef>[0],
  options: NonNullable<Parameters<upsertClawCronRef>[1]> = {},
): Promise<ReturnType<upsertClawCronRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { upsertClawCronRef } = await import("./cron.js");
    return upsertClawCronRef(arg0, options);
  }
  return await execute(options, {
    type: "claws.state.upsertClawCronRef",
    input: { args: [arg0], options: {} },
  });
}

type deleteClawCronRef = typeof import("./cron.js").deleteClawCronRef;
export async function deleteClawCronRefAsync(
  arg0: Parameters<deleteClawCronRef>[0],
  arg1: Parameters<deleteClawCronRef>[1],
  options: NonNullable<Parameters<deleteClawCronRef>[2]> = {},
): Promise<ReturnType<deleteClawCronRef>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { deleteClawCronRef } = await import("./cron.js");
    return deleteClawCronRef(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.deleteClawCronRef",
    input: { args: [arg0, arg1], options: {} },
  });
}

type markClawCronRefRemoved = typeof import("./cron.js").markClawCronRefRemoved;
export async function markClawCronRefRemovedAsync(
  arg0: Parameters<markClawCronRefRemoved>[0],
  arg1: Parameters<markClawCronRefRemoved>[1],
  options: NonNullable<Parameters<markClawCronRefRemoved>[2]> = {},
): Promise<ReturnType<markClawCronRefRemoved>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { markClawCronRefRemoved } = await import("./cron.js");
    return markClawCronRefRemoved(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.markClawCronRefRemoved",
    input: { args: [arg0, arg1], options: { nowMs: options.nowMs } },
  });
}

type replaceClawPackageRefExpected =
  typeof import("./package-update-provenance.js").replaceClawPackageRefExpected;
export async function replaceClawPackageRefExpectedAsync(
  arg0: Parameters<replaceClawPackageRefExpected>[0],
  arg1: Parameters<replaceClawPackageRefExpected>[1],
  options: NonNullable<Parameters<replaceClawPackageRefExpected>[2]> = {},
): Promise<ReturnType<replaceClawPackageRefExpected>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { replaceClawPackageRefExpected } = await import("./package-update-provenance.js");
    return replaceClawPackageRefExpected(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.replaceClawPackageRefExpected",
    input: { args: [arg0, arg1], options: {} },
  });
}

type recordAgentProvenance = typeof import("../state/agent-provenance.js").recordAgentProvenance;
export async function recordAgentProvenanceAsync(
  arg0: Parameters<recordAgentProvenance>[0],
  arg1: Parameters<recordAgentProvenance>[1],
  options: NonNullable<Parameters<recordAgentProvenance>[2]> = {},
): Promise<ReturnType<recordAgentProvenance>> {
  if (options.database) {
    mutationGuard.getStore()?.();
    const { recordAgentProvenance } = await import("../state/agent-provenance.js");
    return recordAgentProvenance(arg0, arg1, options);
  }
  return await execute(options, {
    type: "claws.state.recordAgentProvenance",
    input: { args: [arg0, arg1], options: { nowMs: options.nowMs } },
  });
}
