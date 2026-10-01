import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import * as inventoryReader from "./inventory-read.js";
import { planClawPackageRemovals } from "./package-remove.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

describe("Claw package removal inventory", () => {
  it.each([false, true])(
    "does not create missing state while planning (hasPackage=%s)",
    async (hasPackage) => {
      const root = tempDirs.make("claw-remove-empty-state-");
      const env = stateEnv(root);
      const ref: PersistedClawPackageRef = {
        schemaVersion: "openclaw.clawPackageRef.v1",
        agentId: "worker",
        clawName: "@acme/worker",
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/audit",
        version: "1.0.0",
        integrity: "sha256:fixture",
        status: "complete",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
        installedAtMs: 1,
        updatedAtMs: 1,
      };
      const decisions = await planClawPackageRemovals(
        { workspace: join(root, "workspace") },
        hasPackage ? [ref] : [],
        { env },
      );
      expect(decisions).toMatchObject(
        hasPackage ? [{ action: "retain", affectedClawAgentIds: [] }] : [],
      );
      expect(existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
    },
  );

  it("reads shared package and workspace owners in one worker snapshot without opening SQLite on the caller", async () => {
    const root = tempDirs.make("claw-remove-worker-inventory-");
    const env = stateEnv(root);
    const workspace = join(root, "shared-workspace");
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace },
    );
    persistClawInstallRecord(plan, { env, nowMs: 1 });
    const packages = [
      {
        kind: "skill" as const,
        source: "clawhub" as const,
        ref: "@acme/triage",
        version: "1.0.0",
        integrity: "sha256:skill",
      },
      {
        kind: "plugin" as const,
        source: "clawhub" as const,
        ref: "@acme/audit",
        version: "1.0.0",
        integrity: "sha256:plugin",
      },
    ];
    const refs = packages.map((pkg) =>
      persistClawPackageRef(plan, pkg, {
        env,
        nowMs: 1,
        relationship: pkg.kind === "skill" ? "referenced" : "managed",
      }),
    );
    for (const agentId of ["shared", "elsewhere"]) {
      const { plan: peer } = await makeProvenancePlan(
        root,
        { schemaVersion: 1, agent: { id: agentId } },
        { workspace: join(root, `workspace-${agentId}`) },
      );
      persistClawInstallRecord(peer, { env, nowMs: 1 });
      for (const pkg of packages) {
        persistClawPackageRef(peer, pkg, { env, nowMs: 1, status: "pending" });
      }
    }
    await closeStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const before = await readFile(databasePath);
    const reads = vi.spyOn(inventoryReader, "readClawInventory");
    const opens = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation(() => {
      throw new Error("Removal planning opened SQLite on the caller thread");
    });

    const decisions = await planClawPackageRemovals({ workspace }, refs, { env });
    expect(decisions).toMatchObject([
      { action: "retain", affectedClawAgentIds: [] },
      { action: "retain", affectedClawAgentIds: ["elsewhere", "shared"] },
    ]);
    expect(reads).toHaveBeenCalledExactlyOnceWith({ env });
    expect(opens).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    expect(await readFile(databasePath)).toEqual(before);

    // An explicit handle must win over another environment's default path.
    const database = openOpenClawStateDatabase({ env });
    const otherEnv = stateEnv(join(root, "other-installation"));
    const unexpectedRead = vi
      .spyOn(inventoryReader, "readClawInventory")
      .mockRejectedValue(new Error("Explicit database handle ignored"));
    expect(await planClawPackageRemovals({ workspace }, refs, { database, env: otherEnv })).toEqual(
      decisions,
    );
    expect(unexpectedRead).not.toHaveBeenCalled();
    expect(existsSync(otherEnv.OPENCLAW_STATE_DIR)).toBe(false);
  });

  it("propagates unavailable inventory without opening a local fallback", async () => {
    const root = tempDirs.make("claw-remove-unavailable-inventory-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    const ref = persistClawPackageRef(
      plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/audit",
        version: "1.0.0",
        integrity: "sha256:fixture",
      },
      { env, nowMs: 1 },
    );
    await closeStateDatabaseForTest();
    const unavailable = new Error("Worker inventory unavailable");
    vi.spyOn(inventoryReader, "readClawInventory").mockRejectedValue(unavailable);
    const opens = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation(() => {
      throw new Error("Unexpected local fallback");
    });
    await expect(
      planClawPackageRemovals({ workspace: plan.agent.workspace }, [ref], { env }),
    ).rejects.toBe(unavailable);
    expect(opens).not.toHaveBeenCalled();
  });
});
