import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { buildClawUpdateScheduledJobs } from "./control-ui-scheduled-jobs.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, upsertClawCronRef } from "./cron.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  updateClawInstallRecord,
} from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";

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

  it.each(["created", "adopted"] as const)(
    "reads canonical %s agent ownership and config digest through worker inventory",
    async (agentOrigin) => {
      const root = tempDirs.make("claw-inventory-worker-");
      const { plan } = await makeProvenancePlan(root, {
        schemaVersion: 1,
        agent: { id: "worker" },
      });
      const env = stateEnv(root);
      const record = persistClawInstallRecord(plan, { env, nowMs: 123, agentOrigin });
      expect(record.agentOrigin).toBe(agentOrigin);
      expect(record.schemaVersion).toBe(
        agentOrigin === "adopted"
          ? "openclaw.clawInstallRecord.v3"
          : "openclaw.clawInstallRecord.v2",
      );
      const inventory = await readClawInventory({ env });
      expect(inventory).toEqual({
        installs: [record],
        packages: [],
        workspaceFiles: [],
        mcpServers: [],
        cronJobs: [],
      });
      const agentConfigDigest = digestClawValue({ inheritedSetting: "synthetic" });
      const updated = updateClawInstallRecord(plan, {
        env,
        nowMs: 456,
        agentConfigDigest,
      });
      expect(updated).toMatchObject({
        agentOrigin,
        schemaVersion: record.schemaVersion,
        agentConfigDigest,
      });
      expect((await readClawInventory({ env })).installs).toEqual([updated]);
    },
  );

  it("preserves populated extension provenance through the inventory worker", async () => {
    const root = tempDirs.make("claw-inventory-extension-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    const record = persistClawPackageRef(
      plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@owner/tools",
        version: "1.0.0",
        integrity: "sha256:fixture",
        extension: {
          id: "fixture-tools",
          format: "claude",
          detectedFormat: "claude",
          mapped: ["commands", "skills"],
          unavailable: ["agents"],
          adapterIdentity: "openclaw/v1",
        },
      },
      { env, nowMs: 123, origin: "pre-existing", independentOwner: true },
    );

    expect((await readClawInventory({ env })).packages).toEqual([record]);
  });

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
