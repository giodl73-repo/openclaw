import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateInertDefinitionCompatibility,
} from "../../scripts/lobster-inert-definition-compatibility.mjs";

const SCRIPT = resolve("scripts/lobster-inert-definition-compatibility.mjs");

function fixtureInput(caseIndex = 0): Record<string, unknown> {
  const fixture = JSON.parse(
    readFileSync(resolve(".lobster/inert-definition-compatibility-fixture.json"), "utf8"),
  );
  return structuredClone(fixture.cases[caseIndex].input);
}

function failureCodes(input: unknown): string[] {
  return validateInertDefinitionCompatibility(input).failures.map((failure) => failure.code);
}

describe("lobster.ext.inert-definition-compatibility.v1", () => {
  it("accepts native identities and preserves unknown optional semantics across three families", () => {
    const accepted = runFixture().cases[0]!.result;

    expect(accepted).toMatchObject({
      status: "accepted",
      authority: "none",
      activationAttempted: false,
      mutationAttempted: false,
      failures: [],
    });
    expect(accepted.definitions.map((definition) => definition.family)).toEqual([
      "plugin",
      "claw",
      "skill",
    ]);
    expect(accepted.preservedOptionalSemantics).toEqual([
      "vendor.example.catalog-label.v1",
      "vendor.example.dashboard-hint.v2",
    ]);
  });

  it("rejects unknown required semantics before activation or mutation", () => {
    const rejected = runFixture().cases[1]!.result;

    expect(rejected.status).toBe("rejected");
    expect(rejected.activationAttempted).toBe(false);
    expect(rejected.mutationAttempted).toBe(false);
    expect(rejected.failures).toContainEqual({
      code: "UnknownRequiredSemantic",
      definitionId: "plugin:browser-next",
      semantic: "vendor.example.protected-route.v2",
    });
    expect(
      rejected.definitions.find((definition) => definition.definitionId === "plugin:browser-next"),
    ).toMatchObject({ status: "blocked" });
  });

  it("fails closed on malformed definition collections", () => {
    const input = fixtureInput();
    input.definitions = {};

    expect(failureCodes(input)).toEqual(
      expect.arrayContaining(["DefinitionInvalid", "DefinitionFamilySetMismatch"]),
    );
  });

  it.each([null, [], "not-an-object"])("fails closed on non-object input %#", (input) => {
    const result = validateInertDefinitionCompatibility(input);

    expect(result.status).toBe("rejected");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "InputInvalid",
        "ConsumerContractMismatch",
        "DefinitionInvalid",
        "PreActivationBoundaryViolated",
      ]),
    );
  });

  it("requires exactly one plugin, Claw, and skill definition", () => {
    const input = fixtureInput();
    const definitions = input.definitions as Array<Record<string, unknown>>;
    input.definitions = definitions.slice(1);
    input.expectedDefinitionIds = (input.expectedDefinitionIds as string[]).slice(1);

    expect(failureCodes(input)).toContain("DefinitionFamilySetMismatch");
  });

  it("rejects duplicate native definition identities", () => {
    const input = fixtureInput();
    const definitions = input.definitions as Array<Record<string, unknown>>;
    definitions[1] = structuredClone(definitions[0]!);

    expect(failureCodes(input)).toEqual(
      expect.arrayContaining(["DefinitionDuplicated", "DefinitionFamilySetMismatch"]),
    );
  });

  it("binds the exact expected native identity set", () => {
    const input = fixtureInput();
    input.expectedDefinitionIds = ["claw:github-triage", "plugin:browser", "skill:different"];

    expect(failureCodes(input)).toContain("DefinitionIdentityMismatch");
  });

  it("does not let one family claim another family's supported semantics", () => {
    const input = fixtureInput();
    const definitions = input.definitions as Array<Record<string, unknown>>;
    definitions[2]!.requiredSemantics = ["skill.prompt-content.v1", "plugin.config-schema.v1"];

    expect(failureCodes(input)).toContain("SemanticOwnerMismatch");
  });

  it("rejects family-invalid native revisions and digests", () => {
    const input = fixtureInput();
    const definitions = input.definitions as Array<Record<string, unknown>>;
    definitions[0]!.revision = "latest";
    definitions[1]!.digest = "sha256:short";

    expect(failureCodes(input)).toContain("DefinitionInvalid");
  });

  it("rejects activation, mutation, and authority overclaim", () => {
    const input = fixtureInput();
    input.activationAttempted = true;
    input.mutationAttempted = true;
    input.authority = "catalog";

    expect(failureCodes(input)).toEqual(
      expect.arrayContaining(["PreActivationBoundaryViolated", "AuthorityOverclaimed"]),
    );
  });

  it("rejects sensitive definition payloads and unknown envelope fields", () => {
    const input = fixtureInput();
    input.token = "not-allowed";

    expect(failureCodes(input)).toEqual(
      expect.arrayContaining(["SensitiveFieldPresent", "InputInvalid"]),
    );
  });

  it("fails the CLI without success-shaped output for an invalid fixture", () => {
    const result = spawnSync(process.execPath, [SCRIPT, ".lobster/fixtures.json"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("definition compatibility fixture envelope is invalid");
  });

  it("requires the complete accepted and rejected case set", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(".lobster/inert-definition-compatibility-fixture.json"), "utf8"),
    );
    fixture.cases = fixture.cases.slice(0, 1);
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-definition-compatibility-"));
    const tempPath = join(tempDir, "fixture.json");
    try {
      writeFileSync(tempPath, JSON.stringify(fixture), "utf8");
      expect(() => runFixture(tempPath)).toThrow(
        "definition compatibility fixture envelope is invalid",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits deterministic fixture output", () => {
    const first = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });

    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });
});
