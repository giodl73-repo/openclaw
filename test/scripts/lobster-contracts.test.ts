import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateContracts } from "../../scripts/lobster-contracts.mjs";

const ROOT = resolve(".");
const SCRIPT = resolve("scripts/lobster-contracts.mjs");

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8"));
}

function inputs() {
  return {
    manifest: readJson(".lobster/contracts.json"),
    fixtures: readJson(".lobster/fixtures.json"),
    disposition: readJson(".lobster/disposition.json"),
  };
}

function ledgerEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "B1-example",
    classification: "B1",
    owner: "Lobster OpenClaw",
    baseCommit: "a".repeat(40),
    sourceSha: "b".repeat(40),
    patchId: "c".repeat(40),
    dependencies: [],
    destination: "src/example.ts",
    fixtureIds: ["lobster.exa.owner-projection.v1"],
    replacement: "upstream owner path",
    minimumRelease: "2027.1.1",
    mixedVersionWindow: "one extended-stable cycle",
    rollback: "restore prior owner implementation",
    delete: ["src/example.ts"],
    retain: [],
    zeroOldPathEvidence: "fixture proves old path is unreachable",
    expiry: "2027-09-01T00:00:00Z",
    status: "planned",
    ...overrides,
  };
}

describe("Lobster Wave 0 contracts", () => {
  it("validates XPK-001 through XPK-009 and emits a stable summary", () => {
    const first = JSON.parse(execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }));
    const second = JSON.parse(execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }));

    expect(first).toMatchObject({
      schemaVersion: 1,
      phase: "wave-0",
      authority: "definition-only",
      admissionReady: false,
      contractCount: 9,
      sharedResultCount: 12,
      relationshipReferenceCount: 17,
      fixtureCount: 27,
      ledgerEntryCount: 20,
    });
    expect(first.contractSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
    expect(inputs().fixtures.fixtures.at(-1).runners).toEqual({
      typescript: "required",
      rust: "required",
    });
  });

  it("rejects reordered or missing execution dependencies", () => {
    const value = inputs();
    value.manifest.contracts[3].dependsOn = ["XPK-003"];

    expect(() => validateContracts(value)).toThrow("XPK-004.dependsOn");

    const ownerPath = inputs();
    ownerPath.manifest.contracts[0].ownerPath = "#/owner";
    expect(() => validateContracts(ownerPath)).toThrow("XPK-001.ownerPath");
  });

  it("rejects an abbreviated base commit", () => {
    const value = inputs();
    value.manifest.baseCommit = value.manifest.baseCommit.slice(0, 12);

    expect(() => validateContracts(value)).toThrow("full lowercase Git commit SHA");
  });

  it("rejects duplicate semantic-result ownership and trust-order drift", () => {
    const duplicated = inputs();
    duplicated.manifest.sharedResults[1].id = duplicated.manifest.sharedResults[0].id;
    expect(() => validateContracts(duplicated)).toThrow("more than one producer");

    const unnamedConsumer = inputs();
    unnamedConsumer.manifest.sharedResults[0].consumers = [""];
    expect(() => validateContracts(unnamedConsumer)).toThrow("array of non-empty strings");

    const reordered = inputs();
    [reordered.manifest.trustOrder[1], reordered.manifest.trustOrder[2]] = [
      reordered.manifest.trustOrder[2],
      reordered.manifest.trustOrder[1],
    ];
    expect(() => validateContracts(reordered)).toThrow("trustOrder");
  });

  it("rejects weakened evidence and deployment fail-mode contracts", () => {
    const evidence = inputs();
    evidence.manifest.evidenceIntegrity.failureMatrix[2].behavior = "proceed-with-warning";
    expect(() => validateContracts(evidence)).toThrow("required sink-failure behavior");

    const profile = inputs();
    delete profile.manifest.deploymentProfiles[2].degradedBehavior;
    expect(() => validateContracts(profile)).toThrow("deploymentProfiles[2].degradedBehavior");

    const replay = inputs();
    replay.manifest.managedMutation.connectorDelivery = "at-most-once-drop-on-failure";
    expect(() => validateContracts(replay)).toThrow("reconcile at-least-once delivery");
  });

  it("rejects incomplete fixtures and ledger formats with structured errors", () => {
    const fixture = inputs();
    delete fixture.fixtures.fixtures[0].structuredFailure;
    expect(() => validateContracts(fixture)).toThrow(
      "fixtures[0].structuredFailure is required by XPK-007",
    );

    const ledger = inputs();
    ledger.disposition.format.requiredFields = ledger.disposition.format.requiredFields.slice(1);
    expect(() => validateContracts(ledger)).toThrow("disposition.format.requiredFields");

    const implementedWithoutRunner = inputs();
    delete implementedWithoutRunner.fixtures.fixtures[0].runner;
    expect(() => validateContracts(implementedWithoutRunner)).toThrow(
      "fixture lobster.exa.owner-projection.v1.runner",
    );

    const invalidRustRunner = inputs();
    invalidRustRunner.fixtures.fixtures.at(-1).runners.rust = "preferred";
    expect(() => validateContracts(invalidRustRunner)).toThrow(
      "required TypeScript and valid Rust runner expectations",
    );

    const numericFixtureId = inputs();
    numericFixtureId.fixtures.fixtures[0].id = 1;
    expect(() => validateContracts(numericFixtureId)).toThrow("fixtures[0].id");

    const untypedLedger = inputs();
    untypedLedger.disposition.entries = [
      Object.fromEntries(
        untypedLedger.manifest.ledger.requiredFields.map((field: string) => [field, "x"]),
      ),
    ];
    expect(() => validateContracts(untypedLedger)).toThrow("classification must be B1");

    const unknownFixture = inputs();
    unknownFixture.disposition.entries = [ledgerEntry({ fixtureIds: ["missing.fixture.v1"] })];
    expect(() => validateContracts(unknownFixture)).toThrow("references unknown fixture");

    const futureRelease = inputs();
    futureRelease.disposition.entries = [ledgerEntry()];
    expect(() => validateContracts(futureRelease)).not.toThrow();

    const invalidExpiry = inputs();
    invalidExpiry.disposition.entries = [ledgerEntry({ expiry: "2027-02-31T00:00:00Z" })];
    expect(() => validateContracts(invalidExpiry)).toThrow("RFC 3339 UTC timestamp");

    const duplicateId = inputs();
    duplicateId.disposition.entries = [ledgerEntry(), ledgerEntry()];
    expect(() => validateContracts(duplicateId)).toThrow("is duplicated");

    const unknownDependency = inputs();
    unknownDependency.disposition.entries = [ledgerEntry({ dependencies: ["B1-not-declared"] })];
    expect(() => validateContracts(unknownDependency)).toThrow("before it is declared");
  });

  it("fails the CLI without success-shaped output for invalid input", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--manifest", ".lobster/queue.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("contracts manifest must use schemaVersion 1");
    expect(result.stderr.trimEnd().endsWith("[lobster-contracts] FAILED (exit 1)")).toBe(true);
  });
});
