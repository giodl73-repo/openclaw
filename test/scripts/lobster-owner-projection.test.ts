import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { projectOwnerFacts, runFixture } from "../../scripts/lobster-owner-projection.mjs";

const SCRIPT = resolve("scripts/lobster-owner-projection.mjs");

describe("lobster.exa.owner-projection.v1", () => {
  it("preserves current owner facts without flattening optional owners", () => {
    const accepted = runFixture().cases[0].result;

    expect(accepted.status).toBe("accepted");
    expect(accepted.failures).toEqual([]);
    expect(accepted.projection.configuration.value.readOnly).toBe(true);
    expect(accepted.projection.readiness.value.ready).toBe(true);
    expect(accepted.projection.release.value.channel).toBe("extended-stable");
    expect(accepted.projection.telemetry.value.sampled).toBe(true);
  });

  it("rejects stale, mixed-version, and omitted required owners structurally", () => {
    const rejected = runFixture().cases[1].result;

    expect(rejected.status).toBe("rejected");
    expect(rejected.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "configuration", code: "OwnerStale" }),
        expect.objectContaining({ owner: "readiness", code: "OwnerOmitted" }),
        expect.objectContaining({ owner: "release", code: "OwnerMixedVersion" }),
        expect.objectContaining({ owner: "release", code: "ReleaseVersionMismatch" }),
      ]),
    );
  });

  it("rejects unknown required owners while preserving unknown optional owners", () => {
    const result = projectOwnerFacts({
      expected: {
        artifactGeneration: "openclaw@2026.6.33",
        releaseVersion: "2026.6.33",
        generations: {
          configuration: "config-1",
          readiness: "readiness-1",
          release: "release-1",
        },
      },
      facts: {
        configuration: {
          schemaVersion: 1,
          generation: "config-1",
          artifactGeneration: "openclaw@2026.6.33",
        },
        readiness: {
          schemaVersion: 1,
          generation: "readiness-1",
          artifactGeneration: "openclaw@2026.6.33",
        },
        release: {
          schemaVersion: 1,
          generation: "release-1",
          artifactGeneration: "openclaw@2026.6.33",
          value: { version: "2026.6.33" },
        },
        futureOptional: {
          schemaVersion: 1,
          required: false,
          value: { preserved: true },
        },
        futureRequired: {
          schemaVersion: 1,
          required: true,
        },
      },
    });

    expect(result.status).toBe("rejected");
    expect(result.projection.futureOptional.value.preserved).toBe(true);
    expect(result.failures).toContainEqual({
      owner: "futureRequired",
      code: "RequiredOwnerUnknown",
    });
  });

  it("runs the checked-in accepted and rejected evidence cases", () => {
    const output = JSON.parse(execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }));

    expect(
      output.cases.map((entry: { result: { status: string } }) => entry.result.status),
    ).toEqual(["accepted", "rejected"]);
  });
});
