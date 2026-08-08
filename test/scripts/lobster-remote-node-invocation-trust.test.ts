import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateRemoteNodeInvocationTrust,
} from "../../scripts/lobster-remote-node-invocation-trust.mjs";

const SCRIPT = resolve("scripts/lobster-remote-node-invocation-trust.mjs");
const FIXTURE = resolve(".lobster/remote-node-invocation-trust-fixture.json");

function acceptedInput() {
  return structuredClone(JSON.parse(readFileSync(FIXTURE, "utf8")).cases[0].input);
}

describe("lobster.rfn.remote-node-invocation-trust.v1", () => {
  it("keeps completed, pre-dispatch blocked, and post-dispatch unknown effects distinct", () => {
    expect(runFixture().cases[0]!.result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        expectedOperationCount: 3,
        reportedOperationCount: 3,
        counts: {
          completed: 1,
          blocked: 1,
          cancelled: 1,
          unknownEffects: 1,
        },
        status: "partial",
        assuranceComplete: false,
      },
    });
  });

  it("does not treat advertised capability as current command authority", () => {
    const input = acceptedInput();
    input.operations[0].authority.policyRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AuthorityInvalid",
          operationId:
            "hmac-sha256:v1:4111111111111111111111111111111111111111111111111111111111111111",
        }),
      ]),
    );
  });

  it("binds completed effects to the current pairing generation and connection", () => {
    const input = acceptedInput();
    input.operations[0].current.connectionRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SubjectBindingMismatch",
          operationId:
            "hmac-sha256:v1:4111111111111111111111111111111111111111111111111111111111111111",
        }),
      ]),
    );
  });

  it("rejects an invoke identity on a pre-dispatch pairing block", () => {
    const input = acceptedInput();
    input.operations[1].invocation.dispatched = true;
    input.operations[1].invocation.invokeRef =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DispatchProvenanceInvalid",
          operationId:
            "hmac-sha256:v1:5111111111111111111111111111111111111111111111111111111111111111",
        }),
      ]),
    );
  });

  it("accepts a current-pairing route change as a confirmed pre-dispatch block", () => {
    const input = acceptedInput();
    input.operations[1].current.pairingGeneration = input.operations[1].subject.pairingGeneration;
    input.operations[1].reason = "ROUTE_CHANGED";

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual([]);
  });

  it("accepts a current policy denial as a confirmed pre-dispatch block", () => {
    const input = acceptedInput();
    input.operations[1].current = structuredClone(input.operations[1].subject);
    delete input.operations[1].current.nodeRef;
    input.operations[1].authority.decision = "deny";
    input.operations[1].reason = "POLICY_DENIED";

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual([]);
  });

  it("requires ordered contiguous progress before terminal settlement", () => {
    const input = acceptedInput();
    input.operations[0].stream.progress[1].sequence = 2;

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "StreamInvalid",
          operationId:
            "hmac-sha256:v1:4111111111111111111111111111111111111111111111111111111111111111",
        }),
      ]),
    );
  });

  it("keeps an unacknowledged post-dispatch abort effect unknown", () => {
    const input = acceptedInput();
    input.operations[2].effect = {
      result: "stopped",
      certainty: "confirmed",
      evidenceRef: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CancellationCertaintyOverclaimed",
          operationId:
            "hmac-sha256:v1:6111111111111111111111111111111111111111111111111111111111111111",
        }),
      ]),
    );
  });

  it("aggregates only the inventoried operation set", () => {
    const input = acceptedInput();
    input.operations.pop();

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([{ code: "OperationInventoryMismatch" }]),
    );
  });

  it("rejects complete assurance while a remote effect is unknown", () => {
    const input = acceptedInput();
    input.final.status = "complete";
    input.final.assuranceComplete = true;

    expect(validateRemoteNodeInvocationTrust(input).failures).toEqual(
      expect.arrayContaining([{ code: "AssuranceOverclaimed" }, { code: "FinalStateMismatch" }]),
    );
  });

  it("rejects authority, route, stream, cancellation, inventory, and sensitive overclaims", () => {
    const result = runFixture().cases[1]!.result;

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "AssuranceOverclaimed",
        "AuthorityInvalid",
        "CancellationCertaintyOverclaimed",
        "DispatchProvenanceInvalid",
        "FinalStateMismatch",
        "OperationInventoryMismatch",
        "SensitivePayloadPresent",
        "StreamInvalid",
        "SubjectBindingMismatch",
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
