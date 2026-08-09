import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateMixedOwnerRestoreComposition,
} from "../../scripts/lobster-mixed-owner-restore-composition.mjs";

const SCRIPT = resolve("scripts/lobster-mixed-owner-restore-composition.mjs");
const FIXTURE = resolve(".lobster/mixed-owner-restore-composition-fixture.json");

type SnapshotFact = {
  owner: string;
  snapshotId: string;
  schemaVersion: number;
  verified: boolean;
  targetFresh: boolean;
  digest: string;
  sizeBytes: number;
};

type RestoreInput = {
  requiredOwners: string[];
  snapshots: SnapshotFact[];
  publicationAttempted: boolean;
  authority: string;
  databasePath?: string;
};

type RestoreOwner = {
  id: string;
  supportedSchemas: {
    global: number;
    agent: number;
  };
  restoreMode: string;
  publicationAtomicity: string;
};

function fixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function input(caseIndex = 0): RestoreInput {
  return structuredClone(fixture().cases[caseIndex].input);
}

function owner(): RestoreOwner {
  return structuredClone(fixture().owner);
}

function snapshot(value: RestoreInput, index: number): SnapshotFact {
  const entry = value.snapshots[index];
  if (!entry) {
    throw new Error(`fixture snapshot ${index} is missing`);
  }
  return entry;
}

describe("lobster.kcc.mixed-owner-restore-composition.v1", () => {
  it("accepts one exact verified current-schema owner set as ready", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      owner: "openclaw-typescript-sqlite-snapshot",
      readiness: "ready-for-owner-native-restore",
      authority: "none",
      publicationAttempted: false,
      crossOwnerAtomicPublicationProven: false,
      failures: [],
    });
  });

  it("blocks the entire set on an incompatible agent schema", () => {
    expect(runFixture().cases[1]!.result).toMatchObject({
      status: "rejected",
      readiness: "blocked",
      publicationAttempted: false,
      failure: {
        code: "OwnerSchemaIncompatible",
        owner: "agent:ops-team",
        actualSchemaVersion: 17,
        supportedSchemaVersion: 16,
      },
    });
  });

  it("requires exact global and agent owner inventory", () => {
    const missing = input();
    missing.requiredOwners = ["global"];
    const extra = input();
    extra.requiredOwners = ["global", "agent:ops-team", "agent:other"];

    expect(validateMixedOwnerRestoreComposition(missing, owner()).failures).toContainEqual({
      code: "RequiredOwnerInventoryMismatch",
    });
    expect(validateMixedOwnerRestoreComposition(extra, owner()).failures).toContainEqual({
      code: "RequiredOwnerInventoryMismatch",
    });
  });

  it("rejects duplicate or mismatched snapshot owners", () => {
    const duplicate = input();
    snapshot(duplicate, 1).owner = "global";

    expect(validateMixedOwnerRestoreComposition(duplicate, owner()).failures).toContainEqual({
      code: "SnapshotOwnerInventoryMismatch",
    });
  });

  it("requires immutable snapshot identities and digests", () => {
    const candidate = input();
    snapshot(candidate, 0).snapshotId = "mutable";
    snapshot(candidate, 1).digest = "invalid";

    expect(validateMixedOwnerRestoreComposition(candidate, owner()).failures).toContainEqual({
      code: "SnapshotFactsInvalid",
    });
  });

  it("requires verified snapshots and fresh targets", () => {
    const candidate = input();
    snapshot(candidate, 0).verified = false;
    snapshot(candidate, 1).targetFresh = false;

    expect(validateMixedOwnerRestoreComposition(candidate, owner()).failures).toEqual(
      expect.arrayContaining([
        { code: "SnapshotUnverified", owner: "global" },
        { code: "RestoreTargetNotFresh", owner: "agent:ops-team" },
      ]),
    );
  });

  it("refuses publication attempts and authority overclaim", () => {
    const candidate = input();
    candidate.publicationAttempted = true;
    candidate.authority = "restore-coordinator";

    expect(validateMixedOwnerRestoreComposition(candidate, owner()).failures).toEqual(
      expect.arrayContaining([
        { code: "PreflightBoundaryViolated" },
        { code: "AuthorityOverclaimed" },
      ]),
    );
  });

  it("pins owner-specific schema oracles and per-owner atomicity", () => {
    const changedOwner = owner();
    changedOwner.supportedSchemas.agent = 17;
    changedOwner.publicationAtomicity = "cross-owner";

    expect(validateMixedOwnerRestoreComposition(input(), changedOwner).failures).toContainEqual({
      code: "OwnerContractMismatch",
    });
  });

  it.each([null, [], "invalid"])("fails closed on non-object input %#", (candidate) => {
    expect(validateMixedOwnerRestoreComposition(candidate, owner())).toMatchObject({
      status: "rejected",
      readiness: "blocked",
      publicationAttempted: false,
    });
  });

  it("rejects sensitive and unknown fields", () => {
    const candidate = input();
    candidate.databasePath = "C:\\private\\state.sqlite";

    expect(validateMixedOwnerRestoreComposition(candidate, owner()).failures).toEqual(
      expect.arrayContaining([{ code: "SensitiveFieldPresent" }, { code: "InputInvalid" }]),
    );
  });

  it("requires the exact fixture case inventory", () => {
    const value = fixture();
    value.cases.pop();
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-mixed-owner-restore-"));
    const tempPath = join(tempDir, "fixture.json");
    try {
      writeFileSync(tempPath, JSON.stringify(value), "utf8");
      expect(() => runFixture(tempPath)).toThrow(
        "mixed-owner restore composition fixture envelope is invalid",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails the CLI without success-shaped output for an invalid fixture", () => {
    const result = spawnSync(process.execPath, [SCRIPT, ".lobster/fixtures.json"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mixed-owner restore composition fixture envelope is invalid");
  });

  it("emits deterministic fixture output", () => {
    const first = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });

    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });
});
