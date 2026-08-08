import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateAuthorizedExternalAction,
} from "../../scripts/lobster-authorized-external-action.mjs";

const SCRIPT = resolve("scripts/lobster-authorized-external-action.mjs");
const FIXTURE = resolve(".lobster/authorized-external-action-fixture.json");

function acceptedInput() {
  return structuredClone(JSON.parse(readFileSync(FIXTURE, "utf8")).cases[0].input);
}

describe("lobster.exa.authorized-external-action.v1", () => {
  it("keeps stale-policy refusal, one effect, and its replay distinct", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        expectedOperationCount: 3,
        reportedOperationCount: 3,
        counts: {
          completed: 1,
          blocked: 1,
          replayed: 1,
          unknownEffects: 0,
          uniqueEffects: 1,
        },
        status: "complete",
        assuranceComplete: true,
      },
    });
  });

  it("binds the admitted requester and session", () => {
    const input = acceptedInput();
    input.operations[1].request.requesterRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RequesterBindingMismatch",
          operationId:
            "hmac-sha256:v1:6111111111111111111111111111111111111111111111111111111111111111",
        }),
      ]),
    );
  });

  it("binds the concrete tool owner and run-scoped surface", () => {
    const input = acceptedInput();
    input.operations[1].capability.surfaceRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CapabilityBindingMismatch" })]),
    );
  });

  it("blocks changed policy before dispatch", () => {
    const input = acceptedInput();
    input.operations[0].invocation.dispatched = true;

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DispatchProvenanceInvalid" })]),
    );
  });

  it("rejects an expired approval at dispatch", () => {
    const input = acceptedInput();
    input.operations[1].authority.observedAt = "2026-08-08T00:13:00Z";

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ApprovalExpired" }),
        expect.objectContaining({ code: "AuthorityInvalid" }),
      ]),
    );
  });

  it("rejects stale policy on a dispatched operation", () => {
    const input = acceptedInput();
    input.operations[1].authority.approvedPolicyRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "AuthorityInvalid" })]),
    );
  });

  it("requires identical finalized parameters for an idempotent replay", () => {
    const input = acceptedInput();
    input.operations[2].invocation.paramsRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IdempotencyConflict" })]),
    );
  });

  it("requires a replay to resolve the original owner effect", () => {
    const input = acceptedInput();
    input.operations[2].effect.effectRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IdempotencyConflict" })]),
    );
  });

  it("does not infer a confirmed effect from runtime success", () => {
    const input = acceptedInput();
    input.operations[1].effect = {
      effectRef: null,
      result: "unknown",
      duplicate: false,
      certainty: "unknown",
    };

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EffectSettlementInvalid" })]),
    );
  });

  it("aggregates only the inventoried operation set", () => {
    const input = acceptedInput();
    input.operations.pop();

    expect(validateAuthorizedExternalAction(input).failures).toEqual(
      expect.arrayContaining([{ code: "OperationInventoryMismatch" }]),
    );
  });

  it("rejects authority, replay, inventory, assurance, and sensitive overclaims", () => {
    const result = runFixture().cases[1]!.result;

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "ApprovalExpired",
        "AssuranceOverclaimed",
        "AuthorityInvalid",
        "CapabilityBindingMismatch",
        "EffectSettlementInvalid",
        "FinalStateMismatch",
        "IdempotencyConflict",
        "OperationInventoryMismatch",
        "RequesterBindingMismatch",
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
