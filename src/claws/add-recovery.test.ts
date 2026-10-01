import { access, mkdir, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyClawAddPlan } from "./add.js";
import { ClawCronInstallError, type PersistedClawCronRef } from "./cron.js";
import { ClawMcpInstallError, type PersistedClawMcpServerRef } from "./mcp.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import { assertClawMutationCurrent, withClawMutationGuard } from "./state-write.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  ClawWorkspaceWriteError,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

describe("Claw add partial-outcome recovery", () => {
  it("preserves an inspection error when pending-record cleanup fails", async () => {
    const root = tempDirs.make("claw-add-inspection-recovery-");
    const env = stateEnv(root);
    const parent = join(root, "canonical");
    const alternate = join(root, "alternate");
    await mkdir(parent);
    await mkdir(alternate);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(parent, "workspace") },
    );
    await rmdir(parent);
    await symlink(alternate, parent, process.platform === "win32" ? "junction" : "dir");
    const deleteRecord = vi.fn(() => {
      throw new Error("Synthetic cleanup refusal");
    });
    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      deleteRecord,
    });
    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      installRecord: { status: "pending" },
      error: {
        code: "workspace_path_changed",
        message: expect.stringContaining("Workspace ancestry changed"),
      },
    });
    expect(result.error?.message).not.toContain("cleanup refusal");
    await expect(access(join(alternate, "workspace"))).rejects.toThrow();
    expect(deleteRecord).toHaveBeenCalledOnce();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
  });

  it("retains pending provenance when authority denies parent creation and cleanup", async () => {
    const root = tempDirs.make("claw-add-parent-recovery-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    let retired = false;
    const result = await withClawMutationGuard(
      () => {
        if (retired) {
          throw new Error("Synthetic authority retired");
        }
      },
      () =>
        applyClawAddPlan(plan, {
          env,
          consentPlanIntegrity: plan.planIntegrity,
          persistRecord: (...args) => {
            const record = persistClawInstallRecord(...args);
            retired = true;
            return record;
          },
        }),
    );
    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      installRecord: { status: "pending" },
      error: {
        code: "workspace_parent_failed",
        message: expect.stringContaining("Could not create parent"),
      },
    });
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("retains confirmed config on a resumed workspace creation failure", async () => {
    const root = tempDirs.make("claw-add-resume-recovery-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(
      root,
      {
        schemaVersion: 1,
        agent: { id: "worker" },
        packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/audit", version: "1.0.0" }],
      },
      {
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
      },
    );
    persistClawInstallRecord(plan, { env, status: "config_committed" });
    const commitConfig = vi.fn();
    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig,
      installPackages: async () => {
        await writeFile(plan.agent.workspace, "Synthetic workspace race");
        return [];
      },
    });
    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: true,
      installRecord: { status: "config_committed" },
      error: { code: "workspace_collision" },
    });
    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("config_committed");
  });

  it.each([
    "bootstrap",
    "config",
    "config-committed",
    "workspace",
    "mcp",
    "cron",
    "complete",
  ] as const)("retains observed outcomes when authority retires during %s", async (phase) => {
    const root = tempDirs.make("claw-add-recovery-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const file: PersistedClawWorkspaceFile = {
      schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
      agentId: "worker",
      workspace: plan.agent.workspace,
      path: "notes.txt",
      sourcePath: "notes.txt",
      contentDigest: "sha256:synthetic",
      status: "pending",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const mcp: PersistedClawMcpServerRef = {
      schemaVersion: "openclaw.clawMcpServerRef.v1",
      agentId: "worker",
      name: "synthetic",
      configDigest: "sha256:synthetic",
      relationship: "managed",
      origin: "claw-introduced",
      independentOwner: false,
      status: "pending",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const cron: PersistedClawCronRef = {
      schemaVersion: "openclaw.clawCronRef.v1",
      agentId: "worker",
      manifestId: "daily",
      declarationKey: "claw:worker:daily",
      status: "pending",
      job: {
        id: "daily",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated",
        message: "Synthetic scheduled work",
      },
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const primaryError =
      phase === "workspace"
        ? new ClawWorkspaceWriteError([], [file])
        : phase === "mcp"
          ? new ClawMcpInstallError("mcp_install_uncertain", "Synthetic MCP failure", [mcp])
          : phase === "cron"
            ? new ClawCronInstallError("cron_install_failed", "Synthetic cron failure", [cron])
            : new Error("Synthetic phase failure");
    const visited: string[] = [];
    let retired = false;
    let config: OpenClawConfig = {};
    const enter = (stage: string) => {
      assertClawMutationCurrent();
      visited.push(stage);
      if (phase === stage) {
        retired = true;
        throw primaryError;
      }
    };
    const result = await withClawMutationGuard(
      () => {
        if (retired) {
          throw new Error("Synthetic authority retired");
        }
      },
      () =>
        applyClawAddPlan(plan, {
          env,
          consentPlanIntegrity: plan.planIntegrity,
          seedPackageBootstrap: async () => enter("bootstrap"),
          commitConfig: async (transform) => {
            const next = transform(config);
            enter("config");
            config = next;
            retired = phase === "config-committed";
          },
          createWorkspaceFiles: async () => {
            enter("workspace");
            return [];
          },
          installMcpServers: async () => {
            enter("mcp");
            return [];
          },
          installCronJobs: async () => {
            enter("cron");
            retired = phase === "complete";
            return [];
          },
        }),
    );

    const configCommitted = phase !== "bootstrap" && phase !== "config";
    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted,
      installRecord: {
        status:
          configCommitted && phase !== "config-committed" ? "config_committed" : "workspace_ready",
      },
      error: {
        message:
          phase === "complete" || phase === "config-committed"
            ? "Synthetic authority retired"
            : primaryError.message,
      },
    });
    expect(result.workspaceFiles).toEqual(phase === "workspace" ? [file] : []);
    expect(result.mcpServers).toEqual(phase === "mcp" ? [mcp] : []);
    expect(result.cronJobs).toEqual(phase === "cron" ? [cron] : []);
    expect(Boolean(config.agents?.entries?.worker)).toBe(configCommitted);
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      status: result.installRecord!.status,
      updatedAtMs: result.installRecord!.updatedAtMs,
    });
    const stages = ["bootstrap", "config", "workspace", "mcp", "cron"];
    expect(visited).toEqual(
      phase === "complete"
        ? stages
        : stages.slice(0, stages.indexOf(phase === "config-committed" ? "config" : phase) + 1),
    );
  });

  it("reports a created workspace when authority denies both phase recording and cleanup", async () => {
    const root = tempDirs.make("claw-add-phase-recovery-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    let retired = false;
    const seedPackageBootstrap = vi.fn();
    const result = await withClawMutationGuard(
      () => {
        if (retired) {
          throw new Error("Synthetic authority retired");
        }
      },
      () =>
        applyClawAddPlan(plan, {
          env,
          consentPlanIntegrity: plan.planIntegrity,
          seedPackageBootstrap,
          updateRecord: () => {
            retired = true;
            throw new Error("Synthetic phase write refused");
          },
        }),
    );
    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: false,
      installRecord: { status: "pending" },
      error: { code: "provenance_failed", message: "Synthetic phase write refused" },
    });
    expect(seedPackageBootstrap).not.toHaveBeenCalled();
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
  });
});
