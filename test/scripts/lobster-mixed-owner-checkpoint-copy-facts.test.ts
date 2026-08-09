import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateMixedOwnerCheckpointCopyFacts,
} from "../../scripts/lobster-mixed-owner-checkpoint-copy-facts.mjs";

const SCRIPT = resolve("scripts/lobster-mixed-owner-checkpoint-copy-facts.mjs");
const FIXTURE = resolve(".lobster/mixed-owner-checkpoint-copy-facts-fixture.json");

function acceptedInput() {
  return structuredClone(JSON.parse(readFileSync(FIXTURE, "utf8")).cases[0].input);
}

describe("lobster.kcc.mixed-owner-checkpoint-copy-facts.v1", () => {
  it("refuses dirty state before accepting a clean compatible checkpoint", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        attemptCount: 2,
        dirtyRefusalCount: 1,
        acceptedCheckpointCount: 1,
      },
    });
  });

  it("keeps retained, external, and unknown copies explicitly partial", () => {
    expect(runFixture().cases[0]!.result.reconciliation).toMatchObject({
      expectedCopyOwnerCount: 8,
      reportedCopyOwnerCount: 8,
      counts: {
        complete: 3,
        retained: 3,
        externallyControlled: 1,
        unknown: 1,
      },
      copyStatus: "partial",
      assuranceComplete: false,
    });
  });

  it("rejects admitting a dirty checkpoint owner", () => {
    const input = acceptedInput();
    const dirtyFact = input.checkpointAttempts[0].ownerFacts[1];
    dirtyFact.outcome = "included";
    delete dirtyFact.reason;
    input.checkpointAttempts[0].outcome = "accepted";
    delete input.checkpointAttempts[0].reason;

    expect(validateMixedOwnerCheckpointCopyFacts(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DirtyCheckpointAdmitted",
          attemptId: "checkpoint-dirty",
          ownerId: "openclaw-agent-state:main",
        }),
      ]),
    );
  });

  it("rejects accepting an incompatible checkpoint owner", () => {
    const input = acceptedInput();
    const fact = input.checkpointAttempts[1].ownerFacts[1];
    fact.compatibility = "incompatible";

    expect(validateMixedOwnerCheckpointCopyFacts(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IncompatibleCheckpointAdmitted",
          attemptId: "checkpoint-clean",
          ownerId: "openclaw-agent-state:main",
        }),
      ]),
    );
  });

  it("requires dirty refusal before compatible capture", () => {
    const input = acceptedInput();
    input.checkpointAttempts.reverse();
    input.checkpointAttempts.forEach(
      (attempt: { sequence: number }, index: number) => (attempt.sequence = index + 1),
    );

    expect(validateMixedOwnerCheckpointCopyFacts(input).failures).toContainEqual({
      code: "DirtyRefusalMissing",
    });
  });

  it("requires exactly one settlement for every expected copy owner", () => {
    const input = acceptedInput();
    input.copySettlements.pop();

    expect(validateMixedOwnerCheckpointCopyFacts(input).failures).toContainEqual({
      code: "CopyInventoryMismatch",
    });
  });

  it("binds every copy settlement to the inventoried source generation", () => {
    const input = acceptedInput();
    input.copySettlements[0].sourceRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateMixedOwnerCheckpointCopyFacts(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CopySettlementInvalid",
          ownerId: "session-canonical",
        }),
      ]),
    );
  });

  it("rejects complete assurance while any copy is retained or unknown", () => {
    const input = acceptedInput();
    input.final.copyStatus = "complete";
    input.final.assuranceComplete = true;

    expect(validateMixedOwnerCheckpointCopyFacts(input).failures).toEqual(
      expect.arrayContaining([
        { code: "CopyOutcomeInvalid" },
        { code: "AssuranceOverclaimed" },
        { code: "FinalStateMismatch" },
      ]),
    );
  });

  it("rejects dirty, incomplete, misclassified, and sensitive evidence", () => {
    const result = runFixture().cases[1]!.result;

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "DirtyCheckpointAdmitted",
        "IncompatibleCheckpointAdmitted",
        "CheckpointInventoryMismatch",
        "CopySettlementInvalid",
        "CopyInventoryMismatch",
        "AssuranceOverclaimed",
        "SensitivePayloadPresent",
      ]),
    );
  });

  it("runs the checked-in accepted and rejected evidence cases", () => {
    const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }));

    expect(
      output.cases.map((entry: { result: { status: string } }) => entry.result.status),
    ).toEqual(["accepted", "rejected"]);
  });
});
