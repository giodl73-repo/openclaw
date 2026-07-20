import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContinuityArchiveObligations } from "./archive-obligations.js";
import {
  canonicalContinuityJson,
  completeContinuityRestore,
  openRestoredAdmission,
  projectContinuityRestoreStatus,
  type ContinuityRestoreCompleteDependencies,
  type ContinuityRestoreCompleteEvidence,
  type ContinuityRestoreCompleteOutcome,
  type ContinuityRestoreCompleteSuccess,
  type RequiredOwnerReadinessRequirement,
} from "./restore-complete.js";

const prefixedSha = (character: string): string => `sha256:${character.repeat(64)}`;
const rawSha = (character: string): string => character.repeat(64);

const obligations: ContinuityArchiveObligations = {
  schemaVersion: 1,
  reconstructed: {
    authProfileRuntimeState: {
      owner: "auth-profiles",
      treatment: "safe-empty-default",
      removedRowCount: 0,
      readiness: "non-blocking",
    },
    pluginRuntimeDependencies: {
      owner: "plugins",
      treatment: "owner-reinstall",
      omittedTreeCount: 2,
      readiness: "owner-required",
    },
  },
  external: {
    configSecretReferences: {
      owner: "secrets",
      referenceCounts: { env: 1, file: 0, exec: 0 },
      readiness: "owner-required",
    },
    authProfileCredentials: {
      owner: "auth-profiles",
      removedRowCount: 1,
      credentialRows: 0,
      oauthCaptured: false,
      readiness: "owner-required",
    },
  },
  ephemeral: {
    runtimeTransients: {
      owner: "runtime",
      treatment: "normal-startup",
      readiness: "owner-owned",
    },
  },
};

function restoredEvidence(): ContinuityRestoreCompleteEvidence {
  return {
    startupMode: "restored",
    operationId: "restore-complete-1",
    ownerId: prefixedSha("a"),
    destinationRuntimeGeneration: "runtime-generation-19",
    lifecycleOwnerGeneration: "continuity-lifecycle-1",
    acceptedRecoveryPoint: {
      recoveryPointId: "recovery-point-17",
      publicationIdentity: "publication-17",
      manifestSha256: rawSha("b"),
    },
    preparationIdentity: "preparation-17",
    admissionIdentity: "admission/runtime-generation-19",
    expectedPlanId: rawSha("c"),
    continuityObligations: obligations,
    restore: {
      version: "continuity-restore-execution-result/v1",
      ok: true,
      ownerGeneration: "continuity-lifecycle-1",
      restoreIdentity: "restore-17",
      planId: rawSha("c"),
      receiptIdentity: prefixedSha("d"),
      committedRecordIdentity: prefixedSha("e"),
    },
  };
}

function readyFindings(requirements: readonly RequiredOwnerReadinessRequirement[]) {
  const identities = [prefixedSha("1"), prefixedSha("2"), prefixedSha("3")];
  return requirements.map((requirement, index) => ({
    ...requirement,
    ready: true,
    evidenceIdentity: identities[index],
  }));
}

function dependencies(
  overrides: Partial<ContinuityRestoreCompleteDependencies> = {},
): ContinuityRestoreCompleteDependencies {
  return {
    reconcileScheduler: async () => undefined,
    resolveWakeDescriptor: () => ({
      version: "continuity-wake-descriptor/v1",
      schedulerGeneration: prefixedSha("4"),
      nextRequiredAt: "2026-07-17T03:00:00.000Z",
      reasonClass: "cron",
    }),
    resolveOwnerReadiness: async (requirements) => readyFindings(requirements),
    resolveGatewayReadiness: async () => ({
      ready: true,
      generation: prefixedSha("5"),
      failing: [],
    }),
    ...overrides,
  };
}

function requireCompletion(
  outcome: ContinuityRestoreCompleteOutcome,
): asserts outcome is ContinuityRestoreCompleteSuccess {
  if (!outcome.ok || "skipped" in outcome) {
    throw new Error(`Expected completion, received ${JSON.stringify(outcome)}`);
  }
}

async function makeJournalRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-complete-"));
  return path.join(root, "journal");
}

async function recordPath(journalRoot: string): Promise<string> {
  const entries = await fs.readdir(journalRoot);
  expect(entries).toHaveLength(1);
  return path.join(journalRoot, entries[0], "restore-complete.json");
}

describe("completeContinuityRestore", () => {
  it("authors durable readiness and reports ready only after exact admission", async () => {
    const journalRoot = await makeJournalRoot();
    const events: string[] = [];
    const result = await completeContinuityRestore(restoredEvidence(), journalRoot, {
      ...dependencies(),
      reconcileScheduler: async () => {
        events.push("reconciled");
      },
      resolveWakeDescriptor: () => {
        events.push("wake");
        return dependencies().resolveWakeDescriptor();
      },
      resolveOwnerReadiness: async (requirements) => {
        events.push("owners");
        return readyFindings(requirements);
      },
      resolveGatewayReadiness: async () => {
        events.push("gateway");
        return { ready: true, generation: prefixedSha("5"), failing: [] };
      },
    });

    requireCompletion(result);
    expect(events).toEqual(["reconciled", "wake", "owners", "gateway"]);
    expect(result.phase).toBe("reconciling");
    expect(result.admissionOpen).toBe(false);
    expect(result.record.admissionIdentity).toBe("admission/runtime-generation-19");
    expect(projectContinuityRestoreStatus(result)).toMatchObject({
      phase: "reconciling",
      admissionOpen: false,
    });
    expect(JSON.stringify(result)).not.toContain(journalRoot);

    const storedPath = await recordPath(journalRoot);
    const metadata = await fs.lstat(storedPath);
    if (process.platform !== "win32") {
      expect(metadata.mode & 0o077).toBe(0);
    }
    expect(
      (await fs.readdir(path.dirname(storedPath))).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
    const stored = JSON.parse(await fs.readFile(storedPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stored).toSorted()).toEqual(
      [
        "version",
        "ownerId",
        "destinationRuntimeGeneration",
        "lifecycleOwnerGeneration",
        "recoveryPointId",
        "manifestSha256",
        "preparationIdentity",
        "restoreIdentity",
        "restoreReceiptIdentity",
        "committedRecordIdentity",
        "planId",
        "schedulerGeneration",
        "nextRequiredAt",
        "reasonClass",
        "requiredOwnerReadinessDigest",
        "admissionIdentity",
        "readinessGeneration",
      ].toSorted(),
    );
    const { readinessGeneration, ...hashInput } = stored;
    expect(readinessGeneration).toBe(
      `sha256:${createHash("sha256").update(canonicalContinuityJson(hashInput)).digest("hex")}`,
    );

    const admission = openRestoredAdmission(result.record, {
      ownerId: result.record.ownerId,
      destinationRuntimeGeneration: result.record.destinationRuntimeGeneration,
      lifecycleOwnerGeneration: result.record.lifecycleOwnerGeneration,
      restoreReceiptIdentity: result.record.restoreReceiptIdentity,
      admissionIdentity: result.record.admissionIdentity,
      readinessGeneration: result.record.readinessGeneration,
    });
    expect(projectContinuityRestoreStatus(admission)).toEqual({
      phase: "ready",
      readinessGeneration: result.readinessGeneration,
      admissionOpen: true,
    });
  });

  it("canonicalizes recursively while preserving array order", () => {
    expect(canonicalContinuityJson({ z: 1, a: { d: 2, b: [3, { y: 4, x: 5 }] } })).toBe(
      '{"a":{"b":[3,{"x":5,"y":4}],"d":2},"z":1}',
    );
  });

  it("rejects missing required owner readiness", async () => {
    const result = await completeContinuityRestore(restoredEvidence(), await makeJournalRoot(), {
      ...dependencies(),
      resolveOwnerReadiness: async (requirements) => readyFindings(requirements).slice(0, 2),
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "blocked",
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
  });

  it("rejects duplicate required owner readiness", async () => {
    const result = await completeContinuityRestore(restoredEvidence(), await makeJournalRoot(), {
      ...dependencies(),
      resolveOwnerReadiness: async (requirements) => {
        const findings = readyFindings(requirements);
        return [...findings, findings[0]];
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
  });

  it("rejects contradictory Gateway readiness", async () => {
    const result = await completeContinuityRestore(restoredEvidence(), await makeJournalRoot(), {
      ...dependencies(),
      resolveGatewayReadiness: async () => ({
        ready: true,
        generation: prefixedSha("5"),
        failing: ["gateway.transport"],
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
  });

  it("keeps lifecycle ownership independent from destination generation", async () => {
    const evidence = restoredEvidence();
    const reconcileScheduler = vi.fn(async () => undefined);
    const result = await completeContinuityRestore(evidence, await makeJournalRoot(), {
      ...dependencies(),
      reconcileScheduler,
    });
    requireCompletion(result);
    expect(result.record.destinationRuntimeGeneration).toBe("runtime-generation-19");
    expect(result.record.lifecycleOwnerGeneration).toBe("continuity-lifecycle-1");
    expect(reconcileScheduler).toHaveBeenCalledOnce();
  });

  it("rejects a restore from a different lifecycle owner generation", async () => {
    const evidence = restoredEvidence();
    evidence.restore.ownerGeneration = "continuity-lifecycle-0";
    const reconcileScheduler = vi.fn(async () => undefined);
    const result = await completeContinuityRestore(evidence, await makeJournalRoot(), {
      ...dependencies(),
      reconcileScheduler,
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "restoring",
      code: "ContinuityRestoreFailed",
      disposition: "quarantine",
    });
    expect(reconcileScheduler).not.toHaveBeenCalled();
  });

  it("rejects a committed restore for a different plan", async () => {
    const evidence = restoredEvidence();
    evidence.restore.planId = rawSha("f");
    const reconcileScheduler = vi.fn(async () => undefined);
    const result = await completeContinuityRestore(evidence, await makeJournalRoot(), {
      ...dependencies(),
      reconcileScheduler,
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "restoring",
      code: "ContinuityRestoreFailed",
      disposition: "quarantine",
    });
    expect(reconcileScheduler).not.toHaveBeenCalled();
  });

  it("rejects non-string static identities before reconciliation", async () => {
    const evidence = restoredEvidence();
    evidence.operationId = 17 as unknown as string;
    const reconcileScheduler = vi.fn(async () => undefined);
    const result = await completeContinuityRestore(evidence, await makeJournalRoot(), {
      ...dependencies(),
      reconcileScheduler,
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "restoring",
      code: "ContinuityRestoreFailed",
      disposition: "quarantine",
    });
    expect(reconcileScheduler).not.toHaveBeenCalled();
  });

  it("rejects non-digest restore receipt authority before reconciliation", async () => {
    const evidence = restoredEvidence();
    evidence.restore.receiptIdentity = "receipt-17";
    const reconcileScheduler = vi.fn(async () => undefined);
    const result = await completeContinuityRestore(evidence, await makeJournalRoot(), {
      ...dependencies(),
      reconcileScheduler,
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "restoring",
      code: "ContinuityRestoreFailed",
      disposition: "quarantine",
    });
    expect(reconcileScheduler).not.toHaveBeenCalled();
  });

  it("replays the durable record without rerunning dynamic readiness", async () => {
    const journalRoot = await makeJournalRoot();
    const syncJournalDirectory = vi.fn(async () => undefined);
    const first = await completeContinuityRestore(restoredEvidence(), journalRoot, {
      ...dependencies(),
      syncJournalDirectory,
    });
    requireCompletion(first);

    const failIfCalled = async (): Promise<never> => {
      throw new Error("dynamic readiness must not rerun");
    };
    const second = await completeContinuityRestore(restoredEvidence(), journalRoot, {
      reconcileScheduler: failIfCalled,
      resolveWakeDescriptor: failIfCalled,
      resolveOwnerReadiness: failIfCalled,
      resolveGatewayReadiness: failIfCalled,
      syncJournalDirectory,
    });
    requireCompletion(second);
    expect(second.replayed).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(syncJournalDirectory).toHaveBeenCalledTimes(2);
  });

  it("replays the valid concurrent winner when dynamic snapshots differ", async () => {
    const journalRoot = await makeJournalRoot();
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothReconciled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcileScheduler = async () => {
      arrivals += 1;
      if (arrivals === 2) {
        release?.();
      }
      await bothReconciled;
    };
    const firstDependencies = {
      ...dependencies(),
      reconcileScheduler,
      resolveWakeDescriptor: () => ({
        version: "continuity-wake-descriptor/v1" as const,
        schedulerGeneration: prefixedSha("6"),
        nextRequiredAt: "2026-07-17T03:00:00.000Z",
        reasonClass: "cron" as const,
      }),
    };
    const secondDependencies = {
      ...dependencies(),
      reconcileScheduler,
      resolveWakeDescriptor: () => ({
        version: "continuity-wake-descriptor/v1" as const,
        schedulerGeneration: prefixedSha("7"),
        nextRequiredAt: "2026-07-17T04:00:00.000Z",
        reasonClass: "cron" as const,
      }),
    };

    const [first, second] = await Promise.all([
      completeContinuityRestore(restoredEvidence(), journalRoot, firstDependencies),
      completeContinuityRestore(restoredEvidence(), journalRoot, secondDependencies),
    ]);
    requireCompletion(first);
    requireCompletion(second);
    expect(first.record).toEqual(second.record);
    expect([first.replayed, second.replayed].toSorted()).toEqual([false, true]);
  });

  it("quarantines replay with a different restore identity", async () => {
    const journalRoot = await makeJournalRoot();
    const first = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    requireCompletion(first);
    const replayEvidence = restoredEvidence();
    replayEvidence.restore.restoreIdentity = "restore-18";
    const replay = await completeContinuityRestore(replayEvidence, journalRoot, dependencies());
    expect(replay).toMatchObject({
      ok: false,
      code: "ReadinessGenerationConflict",
      disposition: "quarantine",
    });
  });

  it("quarantines replay with a different lifecycle owner generation", async () => {
    const journalRoot = await makeJournalRoot();
    const first = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    requireCompletion(first);
    const replayEvidence = restoredEvidence();
    replayEvidence.lifecycleOwnerGeneration = "continuity-lifecycle-2";
    replayEvidence.restore.ownerGeneration = "continuity-lifecycle-2";
    const replay = await completeContinuityRestore(replayEvidence, journalRoot, dependencies());
    expect(replay).toMatchObject({
      ok: false,
      code: "ReadinessGenerationConflict",
      disposition: "quarantine",
    });
  });

  it("quarantines non-canonical durable bytes", async () => {
    const journalRoot = await makeJournalRoot();
    const first = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    requireCompletion(first);
    const storedPath = await recordPath(journalRoot);
    const raw = await fs.readFile(storedPath, "utf8");
    await fs.writeFile(storedPath, ` ${raw}`, { mode: 0o600 });
    await fs.chmod(storedPath, 0o600);

    const replay = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    expect(replay).toMatchObject({
      ok: false,
      code: "ReadinessGenerationConflict",
      disposition: "quarantine",
    });
  });

  it("maps scheduler reconciliation failures to retryable evidence", async () => {
    const result = await completeContinuityRestore(restoredEvidence(), await makeJournalRoot(), {
      ...dependencies(),
      reconcileScheduler: async () => {
        throw new Error("cron unavailable");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "reconciling",
      code: "SchedulerReconciliationFailed",
      disposition: "retry-same-incarnation",
    });
  });

  it("rejects malformed wake descriptor evidence", async () => {
    const result = await completeContinuityRestore(restoredEvidence(), await makeJournalRoot(), {
      ...dependencies(),
      resolveWakeDescriptor: () => ({
        version: "continuity-wake-descriptor/v1",
        schedulerGeneration: prefixedSha("4"),
        nextRequiredAt: null,
        reasonClass: "maintenance" as "cron",
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "reconciling",
      code: "SchedulerReconciliationFailed",
      disposition: "retry-same-incarnation",
    });
  });

  it("quarantines a conflicting durable record", async () => {
    const journalRoot = await makeJournalRoot();
    const first = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    requireCompletion(first);
    const storedPath = await recordPath(journalRoot);
    const stored = JSON.parse(await fs.readFile(storedPath, "utf8")) as Record<string, unknown>;
    stored.manifestSha256 = rawSha("f");
    await fs.writeFile(storedPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await fs.chmod(storedPath, 0o600);

    const replay = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    expect(replay).toMatchObject({
      ok: false,
      code: "ReadinessGenerationConflict",
      disposition: "quarantine",
    });
  });

  it("refuses admission for a modified attestation", async () => {
    const result = await completeContinuityRestore(
      restoredEvidence(),
      await makeJournalRoot(),
      dependencies(),
    );
    requireCompletion(result);
    const modified = {
      ...result.record,
      schedulerGeneration: prefixedSha("9"),
    };
    expect(() =>
      openRestoredAdmission(modified, {
        ownerId: modified.ownerId,
        destinationRuntimeGeneration: modified.destinationRuntimeGeneration,
        lifecycleOwnerGeneration: modified.lifecycleOwnerGeneration,
        restoreReceiptIdentity: modified.restoreReceiptIdentity,
        admissionIdentity: modified.admissionIdentity,
        readinessGeneration: modified.readinessGeneration,
      }),
    ).toThrow("Restored admission record is invalid.");
  });

  it("holds when an existing journal directory is not private", async () => {
    if (process.platform === "win32") {
      return;
    }
    const journalRoot = await makeJournalRoot();
    await fs.mkdir(journalRoot, { mode: 0o755 });
    await fs.chmod(journalRoot, 0o755);
    const result = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    expect(result).toMatchObject({
      ok: false,
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
  });

  it("holds when the journal root is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-link-"));
    const target = path.join(parent, "target");
    const journalRoot = path.join(parent, "journal");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, journalRoot, "dir");
    const result = await completeContinuityRestore(restoredEvidence(), journalRoot, dependencies());
    expect(result).toMatchObject({
      ok: false,
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
  });

  it("maps readiness-provider errors to a stable hold", async () => {
    const result = await completeContinuityRestore(restoredEvidence(), await makeJournalRoot(), {
      ...dependencies(),
      resolveOwnerReadiness: async () => {
        throw new Error("plugin owner unavailable");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      phase: "blocked",
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
  });

  it("removes the temporary record when writing fails", async () => {
    const journalRoot = await makeJournalRoot();
    await completeContinuityRestore(restoredEvidence(), journalRoot, {
      ...dependencies(),
      resolveOwnerReadiness: async () => [],
    });
    const [operationDirectory] = await fs.readdir(journalRoot);
    const close = vi.fn(async () => undefined);
    const open = vi.spyOn(fs, "open").mockResolvedValueOnce({
      writeFile: async () => {
        throw new Error("disk full");
      },
      sync: async () => undefined,
      close,
    } as never);
    try {
      const result = await completeContinuityRestore(restoredEvidence(), journalRoot, {
        ...dependencies(),
        syncJournalDirectory: async () => undefined,
      });
      expect(result).toMatchObject({
        ok: false,
        code: "ContinuityReadinessFailed",
        disposition: "hold",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(await fs.readdir(path.join(journalRoot, operationDirectory))).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  it("leaves ordinary startup untouched", async () => {
    const evidence = restoredEvidence();
    evidence.startupMode = "ordinary";
    const reconcileScheduler = vi.fn(async () => undefined);
    const journalRoot = await makeJournalRoot();
    const result = await completeContinuityRestore(evidence, journalRoot, {
      ...dependencies(),
      reconcileScheduler,
    });
    expect(result).toEqual({
      version: "continuity-restore-complete-result/v1",
      ok: true,
      skipped: true,
      reason: "ordinary-startup",
    });
    expect(reconcileScheduler).not.toHaveBeenCalled();
    await expect(fs.access(journalRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines an unknown startup mode without creating a journal", async () => {
    const evidence = restoredEvidence();
    evidence.startupMode = "migrated" as "restored";
    const journalRoot = await makeJournalRoot();
    const result = await completeContinuityRestore(evidence, journalRoot, dependencies());
    expect(result).toMatchObject({
      ok: false,
      phase: "restoring",
      code: "ContinuityRestoreFailed",
      disposition: "quarantine",
    });
    await expect(fs.access(journalRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
