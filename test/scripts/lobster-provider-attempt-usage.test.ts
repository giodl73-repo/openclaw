import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateProviderAttemptUsageEvidence,
} from "../../scripts/lobster-provider-attempt-usage.mjs";

const SCRIPT = resolve("scripts/lobster-provider-attempt-usage.mjs");
const FIXTURE = resolve(".lobster/provider-attempt-usage-fixture.json");

function acceptedFallbackInput() {
  return structuredClone(JSON.parse(readFileSync(FIXTURE, "utf8")).cases[0].input);
}

describe("lobster.mpu.provider-attempt-usage.v1", () => {
  it("reconciles failed and successful fallback calls to the unchanged run total", () => {
    const result = runFixture().cases[0]!.result;

    expect(result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        candidateCount: 2,
        modelCallCount: 2,
        runUsage: { input: 260, output: 42, total: 302 },
      },
    });
  });

  it("keeps a generation-fenced candidate at zero calls and zero usage", () => {
    const result = runFixture().cases[1]!.result;

    expect(result).toMatchObject({
      status: "accepted",
      failures: [],
      reconciliation: {
        candidateCount: 1,
        modelCallCount: 0,
        runUsage: { input: 0, output: 0, total: 0 },
      },
    });
  });

  it("rejects reconstructed linkage, mutable bindings, and accounting drift", () => {
    const result = runFixture().cases[2]!.result;

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "CandidateBindingInvalid",
        "ModelCallParentInvalid",
        "CandidateCallSetMismatch",
        "CandidateOutcomeMismatch",
        "CandidateUsageMismatch",
        "CandidateLinkNotDispatchBound",
        "FencedCandidateDispatched",
        "RunUsageMismatch",
        "FallbackSequenceInvalid",
        "SensitivePayloadPresent",
      ]),
    );
  });

  it("runs the checked-in accepted and rejected evidence cases", () => {
    const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }));

    expect(
      output.cases.map((entry: { result: { status: string } }) => entry.result.status),
    ).toEqual(["accepted", "accepted", "rejected"]);
  });

  it("requires an explicit candidate parent for every model call", () => {
    const result = validateProviderAttemptUsageEvidence({
      schemaVersion: 1,
      evidenceType: "model.candidate_attempts",
      runId: "run-legacy",
      result: "blocked",
      attempts: [],
      modelCalls: [
        {
          modelCallId: "run-legacy:model:1",
          runId: "run-legacy",
          candidateAttemptId: "unknown-candidate",
          candidateLink: { source: "diagnostic_reconstruction", phase: "after_completion" },
          provider: "provider-a",
          model: "model-a",
          usage: { input: 10, total: 10 },
        },
      ],
      runUsage: { input: 10, total: 10, reconciles: true },
    });

    expect(result.failures).toContainEqual({
      code: "ModelCallParentInvalid",
      modelCallId: "run-legacy:model:1",
    });
  });

  it("rejects otherwise consistent linkage reconstructed after completion", () => {
    const input = acceptedFallbackInput();
    input.modelCalls[0].candidateLink = {
      source: "diagnostic_reconstruction",
      phase: "after_completion",
    };

    expect(validateProviderAttemptUsageEvidence(input).failures).toContainEqual({
      code: "CandidateLinkNotDispatchBound",
      modelCallId: "run-evid-003:model:1",
    });
  });

  it("rejects matching negative usage at every accounting level", () => {
    const input = acceptedFallbackInput();
    input.modelCalls[0].usage = { input: -1, total: -1 };
    input.attempts[0].usage = { input: -1, total: -1 };
    input.runUsage = { input: 139, output: 42, total: 181, reconciles: true };

    expect(validateProviderAttemptUsageEvidence(input).failures).toContainEqual({
      code: "SensitivePayloadPresent",
    });
  });
});
