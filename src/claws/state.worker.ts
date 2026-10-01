import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { persistPendingRef as persistClawCronPendingRef } from "./cron.js";
import { updateRef as updateClawCronRef } from "./cron.js";
import { upsertClawCronRef } from "./cron.js";
import { deleteClawCronRef } from "./cron.js";
import { markClawCronRefRemoved } from "./cron.js";
import { persistPendingRef as persistClawMcpPendingRef } from "./mcp.js";
import { updateRef as updateClawMcpRef } from "./mcp.js";
import { upsertClawMcpServerRef } from "./mcp.js";
import { deleteClawMcpServerRef } from "./mcp.js";
import { replaceClawPackageRefExpected } from "./package-update-provenance.js";
import { persistClawInstallRecord } from "./provenance.js";
import { updateClawInstallRecord } from "./provenance.js";
import { updateClawInstallRecordStatus } from "./provenance.js";
import { deleteClawInstallRecord } from "./provenance.js";
import { persistClawPackageRef } from "./provenance.js";
import { updateClawPackageRefStatus } from "./provenance.js";
import type { ClawStateCommand } from "./state-worker-contract.js";
import { persistWorkspaceFile } from "./workspace.js";
import { updateWorkspaceFileStatus } from "./workspace.js";
import { upsertClawWorkspaceFile } from "./workspace.js";
import { deleteClawWorkspaceFileRecord } from "./workspace.js";

/** Canonical persistence functions execute synchronously on the shared SQLite actor. */
export function executeClawStateCommand(
  command: ClawStateCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = (() => {
        switch (command.type) {
          case "claws.state.persistClawInstallRecord":
            if (
              readAgentDeletionJournalInDatabase(
                database,
                command.input.args[0].agent.finalId,
                "runtime",
              )
            ) {
              throw new Error("Claw add is blocked by agent deletion recovery.");
            }
            return persistClawInstallRecord(command.input.args[0], {
              ...command.input.options,
              database,
            });
          case "claws.state.updateClawInstallRecord":
            return updateClawInstallRecord(command.input.args[0], {
              ...command.input.options,
              database,
            });
          case "claws.state.updateClawInstallRecordStatus":
            return updateClawInstallRecordStatus(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.deleteClawInstallRecord":
            return deleteClawInstallRecord(command.input.args[0], {
              ...command.input.options,
              database,
            });
          case "claws.state.persistClawPackageRef":
            return persistClawPackageRef(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.updateClawPackageRefStatus":
            return updateClawPackageRefStatus(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.persistWorkspaceFile":
            return persistWorkspaceFile(command.input.args[0], {
              ...command.input.options,
              database,
            });
          case "claws.state.updateWorkspaceFileStatus":
            return updateWorkspaceFileStatus(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.upsertClawWorkspaceFile":
            return upsertClawWorkspaceFile(command.input.args[0], {
              ...command.input.options,
              database,
            });
          case "claws.state.deleteClawWorkspaceFileRecord":
            return deleteClawWorkspaceFileRecord(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.persistClawMcpPendingRef":
            return persistClawMcpPendingRef(
              command.input.args[0],
              command.input.args[1],
              command.input.args[2],
              command.input.args[3],
              { ...command.input.options, database },
            );
          case "claws.state.updateClawMcpRef":
            return updateClawMcpRef(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.upsertClawMcpServerRef":
            return upsertClawMcpServerRef(command.input.args[0], {
              ...command.input.options,
              database,
            });
          case "claws.state.deleteClawMcpServerRef":
            return deleteClawMcpServerRef(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.persistClawCronPendingRef":
            return persistClawCronPendingRef(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.updateClawCronRef":
            return updateClawCronRef(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.upsertClawCronRef":
            return upsertClawCronRef(command.input.args[0], { ...command.input.options, database });
          case "claws.state.deleteClawCronRef":
            return deleteClawCronRef(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.markClawCronRefRemoved":
            return markClawCronRefRemoved(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.replaceClawPackageRefExpected":
            return replaceClawPackageRefExpected(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
          case "claws.state.recordAgentProvenance":
            return recordAgentProvenance(command.input.args[0], command.input.args[1], {
              ...command.input.options,
              database,
            });
        }
      })();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database },
  );
}
