import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readClawInventory } from "./inventory-read.js";
import { readAttachedCronJobs, readClawRemoveCronInventory } from "./lifecycle-delete-support.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { buildClawRemovePlan } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";
import { digestClawMcpServer, upsertClawMcpServerRef } from "./mcp.js";
import { persistClawPackageRef } from "./provenance.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "claw-remove-preview-" });
  await state.writeConfig({});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
  await state.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { addFixture } = createClawRemoveTestFixtures(tempDirs, () => state);

async function databaseArtifacts(databasePath: string) {
  const directory = dirname(databasePath);
  const artifacts: Record<string, string> = {};
  const names = (await readdir(directory))
    .filter(
      (name) => name === basename(databasePath) || name.startsWith(`${basename(databasePath)}-`),
    )
    .toSorted();
  for (const name of names) {
    artifacts[name] = createHash("sha256")
      .update(await readFile(join(directory, name)))
      .digest("hex");
  }
  return artifacts;
}

function refuseWritableOpen() {
  return vi.spyOn(stateDatabase, "openOpenClawStateDatabase").mockImplementation(() => {
    throw new Error("Preview must not open a writable database.");
  });
}

describe("read-only Claw removal preview", () => {
  it("does not create a missing database or its parent directory", async () => {
    const root = tempDirs.make("claw-preview-missing-");
    const options = { path: join(root, "missing", "state.sqlite"), readOnly: true, config: {} };
    const open = refuseWritableOpen();

    const plan = await withArtifactPreservingStateReads(async () => {
      expect(readAttachedCronJobs("worker", { path: options.path })).toEqual([]);
      return await buildClawRemovePlan("worker", options);
    });

    expect(plan.blockers).toEqual([expect.objectContaining({ code: "claw_not_found" })]);
    expect(await readdir(root)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("preserves cold database artifacts and pending refs with supplied or loaded inventory", async () => {
    const current = await addFixture({ withFile: true, withBootstrap: true, withCron: true });
    const config = current.getConfig();
    const server = { command: "docs-mcp", args: [] };
    const ref = {
      schemaVersion: "openclaw.clawMcpServerRef.v1" as const,
      agentId: "worker",
      name: "docs",
      configDigest: digestClawMcpServer(server),
      relationship: "managed" as const,
      origin: "claw-introduced" as const,
      independentOwner: false,
      status: "pending" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    upsertClawMcpServerRef(ref, { env: current.env });
    upsertClawMcpServerRef({ ...ref, agentId: "keeper", status: "complete" }, { env: current.env });
    upsertClawMcpServerRef(
      { ...ref, agentId: "unrelated", name: "other", status: "complete" },
      { env: current.env },
    );
    persistClawPackageRef(
      current.plan,
      {
        kind: "skill",
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
      },
      { env: current.env },
    );
    await closeStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    const before = await databaseArtifacts(databasePath);
    const open = refuseWritableOpen();
    const legacyReader = vi.fn(() => {
      throw new Error("Preview must use its supplied inventory.");
    });

    await withArtifactPreservingStateReads(async () => {
      const inventory = await readClawInventory({ env: current.env });
      for (const supplied of [inventory, undefined]) {
        const plan = await buildClawRemovePlan("worker", {
          env: current.env,
          config,
          readOnly: true,
          inventory: supplied,
          sourceMcpServers: { docs: server },
          packageDeps: { readPackageRefs: legacyReader, readInstallRecords: legacyReader },
        });
        expect(plan.actions).toContainEqual(
          expect.objectContaining({ kind: "workspaceFile", id: "SOUL.md", action: "delete" }),
        );
        expect(plan.actions).toContainEqual(
          expect.objectContaining({ kind: "cronJob", id: "daily-report", action: "remove" }),
        );
        expect(plan.actions).toContainEqual(
          expect.objectContaining({ kind: "packageRef", action: "release" }),
        );
        expect(plan.actions).toContainEqual(
          expect.objectContaining({
            kind: "mcpServer",
            id: "docs",
            action: "retain",
            blocked: true,
            details: expect.objectContaining({
              expectedState: "pending",
              affectedClawAgentIds: ["keeper"],
            }),
          }),
        );
      }
      expect(await readClawInventory({ env: current.env })).toEqual(inventory);
    });

    expect(await databaseArtifacts(databasePath)).toEqual(before);
    expect(open).not.toHaveBeenCalled();
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("rereads attached jobs after awaited monitor inspection", async () => {
    const options = { env: state.env };
    const database = stateDatabase.openOpenClawStateDatabase(options);
    const job: CronStoredJob = {
      id: "monitor",
      name: "Before inspection",
      agentId: "worker",
      owner: { agentId: "worker" },
      declarationKey: "heartbeat:worker",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Monitor" },
      state: {},
    };
    upsertCronJobRow(database.db, "default", job, 0);
    const inspect = vi.fn(async () => {
      await Promise.resolve();
      upsertCronJobRow(database.db, "default", { ...job, name: "After inspection" }, 0);
      return [];
    });
    const open = refuseWritableOpen();

    const result = await withArtifactPreservingStateReads(() =>
      readClawRemoveCronInventory("worker", {
        ...options,
        monitorGateway: { ...quiescentClawMonitorGateway, inspect },
      }),
    );

    expect(inspect).toHaveBeenCalledExactlyOnceWith("worker");
    expect(result.attachedJobs).toMatchObject([{ id: "monitor", name: "After inspection" }]);
    expect(result.inspectionUnavailable).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
