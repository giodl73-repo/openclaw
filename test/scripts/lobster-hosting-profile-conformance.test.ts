import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateHostingProfileEvidence,
} from "../../scripts/lobster-hosting-profile-conformance.mjs";

const SCRIPT = resolve("scripts/lobster-hosting-profile-conformance.mjs");

describe("lobster.exa.hosting-profile-conformance.v1", () => {
  it("accepts complete ready and intentionally not-ready profile evidence", () => {
    const cases = runFixture().cases;
    expect(cases).toHaveLength(3);
    const ready = cases[0]!;
    const notReady = cases[1]!;

    expect(ready.result).toMatchObject({
      status: "accepted",
      conformant: true,
      ready: true,
      failures: [],
    });
    expect(notReady.result).toMatchObject({
      status: "accepted",
      conformant: true,
      ready: false,
      failures: [],
    });
  });

  it("rejects catalog, profile, condition, and package evidence mismatches", () => {
    const rejected = runFixture().cases[2]!.result;

    expect(rejected.status).toBe("rejected");
    expect(rejected.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "CatalogProfilesMismatch",
        "ProfileContractMismatch",
        "ActiveProfileMismatch",
        "ProfileConditionMissing",
        "ProfileConditionNotRequired",
        "ArtifactProvenanceInvalid",
        "ArtifactScenarioSetMismatch",
        "ArtifactFailed",
      ]),
    );
  });

  it("does not confuse structural conformance with current readiness", () => {
    const input = structuredClone(
      JSON.parse(
        execFileSync(process.execPath, [SCRIPT], {
          encoding: "utf8",
        }),
      ),
    );

    expect(input.cases.map((entry: { result: { status: string } }) => entry.result.status)).toEqual(
      ["accepted", "accepted", "rejected"],
    );
    expect(
      validateHostingProfileEvidence({
        expected: { profile: "local", profileContractVersion: 1 },
        catalog: { contractVersion: 1, profiles: [] },
        live: {
          contractVersion: 1,
          profileContractVersion: 1,
          activeProfile: "local",
          conformant: true,
          ready: true,
          conditions: [{ type: "ProfileSelected", requirement: "required", status: "True" }],
        },
        artifact: {},
      }).status,
    ).toBe("rejected");
  });
});
