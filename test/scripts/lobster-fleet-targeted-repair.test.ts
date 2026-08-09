import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateFleetTargetedRepair,
} from "../../scripts/lobster-fleet-targeted-repair.mjs";

const SCRIPT = resolve("scripts/lobster-fleet-targeted-repair.mjs");
const FIXTURE = resolve(".lobster/fleet-targeted-repair-fixture.json");

type CellDefinition = {
  cell: string;
  childOperationId: string;
  priorAttemptId: string;
  nextAttemptId: string;
};

type ChildOutcome = {
  cell: string;
  result: string;
  activeAttemptId: string;
  settlementRevision: number;
  mutationCount: number;
};

type RepairResult = {
  cell: string;
  childOperationId: string;
  result: string;
  activeAttemptId: string;
  mutationCount: number;
};

type FleetRepairInput = {
  parent: {
    id: string;
    targetSetDigest: string;
    cells: CellDefinition[];
    outcomes: ChildOutcome[];
  };
  repair: {
    id: string;
    sourceParentId: string;
    eligibilityDigest: string;
    eligibleCells: string[];
    requestedCells: string[];
    results: RepairResult[];
  };
  projectionMutationAttempted: boolean;
  authority: string;
  token?: string;
};

type FleetOwner = {
  id: string;
  unitOwner: string;
  leaseScope: string;
  failureRecovery: string;
  projectionAuthority: string;
};

function fixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function input(caseIndex = 0): FleetRepairInput {
  return structuredClone(fixture().cases[caseIndex].input);
}

function owner(): FleetOwner {
  return structuredClone(fixture().owner);
}

function cell(value: FleetRepairInput, id: string): CellDefinition {
  const result = value.parent.cells.find((entry) => entry.cell === id);
  if (!result) {
    throw new Error(`fixture cell ${id} is missing`);
  }
  return result;
}

function outcome(value: FleetRepairInput, id: string): ChildOutcome {
  const result = value.parent.outcomes.find((entry) => entry.cell === id);
  if (!result) {
    throw new Error(`fixture outcome ${id} is missing`);
  }
  return result;
}

describe("lobster.ops.fleet-targeted-repair.v1", () => {
  it("repairs only the failed/restored cell and preserves healthy mutation counts", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      before: "partial",
      after: "converged",
      eligibleCells: ["beta"],
      mutationCounts: { alpha: 1, beta: 2, gamma: 1 },
      authority: "none",
      projectionMutationAttempted: false,
      productionCoordinatorProven: false,
      containmentProven: false,
      failures: [],
    });
  });

  it("refuses a widened repair before recording a repair mutation", () => {
    expect(runFixture().cases[1]!.result).toMatchObject({
      status: "rejected",
      before: "partial",
      after: "blocked",
      mutationCounts: { alpha: 1, beta: 1, gamma: 1 },
      failure: { code: "RepairTargetNotEligible", cell: "alpha" },
    });
  });

  it("requires the exact three-cell target inventory", () => {
    const missing = input();
    missing.parent.cells.pop();
    const duplicate = input();
    cell(duplicate, "gamma").cell = "beta";

    expect(validateFleetTargetedRepair(missing, owner()).failures).toContainEqual({
      code: "TargetCellInventoryMismatch",
    });
    expect(validateFleetTargetedRepair(duplicate, owner()).failures).toContainEqual({
      code: "TargetCellInventoryMismatch",
    });
  });

  it("binds the target-set receipt to immutable cell and operation identities", () => {
    const candidate = input();
    cell(candidate, "alpha").childOperationId = "9".repeat(64);

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toContainEqual({
      code: "TargetSetReceiptMismatch",
    });
  });

  it("rejects malformed operation and attempt identities", () => {
    const candidate = input();
    cell(candidate, "beta").childOperationId = "invalid";
    cell(candidate, "gamma").nextAttemptId = "invalid";

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toContainEqual({
      code: "TargetCellInventoryMismatch",
    });
  });

  it("requires one settlement for every target cell", () => {
    const candidate = input();
    candidate.parent.outcomes.pop();

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toContainEqual({
      code: "ChildSettlementInventoryMismatch",
    });
  });

  it("binds upgraded and restored results to the correct active attempt", () => {
    const upgraded = input();
    outcome(upgraded, "alpha").activeAttemptId = cell(upgraded, "alpha").priorAttemptId;
    const restored = input();
    outcome(restored, "beta").activeAttemptId = cell(restored, "beta").nextAttemptId;

    expect(validateFleetTargetedRepair(upgraded, owner()).failures).toContainEqual({
      code: "ChildSettlementInvalid",
      cell: "alpha",
    });
    expect(validateFleetTargetedRepair(restored, owner()).failures).toContainEqual({
      code: "ChildSettlementInvalid",
      cell: "beta",
    });
  });

  it("derives repair eligibility from failed/restored outcomes", () => {
    const candidate = input();
    candidate.repair.eligibleCells = ["alpha", "beta"];

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toContainEqual({
      code: "RepairEligibilityMismatch",
    });
  });

  it("validates the source parent and binds eligibility to settlement revisions", () => {
    const wrongParent = input();
    wrongParent.repair.sourceParentId = "8".repeat(64);
    const changedRevision = input();
    outcome(changedRevision, "beta").settlementRevision = 2;

    expect(validateFleetTargetedRepair(wrongParent, owner()).failures).toContainEqual({
      code: "RepairSourceParentMismatch",
    });
    expect(validateFleetTargetedRepair(changedRevision, owner()).failures).toContainEqual({
      code: "RepairEligibilityReceiptMismatch",
    });
  });

  it("requires a complete repair settlement for the admitted target", () => {
    const candidate = input();
    candidate.repair.results = [];

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toContainEqual({
      code: "RepairSettlementMismatch",
    });
  });

  it("rejects repair evidence when an ineligible target was mutated", () => {
    const candidate = input(1);
    candidate.repair.results = [
      {
        cell: "alpha",
        childOperationId: "8".repeat(64),
        result: "upgraded",
        activeAttemptId: "9".repeat(32),
        mutationCount: 1,
      },
    ];

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toContainEqual({
      code: "RepairMutationBeforeAdmission",
    });
  });

  it("pins the per-cell owner contract without claiming a coordinator", () => {
    const changedOwner = owner();
    changedOwner.leaseScope = "fleet-parent-operation";

    expect(validateFleetTargetedRepair(input(), changedOwner)).toMatchObject({
      status: "rejected",
      productionCoordinatorProven: false,
      failures: expect.arrayContaining([{ code: "OwnerContractMismatch" }]),
    });
  });

  it("refuses projection mutation and authority overclaim", () => {
    const candidate = input();
    candidate.projectionMutationAttempted = true;
    candidate.authority = "fleet-controller";

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toEqual(
      expect.arrayContaining([
        { code: "ProjectionBoundaryViolated" },
        { code: "AuthorityOverclaimed" },
      ]),
    );
  });

  it.each([null, [], "invalid"])("fails closed on non-object input %#", (candidate) => {
    expect(validateFleetTargetedRepair(candidate, owner())).toMatchObject({
      status: "rejected",
      after: "blocked",
      productionCoordinatorProven: false,
      containmentProven: false,
    });
  });

  it("rejects sensitive and unknown fields", () => {
    const candidate = input();
    candidate.token = "not-allowed";

    expect(validateFleetTargetedRepair(candidate, owner()).failures).toEqual(
      expect.arrayContaining([{ code: "SensitiveFieldPresent" }, { code: "InputInvalid" }]),
    );
  });

  it("requires the exact fixture case inventory", () => {
    const value = fixture();
    value.cases.pop();
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-fleet-targeted-repair-"));
    const tempPath = join(tempDir, "fixture.json");
    try {
      writeFileSync(tempPath, JSON.stringify(value), "utf8");
      expect(() => runFixture(tempPath)).toThrow(
        "fleet targeted repair fixture envelope is invalid",
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
    expect(result.stderr).toContain("fleet targeted repair fixture envelope is invalid");
  });

  it("emits deterministic fixture output", () => {
    const first = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });

    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });
});
