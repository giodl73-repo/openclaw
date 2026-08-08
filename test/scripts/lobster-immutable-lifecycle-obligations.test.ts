import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateImmutableLifecycleObligations,
} from "../../scripts/lobster-immutable-lifecycle-obligations.mjs";

const SCRIPT = resolve("scripts/lobster-immutable-lifecycle-obligations.mjs");
const FIXTURE = resolve(".lobster/immutable-lifecycle-obligations-fixture.json");

function acceptedInput() {
  return structuredClone(JSON.parse(readFileSync(FIXTURE, "utf8")).cases[0].input);
}

describe("lobster.dgr.immutable-lifecycle-obligations.v1", () => {
  it("blocks a held child before effect and later settles the same operation", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        requiredChildCount: 2,
        settledChildCount: 2,
        blockedBeforeEffect: 1,
        effectCount: 2,
        unresolvedAcknowledgements: 0,
        status: "complete",
        assuranceComplete: true,
      },
    });
  });

  it("rejects required-child membership changes after plan acceptance", () => {
    const input = acceptedInput();
    input.final.requiredChildIds.push("late-copy");

    expect(validateImmutableLifecycleObligations(input).failures).toContainEqual({
      code: "RequiredMembershipChanged",
    });
  });

  it("rejects destructive mutation after authority revocation", () => {
    const input = acceptedInput();
    const check = input.events[1];
    check.authority = "revoked";
    check.authorityRef = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateImmutableLifecycleObligations(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "StaleAuthorityAuthorized",
          childId: "session-canonical",
        }),
        expect.objectContaining({
          code: "EffectWithoutAuthorization",
          childId: "session-canonical",
        }),
      ]),
    );
  });

  it("rejects changed policy and owner generations at the final fence", () => {
    const input = acceptedInput();
    input.events[5].policyGeneration =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    input.events[5].ownerGeneration =
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    expect(
      validateImmutableLifecycleObligations(input).failures.map((failure) => failure.code),
    ).toEqual(expect.arrayContaining(["OwnerGenerationChanged", "PolicyGenerationChanged"]));
  });

  it("requires the successful final fence immediately before mutation", () => {
    const input = acceptedInput();
    input.events.splice(2, 0, structuredClone(input.events[5]));
    input.events.forEach(
      (event: { sequence: number }, index: number) => (event.sequence = index + 1),
    );

    expect(validateImmutableLifecycleObligations(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "EffectWithoutAuthorization",
          childId: "session-canonical",
        }),
      ]),
    );
  });

  it("rejects a changed child operation identity during replay", () => {
    const input = acceptedInput();
    input.events[4].operationId =
      "hmac-sha256:v1:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateImmutableLifecycleObligations(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OperationIdentityChanged",
          childId: "session-canonical",
        }),
      ]),
    );
  });

  it("does not permit a second mutation after lost acknowledgement", () => {
    const input = acceptedInput();
    input.events.splice(4, 0, {
      sequence: 5,
      kind: "mutation",
      childId: "session-canonical",
      operationId:
        "hmac-sha256:v1:5111111111111111111111111111111111111111111111111111111111111111",
      effectRef: "sha256:b111111111111111111111111111111111111111111111111111111111111111",
      outcome: "applied",
    });
    input.events.forEach(
      (event: { sequence: number }, index: number) => (event.sequence = index + 1),
    );

    expect(validateImmutableLifecycleObligations(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DuplicateMutation",
          childId: "session-canonical",
        }),
      ]),
    );
  });

  it("requires unknown acknowledgement to reconcile before completion", () => {
    const input = acceptedInput();
    input.events.splice(4, 1);
    input.events.forEach(
      (event: { sequence: number }, index: number) => (event.sequence = index + 1),
    );
    input.final.settledChildIds = ["qmd-session-projection"];
    input.final.status = "partial";
    input.final.assuranceComplete = false;

    expect(validateImmutableLifecycleObligations(input).failures).toContainEqual({
      code: "AmbiguousAcknowledgementUnresolved",
    });
  });

  it("rejects unplanned children, duplicate effects, overclaim, and sensitive evidence", () => {
    const result = runFixture().cases[1]!.result;

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "AggregateOverclaimed",
        "AmbiguousAcknowledgementUnresolved",
        "DuplicateMutation",
        "EffectWithoutAuthorization",
        "HeldMutationAuthorized",
        "OperationIdentityChanged",
        "PolicyGenerationChanged",
        "RequiredMembershipChanged",
        "SensitivePayloadPresent",
        "StaleAuthorityAuthorized",
        "UnplannedChild",
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
