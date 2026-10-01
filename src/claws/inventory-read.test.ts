import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { buildClawUpdateScheduledJobs } from "./control-ui-scheduled-jobs.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, upsertClawCronRef } from "./cron.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import { persistClawInstallRecordAsync, withClawMutationGuard } from "./state-write.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

describe("Claw worker inventory", () => {
  it.each([CLAW_CRON_REF_SCHEMA_VERSION, "openclaw.clawCronRef.v2"])(
    "preserves stored cron provenance version %s through worker disclosure",
    async (schemaVersion) => {
      const root = tempDirs.make("claw-inventory-cron-version-");
      const env = stateEnv(root);
      const job = {
        id: "daily",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated" as const,
        message: "Synthetic scheduled message",
      };
      upsertClawCronRef(
        {
          schemaVersion,
          agentId: "worker",
          manifestId: job.id,
          declarationKey: "claw:worker:daily",
          status: "complete",
          job,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        { env },
      );
      const inventory = await readClawInventory({ env });
      expect(inventory.cronJobs[0]?.schemaVersion).toBe(schemaVersion);
      const disclosure = buildClawUpdateScheduledJobs({
        plan: {
          agentId: "worker",
          actions: [
            {
              kind: "cronJob",
              id: job.id,
              action: "unchanged",
              target: "claw:worker:daily",
              reason: "Declaration unchanged",
              blocked: false,
              currentDigest: digestClawValue(job),
              desiredDigest: digestClawValue(job),
            },
          ],
        },
        proposed: [job],
        recorded: inventory.cronJobs,
      });
      expect(disclosure.jobs[0]?.recorded?.state).toBe(
        schemaVersion === CLAW_CRON_REF_SCHEMA_VERSION ? "declared" : "unresolved",
      );
    },
  );

  it("reads existing provenance through the canonical read worker", async () => {
    const root = tempDirs.make("claw-inventory-worker-");
    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    const env = stateEnv(root);
    const record = await persistClawInstallRecordAsync(plan, { env, nowMs: 123 });
    const inventory = await readClawInventory({ env });
    expect(inventory).toEqual({
      installs: [record],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    });
  });

  it.each(["transaction", "commit"] as const)(
    "preserves canonical inventory when Claw worker authority retires at %s",
    async (stage) => {
      const root = tempDirs.make("claw-worker-authority-");
      const env = stateEnv(root);
      const { plan: existingPlan } = await makeProvenancePlan(root, {
        schemaVersion: 1,
        agent: { id: "existing" },
      });
      await persistClawInstallRecordAsync(existingPlan, { env, nowMs: 123 });
      const before = await readClawInventory({ env });
      const { plan } = await makeProvenancePlan(
        root,
        { schemaVersion: 1, agent: { id: "rejected" } },
        { workspace: join(root, "workspace-rejected") },
      );
      expect(plan.blockers).toEqual([]);
      const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const stages: string[] = [];
      let retired = false;
      vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          originalAdmission((request, grant) => {
            stages.push(request.stage);
            retired ||= request.stage === stage;
            admit(request, grant);
          }, attachment),
      );
      const error = new Error("Claw mutation owner retired");

      await expect(
        withClawMutationGuard(
          () => {
            if (retired) {
              throw error;
            }
          },
          () => persistClawInstallRecordAsync(plan, { env, nowMs: 456 }),
        ),
      ).rejects.toBe(error);
      expect(stages).toEqual(stage === "transaction" ? ["transaction"] : ["transaction", "commit"]);
      expect(await readClawInventory({ env })).toEqual(before);
    },
  );

  it("does not create state during empty inventory reads", async () => {
    const root = tempDirs.make("claw-empty-inventory-");
    expect(await readClawInventory({ env: stateEnv(root) })).toEqual({
      installs: [],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    });
  });
});
