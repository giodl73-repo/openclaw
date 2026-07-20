import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContinuityArchiveObligations } from "../continuity/archive-obligations.js";
import type {
  ContinuityRestoreCompleteDependencies,
  ContinuityRestoreCompleteEvidence,
  RequiredOwnerReadinessRequirement,
} from "../continuity/restore-complete.js";
import {
  CONTINUITY_RESTORED_STARTUP_FILE_ENV,
  CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX,
  loadContinuityRestoredStartupDescriptor,
  runContinuityRestoredStartup,
  runContinuityRestoredStartupFromEnvironment,
} from "./continuity-restored-startup.js";

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

async function descriptor() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restored-startup-"));
  return {
    version: "continuity-restored-startup/v2" as const,
    journalRoot: path.join(root, "journal"),
    evidence: restoredEvidence(),
  };
}

describe("continuity restored startup", () => {
  it("opens admission and emits one exact result before the caller's ready marker", async () => {
    const lines: string[] = [];
    const result = await runContinuityRestoredStartup(await descriptor(), dependencies(), (line) =>
      lines.push(line),
    );
    if (!result.ok) {
      throw new Error(`Expected restored startup success, received ${JSON.stringify(result)}`);
    }
    lines.push("[gateway] ready");

    expect(result).toMatchObject({
      ok: true,
      phase: "ready",
      admissionOpen: true,
      replayed: false,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith(CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX)).toBe(true);
    expect(
      JSON.parse(lines[0]?.slice(CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX.length) ?? ""),
    ).toEqual(result);
    expect(lines[1]).toBe("[gateway] ready");
  });

  it("emits a typed hold and leaves the ready marker suppressed", async () => {
    const lines: string[] = [];
    const result = await runContinuityRestoredStartup(
      await descriptor(),
      dependencies({
        resolveOwnerReadiness: async (requirements) =>
          readyFindings(requirements).map((finding, index) => ({
            ...finding,
            ready: index !== 0,
          })),
      }),
      (line) => lines.push(line),
    );

    expect(result).toEqual({
      version: "continuity-restored-startup-result/v2",
      ok: false,
      phase: "blocked",
      code: "ContinuityReadinessFailed",
      disposition: "hold",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX)).toBe(true);
    expect(
      JSON.parse(lines[0]?.slice(CONTINUITY_RESTORED_STARTUP_RESULT_PREFIX.length) ?? ""),
    ).toEqual(result);
  });

  it("leaves ordinary startup unchanged when no private descriptor is present", async () => {
    const lines: string[] = [];
    const result = await runContinuityRestoredStartupFromEnvironment({}, dependencies(), (line) =>
      lines.push(line),
    );

    expect(result).toBeNull();
    expect(lines).toEqual([]);
  });

  it("loads a bounded private descriptor from the dedicated file environment", async () => {
    const value = await descriptor();
    const descriptorPath = path.join(path.dirname(value.journalRoot), "restored-startup.json");
    await fs.writeFile(descriptorPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const loaded = await loadContinuityRestoredStartupDescriptor(descriptorPath);
    const lines: string[] = [];

    const result = await runContinuityRestoredStartupFromEnvironment(
      { [CONTINUITY_RESTORED_STARTUP_FILE_ENV]: descriptorPath },
      dependencies(),
      (line) => lines.push(line),
    );

    expect(loaded).toEqual(value);
    expect(result?.ok).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it("rejects malformed descriptor fields before startup work begins", async () => {
    const value = await descriptor();
    const descriptorPath = path.join(path.dirname(value.journalRoot), "restored-startup.json");
    await fs.writeFile(descriptorPath, JSON.stringify({ ...value, unexpectedAuthority: true }), {
      mode: 0o600,
    });

    await expect(loadContinuityRestoredStartupDescriptor(descriptorPath)).rejects.toThrow(
      "descriptor fields are invalid",
    );
  });
});
