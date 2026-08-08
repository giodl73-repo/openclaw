import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateReleaseActivationFixture } from "../../scripts/lobster-release-activation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, ".lobster/release-activation-fixture.json"), "utf8"),
  ) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function failureCodes(input: unknown): string[] {
  return validateReleaseActivationFixture(input).failures.map((failure) => failure.code);
}

describe("release activation evidence", () => {
  it("accepts exact candidate readiness and pre-mutation schema refusal", async () => {
    const result = validateReleaseActivationFixture(await loadFixture());

    expect(result).toMatchObject({
      authority: "none",
      status: "pass",
      readyAttemptCount: 1,
      blockedAttemptCount: 1,
      unknownAttemptCount: 0,
      failures: [],
    });
  });

  it("rejects unsupported fields", async () => {
    const fixture = await loadFixture();
    (fixture as Record<string, unknown>).deploymentRing = "production";
    expect(failureCodes(fixture)).toContain("ContractMismatch");
  });

  it("rejects sensitive payload fields", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    attempts[0]!.token = "do-not-carry-secrets";
    expect(failureCodes(fixture)).toContain("SensitivePayloadPresent");
  });

  it("rejects mutable or uninventoried release identity", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const release = attempts[0]!.release as Record<string, Record<string, unknown>>;
    release.target!.artifactDigest = "latest";
    expect(failureCodes(fixture)).toContain("ReleaseIdentityInvalid");
  });

  it("rejects a target that aliases the prior artifact", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const release = attempts[0]!.release as Record<string, Record<string, unknown>>;
    release.target!.version = release.prior!.version;
    release.target!.artifactDigest = release.prior!.artifactDigest;
    expect(failureCodes(fixture)).toContain("ReleaseIdentityInvalid");
  });

  it("rejects ready results with incompatible state", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const compatibility = attempts[0]!.compatibility as Record<string, Record<string, unknown>>;
    compatibility.state!.result = "newer_than_target";
    expect(failureCodes(fixture)).toContain("CompatibilityInvalid");
  });

  it("rejects schema refusal after package mutation", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const mutation = attempts[1]!.mutation as Record<string, unknown>;
    mutation.package = "activated";
    expect(failureCodes(fixture)).toContain("MutationBoundaryInvalid");
  });

  it("rejects reordered activation phases", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const phases = attempts[0]!.phases as unknown[];
    [phases[0], phases[1]] = [phases[1], phases[0]];
    expect(failureCodes(fixture)).toContain("PhaseSequenceInvalid");
  });

  it("rejects reused phase evidence", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const phases = attempts[0]!.phases as Array<Record<string, unknown>>;
    phases[1]!.evidenceRef = phases[0]!.evidenceRef;
    expect(failureCodes(fixture)).toContain("PhaseSequenceInvalid");
  });

  it("rejects readiness bound to the prior artifact", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const release = attempts[0]!.release as Record<string, Record<string, unknown>>;
    const active = attempts[0]!.active as Record<string, unknown>;
    active.artifactDigest = release.prior!.artifactDigest;
    expect(failureCodes(fixture)).toContain("ActivationBindingMismatch");
  });

  it("rejects aggregate rollback in place of per-layer certainty", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    const recovery = attempts[1]!.recovery as Record<string, unknown>;
    delete recovery.code;
    delete recovery.state;
    recovery.result = "rolled_back";
    expect(failureCodes(fixture)).toContain("ContractMismatch");
    expect(failureCodes(fixture)).toContain("RecoveryCertaintyInvalid");
  });

  it("rejects missing inventoried attempts", async () => {
    const fixture = await loadFixture();
    (fixture.attempts as unknown[]).pop();
    expect(failureCodes(fixture)).toContain("AttemptInventoryMismatch");
  });

  it("rejects references in the wrong inventory class", async () => {
    const fixture = await loadFixture();
    const inventory = fixture.inventory as Record<string, unknown[]>;
    inventory.planRefs![0] =
      "attempt-sha256:1111111111111111111111111111111111111111111111111111111111111111";
    expect(failureCodes(fixture)).toContain("AttemptInventoryMismatch");
  });

  it("rejects non-array phases without throwing", async () => {
    const fixture = await loadFixture();
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    attempts[0]!.phases = {};
    expect(() => failureCodes(fixture)).not.toThrow();
    expect(failureCodes(fixture)).toContain("PhaseSequenceInvalid");
  });

  it("rejects final-state count drift", async () => {
    const fixture = await loadFixture();
    const finalState = fixture.finalState as Record<string, unknown>;
    finalState.readyAttemptCount = 2;
    expect(failureCodes(fixture)).toContain("FinalStateMismatch");
  });

  it("rejects aggregate assurance without both bounded outcomes", async () => {
    const fixture = clone(await loadFixture());
    const attempts = fixture.attempts as Array<Record<string, unknown>>;
    attempts.pop();
    const inventory = fixture.inventory as Record<string, unknown[]>;
    inventory.planRefs!.pop();
    inventory.expectedAttemptIds!.pop();
    const finalState = fixture.finalState as Record<string, unknown>;
    finalState.blockedAttemptCount = 0;
    expect(failureCodes(fixture)).toContain("AssuranceOverclaimed");
  });
});
