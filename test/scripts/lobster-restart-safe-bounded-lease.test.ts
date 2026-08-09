import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateRestartSafeBoundedLeaseEvidence,
} from "../../scripts/lobster-restart-safe-bounded-lease.mjs";

const SCRIPT = resolve("scripts/lobster-restart-safe-bounded-lease.mjs");
const FIXTURE = resolve(".lobster/restart-safe-bounded-lease-fixture.json");

function acceptedInput() {
  return structuredClone(JSON.parse(readFileSync(FIXTURE, "utf8")).cases[0].input);
}

describe("lobster.dgr.restart-safe-bounded-lease.v1", () => {
  it("reconciles one exhausted, restarted, fenced, and settled capacity unit", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        capacity: 1,
        capacityInUse: 0,
        leaseCount: 2,
        settledLeaseCount: 2,
        restartCount: 1,
        exhaustionCount: 1,
        existingAcquisitionCount: 1,
        fencedCount: 1,
      },
    });
  });

  it("returns the existing lease when acquisition acknowledgement is lost", () => {
    const input = acceptedInput();
    const retry = input.events.find(
      (event: { type: string; outcome?: string }) =>
        event.type === "acquire" && event.outcome === "existing",
    );

    expect(retry).toMatchObject({
      operationId: "operation-a",
      leaseId: "lease-a",
      generation: 1,
      outcome: "existing",
    });
    expect(validateRestartSafeBoundedLeaseEvidence(input).status).toBe("accepted");
  });

  it("rejects allocating a second lease when the same operation retries", () => {
    const input = acceptedInput();
    input.events[3] = {
      ...input.events[3],
      leaseId: "lease-duplicate",
      generation: 2,
      expiresAt: 230,
      outcome: "admitted",
    };

    expect(validateRestartSafeBoundedLeaseEvidence(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OperationIdentityInvalid", sequence: 4 }),
        expect.objectContaining({ code: "CapacityExceeded", sequence: 4 }),
      ]),
    );
  });

  it("requires restart state to contain the active persisted lease", () => {
    const input = acceptedInput();
    input.events[2].persistedLeaseIds = [];

    expect(validateRestartSafeBoundedLeaseEvidence(input).failures).toContainEqual({
      code: "RestartStateMismatch",
      sequence: 3,
    });
  });

  it("rejects a stale holder reported as still owned", () => {
    const input = acceptedInput();
    input.events[7].outcome = "owned";

    expect(validateRestartSafeBoundedLeaseEvidence(input).failures).toContainEqual({
      code: "StaleHolderNotFenced",
      sequence: 8,
      leaseId: "lease-a",
    });
  });

  it("requires every admitted lease to settle terminally", () => {
    const input = acceptedInput();
    input.events.pop();
    input.final.settledLeaseIds = ["lease-a"];

    expect(validateRestartSafeBoundedLeaseEvidence(input).failures).toContainEqual({
      code: "TerminalSettlementInvalid",
    });
  });

  it("rejects duplicate capacity, restart drift, stale use, and missing settlement", () => {
    const result = runFixture().cases[1]!.result;

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "CapacityExceeded",
        "RestartStateMismatch",
        "LeaseTerminationInvalid",
        "RenewalInvalid",
        "StaleHolderNotFenced",
        "TerminalSettlementInvalid",
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
