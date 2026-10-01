import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { capturePathRemovalGuard, removePathWithinRoot } from "../infra/fs-safe-remove.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { planWithPackageActions, sameCommittedAgent, statusAtLeast } from "./add-plan-helpers.js";
import { ClawBootstrapWriteError, seedClawPackageBootstrap } from "./bootstrap.js";
import {
  ClawCronInstallError,
  installClawCronJobs,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";
import {
  ClawMcpInstallError,
  installClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import { ClawPackageInstallError, installClawPackages } from "./packages.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
  type ClawInstallStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (
  transform: (config: OpenClawConfig) => OpenClawConfig,
  beforePersistentApply?: () => void,
) => Promise<void>;
type ClawAddApplyOptions = OpenClawStateDatabaseOptions & {
  beforePersistentApply?: () => void;
  reloadPlugins?: PluginInstallBatchReload;
  consentPlanIntegrity?: string;
  resumeRecord?: PersistedClawInstall;
  resumePlan?: ClawAddPlan;
  commitConfig?: ConfigCommit;
  persistRecord?: typeof persistClawInstallRecord;
  deleteRecord?: typeof deleteClawInstallRecord;
  updateRecord?: typeof updateClawInstallRecordStatus;
  createWorkspaceFiles?: typeof createClawWorkspaceFiles;
  runtime?: RuntimeEnv;
  installPackages?: typeof installClawPackages;
  installMcpServers?: typeof installClawMcpServers;
  installCronJobs?: typeof installClawCronJobs;
  seedPackageBootstrap?: typeof seedClawPackageBootstrap;
  cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
  nowMs?: number;
};
export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  mcpServers: PersistedClawMcpServerRef[];
  cronJobs: PersistedClawCronRef[];
  installRecord?: PersistedClawInstall;
  error?: {
    code: string;
    message: string;
    diagnostics?: ClawWorkspaceWriteError["diagnostics"];
  };
};

function workspacePathKey(value: string): string {
  return process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
}

function assertWorkspacePathUnchanged(workspace: string): void {
  const canonicalWorkspace = resolvePathViaExistingAncestorSync(workspace);
  if (workspacePathKey(canonicalWorkspace) !== workspacePathKey(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: expected ${JSON.stringify(workspace)}, resolved ${JSON.stringify(canonicalWorkspace)}.`,
    );
  }
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (options.consentPlanIntegrity !== (options.resumePlan?.planIntegrity ?? plan.planIntegrity)) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    options.beforePersistentApply?.();
    // Retain the admitted database as well as the row; recovery cannot reopen another owner.
    options = { ...options, database: openOpenClawStateDatabase(options) };
    options.beforePersistentApply?.();
    installRecord = persistRecord(plan, {
      ...options,
      status: "pending",
      expectedExistingRecord: options.resumeRecord,
      expectedExistingPlan: options.resumePlan,
      deferLegacyPlanUpgrade: options.resumePlan !== undefined,
    });
  } catch (error) {
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  // Recovery has no forward authority. Its exact-record check runs inside the owner's transaction.
  const recoveryOptions = { ...options, beforePersistentApply: undefined };
  let recoveryFailure: string | undefined;
  const markInstallStatus = (
    agentId: string,
    status: ClawInstallStatus,
    expectedStatuses: ClawInstallStatus[],
    mutationOptions: ClawAddApplyOptions,
  ): void => {
    const nowMs = mutationOptions.nowMs ?? Date.now();
    try {
      mutationOptions.beforePersistentApply?.();
      (mutationOptions.updateRecord ?? updateClawInstallRecordStatus)(agentId, status, {
        ...mutationOptions,
        expectedStatuses,
        expectedRecord: installRecord,
        nowMs,
      });
      installRecord = { ...installRecord, status, updatedAtMs: nowMs };
    } catch (error) {
      if (mutationOptions !== recoveryOptions) {
        throw error;
      }
      recoveryFailure ??= coerceErrorMessage(error);
    }
  };
  const clearUnownedInstallRecord = (
    agentId: string,
    expectedStatuses: ClawInstallStatus[],
    mutationOptions: ClawAddApplyOptions,
  ): boolean => {
    try {
      (mutationOptions.deleteRecord ?? deleteClawInstallRecord)(agentId, {
        ...mutationOptions,
        expectedStatuses,
        expectedRecord: installRecord,
      });
      return true;
    } catch (error) {
      if (mutationOptions !== recoveryOptions) {
        throw error;
      }
      recoveryFailure ??= coerceErrorMessage(error);
      return false;
    }
  };

  let workspaceCreated = false;
  let configCommitted = false;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  let packages: PersistedClawPackageRef[] = [];
  let mcpServers: PersistedClawMcpServerRef[] = [];
  let cronJobs: PersistedClawCronRef[] = [];
  const partialResult = ({
    installStatus = "partial",
    nowMs,
    error,
    ...overrides
  }: Partial<
    Pick<
      ClawAddResult,
      | "workspaceCreated"
      | "configCommitted"
      | "workspaceFiles"
      | "packages"
      | "mcpServers"
      | "cronJobs"
    >
  > & {
    installStatus?: ClawInstallStatus;
    nowMs?: number;
    error: ClawAddResult["error"];
  }): ClawAddResult => ({
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status: "partial",
    claw: plan.claw,
    agent: plan.agent,
    workspaceCreated,
    configCommitted,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    installRecord: recoveryFailure
      ? installRecord
      : {
          ...installRecord,
          status: installStatus,
          updatedAtMs: nowMs ?? Date.now(),
        },
    error: recoveryFailure
      ? {
          ...error,
          code: error?.code ?? "provenance_failed",
          message: `${error?.message ?? "Claw add failed"}; recovery could not settle: ${recoveryFailure}`,
        }
      : error,
    ...overrides,
  });

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  let assertCreatedWorkspace: (() => void) | undefined;
  const removeCreatedWorkspace = async (): Promise<boolean> => {
    const assertOwned = assertCreatedWorkspace;
    // mkdir supplies no creation receipt. Browser-owned attempts retain their workspace on failure.
    if (options.beforePersistentApply || !assertOwned) {
      return false;
    }
    try {
      await removePathWithinRoot({
        rootDir: dirname(workspace),
        relativePath: basename(workspace),
        recursive: false,
        force: false,
        assertBeforeMutation: () => {
          assertWorkspacePathUnchanged(workspace);
          assertOwned();
        },
      });
      return true;
    } catch {
      return false;
    }
  };
  const workspacePhaseRecorded = statusAtLeast(installRecord.status, "workspace_ready");
  let workspaceState: Stats | undefined;
  try {
    assertWorkspacePathUnchanged(workspace);
    workspaceState = await lstat(workspace).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
  } catch (error) {
    if (!clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], recoveryOptions)) {
      return partialResult({
        error: { code: "workspace_parent_failed", message: coerceErrorMessage(error) },
      });
    }
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not inspect workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }
  try {
    options.beforePersistentApply?.();
  } catch (error) {
    return partialResult({
      workspaceCreated: workspaceState?.isDirectory() ?? false,
      configCommitted: statusAtLeast(installRecord.status, "config_committed"),
      installStatus: installRecord.status,
      error: { code: "authority_lost", message: coerceErrorMessage(error) },
      nowMs: options.nowMs,
    });
  }

  if (!workspacePhaseRecorded && workspaceState) {
    markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], recoveryOptions);
    return partialResult({
      workspaceCreated: false,
      configCommitted: false,
      packages: [],
      error: {
        code: "workspace_collision",
        message: `Workspace ${JSON.stringify(workspace)} was created after planning.`,
      },
      nowMs: options.nowMs,
    });
  }
  if (workspaceState && !workspaceState.isDirectory()) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Workspace ${JSON.stringify(workspace)} is no longer a directory.`,
    );
  }

  workspaceCreated = workspaceState?.isDirectory() ?? false;
  configCommitted = statusAtLeast(installRecord.status, "config_committed");
  const installPackages = options.installPackages ?? installClawPackages;
  const preserveRecordedPhaseOrMarkPartial = (): ClawInstallStatus => {
    if (workspacePhaseRecorded) {
      return installRecord.status;
    }
    markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], recoveryOptions);
    return "partial";
  };

  const hostRequirementPlan = planWithPackageActions(
    plan,
    (action) => action.details?.kind === "plugin",
  );
  const hostRequirementActions = hostRequirementPlan.actions.filter(
    (action) => action.kind === "package",
  );
  if (hostRequirementActions.length > 0) {
    try {
      options.beforePersistentApply?.();
      packages = await installPackages(hostRequirementPlan, options);
      options.beforePersistentApply?.();
    } catch (error) {
      const packageError = error instanceof ClawPackageInstallError ? error : undefined;
      const installStatus = preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        packages: packageError?.installedPackages ?? packages,
        installStatus,
        error: {
          code: packageError?.code ?? "package_install_failed",
          message: packageError?.message ?? coerceErrorMessage(error),
        },
        nowMs: options.nowMs,
      });
    }
  }

  try {
    assertWorkspacePathUnchanged(workspace);
    options.beforePersistentApply?.();
    await mkdir(dirname(workspace), { recursive: true });
    assertWorkspacePathUnchanged(workspace);
    options.beforePersistentApply?.();
  } catch (error) {
    if (workspacePhaseRecorded || packages.length > 0) {
      const installStatus = preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        installStatus,
        error: {
          code: error instanceof ClawAddMutationError ? error.code : "workspace_parent_failed",
          message:
            error instanceof ClawAddMutationError
              ? error.message
              : `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
        nowMs: options.nowMs,
      });
    }
    if (!clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], recoveryOptions)) {
      return partialResult({
        error: { code: "workspace_parent_failed", message: coerceErrorMessage(error) },
      });
    }
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspaceCreated) {
    try {
      options.beforePersistentApply?.();
      await mkdir(workspace);
      workspaceCreated = true;
    } catch (error) {
      markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], recoveryOptions);
      return partialResult({
        workspaceCreated: false,
        configCommitted: false,
        error: {
          code: "workspace_collision",
          message: `Could not create new workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
        nowMs: options.nowMs,
      });
    }

    try {
      if (!options.beforePersistentApply) {
        assertCreatedWorkspace = capturePathRemovalGuard(workspace);
      }
      if (!workspacePhaseRecorded) {
        markInstallStatus(
          plan.agent.finalId,
          "workspace_ready",
          ["pending", "partial", "workspace_ready"],
          options,
        );
      }
    } catch (error) {
      const removedWorkspace = await removeCreatedWorkspace();
      if (packages.length > 0 || !removedWorkspace) {
        workspaceCreated = !removedWorkspace;
        const installStatus = removedWorkspace ? "partial" : "workspace_ready";
        markInstallStatus(
          plan.agent.finalId,
          installStatus,
          ["pending", "partial", "workspace_ready"],
          recoveryOptions,
        );
        return partialResult({
          installStatus,
          error: { code: "provenance_failed", message: coerceErrorMessage(error) },
          nowMs: options.nowMs,
        });
      }
      if (removedWorkspace) {
        if (
          !clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], recoveryOptions)
        ) {
          return partialResult({
            workspaceCreated: false,
            error: { code: "provenance_failed", message: coerceErrorMessage(error) },
          });
        }
      }
      throw new ClawAddMutationError("provenance_failed", (error as Error).message);
    }
  }

  // Seed and attest the consented package bootstrap while the workspace is still
  // private. Committing the agent config first makes the agent routable, so a
  // concurrent `sessions.create` can stock-seed BOOTSTRAP.md and strand the add at
  // `config_committed` with a seed conflict that no retry can clear.
  try {
    options.beforePersistentApply?.();
    await (options.seedPackageBootstrap ?? seedClawPackageBootstrap)(plan, {
      ...options,
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
    options.beforePersistentApply?.();
  } catch (error) {
    const installStatus: ClawInstallStatus = configCommitted
      ? "config_committed"
      : "workspace_ready";
    markInstallStatus(
      plan.agent.finalId,
      installStatus,
      configCommitted ? ["config_committed"] : ["workspace_ready", "config_committed"],
      recoveryOptions,
    );
    return partialResult({
      installStatus,
      error: {
        code: error instanceof ClawBootstrapWriteError ? error.code : "bootstrap_write_failed",
        message: coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform, beforePersistentApply) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          writeOptions: { assertCurrent: beforePersistentApply },
          transform: (config) => ({ nextConfig: transform(config) }),
        });
      });
    options.beforePersistentApply?.();
    await commit((config) => {
      options.beforePersistentApply?.();
      const existingAgents = listAgentEntries(config);
      const agentsToPreserve: AgentConfig[] =
        existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID, default: true }];
      const configWithPreservedAgents: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: toAgentEntriesRecord(agentsToPreserve),
        },
      };
      const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
      const existingAgent = agentsToPreserve.find(
        (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
      );
      if (existingAgent) {
        if (sameCommittedAgent(existingAgent, plan)) {
          return config;
        }
        const nextConfig = replaceLegacyCommittedAgent({
          config: configWithPreservedAgents,
          agents: agentsToPreserve,
          normalizedAgentId,
          plan,
          resumePlan: options.resumePlan,
          resumeRecord: options.resumeRecord,
          matchesPlan: sameCommittedAgent,
        });
        if (nextConfig) {
          return nextConfig;
        }
        throw new ClawAddMutationError(
          "agent_id_collision",
          "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
        );
      }
      if (
        findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
          .length > 0
      ) {
        throw new ClawAddMutationError(
          "workspace_collision",
          "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
        );
      }
      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: toAgentEntriesRecord([...agentsToPreserve, plan.agent.config]),
        },
      };
      return nextConfig;
    }, options.beforePersistentApply);
    // The transform runs before persistence can still fail; record the fact only after commit.
    // Moving this into the callback retains the workspace and reports a write that never landed.
    configCommitted = true;
    try {
      options.beforePersistentApply?.();
      recordAgentProvenance(plan.agent.finalId, { createdVia: "claw" }, options);
    } catch (error) {
      throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
    }
    if (options.resumePlan && installRecord.schemaVersion === "openclaw.clawInstallRecord.v1") {
      options.beforePersistentApply?.();
      installRecord = persistRecord(plan, {
        ...options,
        status: "pending",
        expectedExistingRecord: options.resumeRecord,
        expectedExistingPlan: options.resumePlan,
      });
    }
    markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["workspace_ready", "config_committed"],
      options,
    );
  } catch (error) {
    const configMayBeCommitted =
      error instanceof ConfigWritePostCommitError && error.rollbackStatus !== "restored";
    if (
      configMayBeCommitted &&
      error.rollbackStatus === "not-restored" &&
      error.publication === "complete"
    ) {
      configCommitted = true;
    }
    // Legacy promotion retries require the exact durable record captured before config commit.
    const unpromotedLegacy =
      options.resumePlan !== undefined &&
      installRecord.schemaVersion === "openclaw.clawInstallRecord.v1";
    let installStatus: ClawInstallStatus = unpromotedLegacy
      ? installRecord.status
      : configCommitted
        ? "config_committed"
        : "workspace_ready";
    if (configCommitted && !unpromotedLegacy) {
      markInstallStatus(
        plan.agent.finalId,
        "config_committed",
        ["workspace_ready", "config_committed"],
        recoveryOptions,
      );
    }
    if (!configCommitted && !configMayBeCommitted) {
      const removedWorkspace = await removeCreatedWorkspace();
      if (removedWorkspace) {
        workspaceCreated = false;
        installStatus = "partial";
        markInstallStatus(
          plan.agent.finalId,
          "partial",
          ["workspace_ready", "partial"],
          recoveryOptions,
        );
      }
    }
    return partialResult({
      installStatus,
      error: {
        code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
        message: coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
  try {
    options.beforePersistentApply?.();
    workspaceFiles = await createFiles(plan, options);
    options.beforePersistentApply?.();
  } catch (error) {
    const workspaceError =
      error instanceof ClawWorkspaceWriteError
        ? error
        : new ClawWorkspaceWriteError(
            [
              {
                level: "error",
                code: "workspace_file_io_error",
                phase: "mutation",
                path: "$.workspace",
                message: coerceErrorMessage(error),
              },
            ],
            workspaceFiles,
          );
    markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["config_committed"],
      recoveryOptions,
    );
    return partialResult({
      workspaceFiles: workspaceError.createdFiles,
      installStatus: "config_committed",
      nowMs: options.nowMs,
      error: {
        code: "workspace_files_failed",
        message: workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
    });
  }

  try {
    // Skills require their workspace. Recurring work is enabled only after all
    // package mutation succeeds.
    const workspacePackagePlan = planWithPackageActions(
      plan,
      (action) => action.details?.kind !== "plugin",
    );
    const workspacePackageActions = workspacePackagePlan.actions.filter(
      (action) => action.kind === "package",
    );
    if (workspacePackageActions.length > 0) {
      options.beforePersistentApply?.();
      const workspacePackages = await installPackages(workspacePackagePlan, options);
      packages = [...packages, ...workspacePackages];
      options.beforePersistentApply?.();
    }
  } catch (error) {
    const packageError = error instanceof ClawPackageInstallError ? error : undefined;
    return partialResult({
      packages: [...packages, ...(packageError?.installedPackages ?? [])],
      installStatus: "config_committed",
      error: {
        code: packageError?.code ?? "package_install_failed",
        message: packageError?.message ?? coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  const installMcpServers = options.installMcpServers ?? installClawMcpServers;
  try {
    options.beforePersistentApply?.();
    mcpServers = await installMcpServers(plan, options);
    options.beforePersistentApply?.();
  } catch (error) {
    const mcpError = error instanceof ClawMcpInstallError ? error : undefined;
    markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["config_committed"],
      recoveryOptions,
    );
    return partialResult({
      mcpServers: mcpError?.mcpServers ?? mcpServers,
      installStatus: "config_committed",
      error: {
        code: mcpError?.code ?? "mcp_install_failed",
        message: mcpError?.message ?? coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  const installCronJobs = options.installCronJobs ?? installClawCronJobs;
  try {
    options.beforePersistentApply?.();
    cronJobs = await installCronJobs(plan, { ...options, gateway: options.cronGateway });
    options.beforePersistentApply?.();
  } catch (error) {
    const cronError = error instanceof ClawCronInstallError ? error : undefined;
    markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["config_committed"],
      recoveryOptions,
    );
    return partialResult({
      cronJobs: cronError?.cronJobs ?? cronJobs,
      installStatus: "config_committed",
      error: {
        code: cronError?.code ?? "cron_install_failed",
        message: cronError?.message ?? coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  try {
    markInstallStatus(plan.agent.finalId, "complete", ["config_committed", "complete"], options);
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated,
      configCommitted,
      packages,
      mcpServers,
      cronJobs,
      workspaceFiles,
      installRecord: {
        ...installRecord,
        status: "complete",
        updatedAtMs: options.nowMs ?? Date.now(),
      },
    };
  } catch (error) {
    return partialResult({
      installStatus: "config_committed",
      error: { code: "provenance_failed", message: (error as Error).message },
    });
  }
}
