import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REQUIRED_OWNERS = ["configuration", "readiness", "release"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function projectOwnerFacts(input) {
  const failures = [];
  const facts = input?.facts ?? {};
  const expected = input?.expected ?? {};

  for (const owner of REQUIRED_OWNERS) {
    const fact = facts[owner];
    if (!fact) {
      failures.push({ owner, code: "OwnerOmitted" });
      continue;
    }
    if (fact.schemaVersion !== 1) {
      failures.push({
        owner,
        code: "OwnerSchemaUnsupported",
        expected: 1,
        actual: fact.schemaVersion ?? null,
      });
    }
    const expectedGeneration = expected.generations?.[owner];
    if (fact.generation !== expectedGeneration) {
      failures.push({
        owner,
        code: "OwnerStale",
        expected: expectedGeneration ?? null,
        actual: fact.generation ?? null,
      });
    }
    if (fact.artifactGeneration !== expected.artifactGeneration) {
      failures.push({
        owner,
        code: "OwnerMixedVersion",
        expected: expected.artifactGeneration ?? null,
        actual: fact.artifactGeneration ?? null,
      });
    }
  }

  const releaseVersion = facts.release?.value?.version;
  if (releaseVersion !== undefined && releaseVersion !== expected.releaseVersion) {
    failures.push({
      owner: "release",
      code: "ReleaseVersionMismatch",
      expected: expected.releaseVersion ?? null,
      actual: releaseVersion,
    });
  }

  for (const [owner, fact] of Object.entries(facts)) {
    if (!REQUIRED_OWNERS.includes(owner) && fact?.required === true) {
      failures.push({ owner, code: "RequiredOwnerUnknown" });
    }
  }

  return {
    fixtureId: "lobster.exa.owner-projection.v1",
    status: failures.length === 0 ? "accepted" : "rejected",
    projection: clone(facts),
    failures,
  };
}

export function runFixture(path = resolve(ROOT, ".lobster/owner-projection-fixture.json")) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const cases = fixture.cases.map((entry) => {
    const result = projectOwnerFacts(entry.input);
    const failureCodes = result.failures.map((failure) => failure.code).sort();
    const expectedCodes = [...(entry.expected.failureCodes ?? [])].sort();
    if (
      result.status !== entry.expected.status ||
      JSON.stringify(failureCodes) !== JSON.stringify(expectedCodes)
    ) {
      throw new Error(`Fixture case ${entry.id} did not match its expected result`);
    }
    return { id: entry.id, result };
  });
  return { schemaVersion: 1, fixtureId: fixture.fixtureId, cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runFixture(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
