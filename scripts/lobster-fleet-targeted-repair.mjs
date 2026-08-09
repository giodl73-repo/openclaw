import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.ops.fleet-targeted-repair.v1";
const CASE_IDS = ["repair-only-failed-restored-cell", "widened-repair-is-refused-before-mutation"];
const REQUIRED_CELLS = ["alpha", "beta", "gamma"];
const FIXTURE_KEYS = new Set(["cases", "fixtureId", "owner", "schemaVersion"]);
const OWNER_KEYS = new Set([
  "failureRecovery",
  "id",
  "leaseScope",
  "projectionAuthority",
  "unitOwner",
]);
const INPUT_KEYS = new Set(["authority", "parent", "projectionMutationAttempted", "repair"]);
const PARENT_KEYS = new Set(["cells", "id", "outcomes", "targetSetDigest"]);
const CELL_KEYS = new Set(["cell", "childOperationId", "nextAttemptId", "priorAttemptId"]);
const OUTCOME_KEYS = new Set([
  "activeAttemptId",
  "cell",
  "mutationCount",
  "result",
  "settlementRevision",
]);
const REPAIR_KEYS = new Set([
  "eligibleCells",
  "eligibilityDigest",
  "id",
  "requestedCells",
  "results",
  "sourceParentId",
]);
const REPAIR_RESULT_KEYS = new Set([
  "activeAttemptId",
  "cell",
  "childOperationId",
  "mutationCount",
  "result",
]);
const EXPECTED_KEYS = new Set(["after", "before", "failure", "status"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
const CELL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SENSITIVE_KEYS = new Set([
  "auth",
  "authorization",
  "credential",
  "databasePath",
  "password",
  "path",
  "payload",
  "secret",
  "token",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function containsSensitiveField(value) {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveField);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, entry]) => SENSITIVE_KEYS.has(key) || containsSensitiveField(entry),
  );
}

function stable(value) {
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function sortedStrings(value) {
  return Array.isArray(value)
    ? value.map(String).toSorted((left, right) => left.localeCompare(right))
    : [];
}

function validOwner(owner) {
  return (
    hasOnlyKeys(owner, OWNER_KEYS) &&
    owner.id === "openclaw-typescript-fleet" &&
    owner.unitOwner === "tenant-cell" &&
    owner.leaseScope === "fleet-cell-operation" &&
    owner.failureRecovery === "previous-attempt-restoration" &&
    owner.projectionAuthority === "none"
  );
}

function validCell(cell) {
  return (
    hasOnlyKeys(cell, CELL_KEYS) &&
    typeof cell.cell === "string" &&
    CELL_PATTERN.test(cell.cell) &&
    HASH_PATTERN.test(cell.childOperationId) &&
    ATTEMPT_PATTERN.test(cell.priorAttemptId) &&
    ATTEMPT_PATTERN.test(cell.nextAttemptId) &&
    cell.priorAttemptId !== cell.nextAttemptId
  );
}

function validOutcome(outcome) {
  return (
    hasOnlyKeys(outcome, OUTCOME_KEYS) &&
    typeof outcome.cell === "string" &&
    (outcome.result === "upgraded" || outcome.result === "failed-previous-restored") &&
    ATTEMPT_PATTERN.test(outcome.activeAttemptId) &&
    Number.isSafeInteger(outcome.settlementRevision) &&
    outcome.settlementRevision > 0 &&
    outcome.mutationCount === 1
  );
}

function normalizedCells(value) {
  return Array.isArray(value)
    ? value
        .filter(validCell)
        .map((cell) => ({
          cell: cell.cell,
          childOperationId: cell.childOperationId,
          priorAttemptId: cell.priorAttemptId,
          nextAttemptId: cell.nextAttemptId,
        }))
        .toSorted((left, right) => left.cell.localeCompare(right.cell))
    : [];
}

function normalizedOutcomes(value) {
  return Array.isArray(value)
    ? value
        .filter(validOutcome)
        .map((outcome) => ({
          cell: outcome.cell,
          result: outcome.result,
          activeAttemptId: outcome.activeAttemptId,
          settlementRevision: outcome.settlementRevision,
        }))
        .toSorted((left, right) => left.cell.localeCompare(right.cell))
    : [];
}

function validRepairResult(result) {
  return (
    hasOnlyKeys(result, REPAIR_RESULT_KEYS) &&
    typeof result.cell === "string" &&
    CELL_PATTERN.test(result.cell) &&
    HASH_PATTERN.test(result.childOperationId) &&
    result.result === "upgraded" &&
    ATTEMPT_PATTERN.test(result.activeAttemptId) &&
    result.mutationCount === 1
  );
}

export function validateFleetTargetedRepair(input, owner) {
  const failures = [];
  if (containsSensitiveField(input)) {
    failures.push({ code: "SensitiveFieldPresent" });
  }
  if (!hasOnlyKeys(input, INPUT_KEYS)) {
    failures.push({ code: "InputInvalid" });
  }
  if (!validOwner(owner)) {
    failures.push({ code: "OwnerContractMismatch" });
  }
  if (input?.projectionMutationAttempted !== false) {
    failures.push({ code: "ProjectionBoundaryViolated" });
  }
  if (input?.authority !== "none") {
    failures.push({ code: "AuthorityOverclaimed" });
  }

  const parent = input?.parent;
  if (
    !hasOnlyKeys(parent, PARENT_KEYS) ||
    !HASH_PATTERN.test(parent?.id) ||
    !HASH_PATTERN.test(parent?.targetSetDigest)
  ) {
    failures.push({ code: "ParentInvalid" });
  }
  const cells = normalizedCells(parent?.cells);
  const cellIds = cells.map((cell) => cell.cell);
  if (
    !Array.isArray(parent?.cells) ||
    parent.cells.length !== cells.length ||
    stable(cellIds) !== stable(REQUIRED_CELLS) ||
    new Set(cellIds).size !== cellIds.length
  ) {
    failures.push({ code: "TargetCellInventoryMismatch" });
  }
  if (
    HASH_PATTERN.test(parent?.id) &&
    parent?.targetSetDigest !== digest({ parentId: parent.id, cells })
  ) {
    failures.push({ code: "TargetSetReceiptMismatch" });
  }

  const outcomes = normalizedOutcomes(parent?.outcomes);
  const outcomeIds = outcomes.map((outcome) => outcome.cell);
  if (
    !Array.isArray(parent?.outcomes) ||
    parent.outcomes.length !== outcomes.length ||
    stable(outcomeIds) !== stable(REQUIRED_CELLS) ||
    new Set(outcomeIds).size !== outcomeIds.length
  ) {
    failures.push({ code: "ChildSettlementInventoryMismatch" });
  }
  for (const outcome of outcomes) {
    const cell = cells.find((candidate) => candidate.cell === outcome.cell);
    const expectedAttemptId =
      outcome.result === "upgraded" ? cell?.nextAttemptId : cell?.priorAttemptId;
    if (!cell || outcome.activeAttemptId !== expectedAttemptId) {
      failures.push({ code: "ChildSettlementInvalid", cell: outcome.cell });
    }
  }

  const before =
    outcomes.length === REQUIRED_CELLS.length &&
    outcomes.every((outcome) => outcome.result === "upgraded")
      ? "converged"
      : "partial";
  const eligibleCells = outcomes
    .filter((outcome) => outcome.result === "failed-previous-restored")
    .map((outcome) => outcome.cell)
    .toSorted((left, right) => left.localeCompare(right));

  const repair = input?.repair;
  if (
    !hasOnlyKeys(repair, REPAIR_KEYS) ||
    !HASH_PATTERN.test(repair?.id) ||
    !HASH_PATTERN.test(repair?.sourceParentId) ||
    !HASH_PATTERN.test(repair?.eligibilityDigest)
  ) {
    failures.push({ code: "RepairInvalid" });
  }
  if (repair?.sourceParentId !== parent?.id) {
    failures.push({ code: "RepairSourceParentMismatch" });
  }
  const declaredEligible = sortedStrings(repair?.eligibleCells);
  if (
    stable(declaredEligible) !== stable(eligibleCells) ||
    new Set(declaredEligible).size !== declaredEligible.length
  ) {
    failures.push({ code: "RepairEligibilityMismatch" });
  }
  const expectedEligibilityDigest = digest({
    sourceParentId: parent?.id,
    eligibleCells,
    outcomes,
  });
  if (repair?.eligibilityDigest !== expectedEligibilityDigest) {
    failures.push({ code: "RepairEligibilityReceiptMismatch" });
  }

  const requestedCells = sortedStrings(repair?.requestedCells);
  if (
    !Array.isArray(repair?.requestedCells) ||
    requestedCells.length === 0 ||
    new Set(requestedCells).size !== requestedCells.length
  ) {
    failures.push({ code: "RepairTargetInvalid" });
  }
  for (const cell of requestedCells) {
    if (!eligibleCells.includes(cell)) {
      failures.push({ code: "RepairTargetNotEligible", cell });
    }
  }

  const hasIneligibleTarget = failures.some(
    (failure) => failure.code === "RepairTargetNotEligible",
  );
  const repairResults = Array.isArray(repair?.results) ? repair.results : [];
  if (hasIneligibleTarget) {
    if (repairResults.length > 0) {
      failures.push({ code: "RepairMutationBeforeAdmission" });
    }
  } else {
    const validResults = repairResults.filter(validRepairResult);
    const resultCells = validResults
      .map((result) => result.cell)
      .toSorted((left, right) => left.localeCompare(right));
    if (
      repairResults.length !== validResults.length ||
      stable(resultCells) !== stable(requestedCells) ||
      new Set(resultCells).size !== resultCells.length
    ) {
      failures.push({ code: "RepairSettlementMismatch" });
    }
  }

  const repairedCells = new Set(
    repairResults.filter(validRepairResult).map((result) => result.cell),
  );
  const after =
    failures.length === 0 &&
    outcomes.every((outcome) => outcome.result === "upgraded" || repairedCells.has(outcome.cell))
      ? "converged"
      : "blocked";
  const mutationCounts = Object.fromEntries(
    REQUIRED_CELLS.map((cell) => [
      cell,
      (outcomes.some((outcome) => outcome.cell === cell) ? 1 : 0) +
        repairResults.filter(validRepairResult).filter((result) => result.cell === cell).length,
    ]),
  );
  const failure =
    failures.find((entry) => entry.code === "RepairTargetNotEligible") ?? failures[0] ?? null;

  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    authority: "none",
    owner: "openclaw-typescript-fleet",
    before,
    after,
    eligibleCells,
    mutationCounts,
    projectionMutationAttempted: input?.projectionMutationAttempted === true,
    productionCoordinatorProven: false,
    containmentProven: false,
    failure,
    failures,
  };
}

export function runFixture(path = resolve(ROOT, ".lobster/fleet-targeted-repair-fixture.json")) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (
    !hasOnlyKeys(fixture, FIXTURE_KEYS) ||
    fixture.schemaVersion !== 1 ||
    fixture.fixtureId !== FIXTURE_ID ||
    !validOwner(fixture.owner) ||
    !Array.isArray(fixture.cases) ||
    stable(sortedStrings(fixture.cases.map((entry) => entry?.id))) !== stable(CASE_IDS)
  ) {
    throw new Error("fleet targeted repair fixture envelope is invalid");
  }

  const cases = fixture.cases.map((entry) => {
    if (
      !hasOnlyKeys(entry, new Set(["expected", "id", "input"])) ||
      !hasOnlyKeys(entry.expected, EXPECTED_KEYS)
    ) {
      throw new Error("fleet targeted repair fixture case is invalid");
    }
    const result = validateFleetTargetedRepair(entry.input, fixture.owner);
    const actual = {
      status: result.status,
      before: result.before,
      after: result.after,
      failure: result.failure,
    };
    if (stable(actual) !== stable(entry.expected)) {
      throw new Error(`Fixture case ${entry.id} did not match its expected result`);
    }
    return { id: entry.id, result };
  });

  return {
    schemaVersion: 1,
    fixtureId: FIXTURE_ID,
    owner: fixture.owner.id,
    cases,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runFixture(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
