import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.ext.inert-definition-compatibility.v1";
const FAMILIES = ["claw", "plugin", "skill"];
const CASE_IDS = [
  "known-required-and-unknown-optional-remain-inert",
  "unknown-required-semantics-block-before-activation",
];
const SUPPORTED_SEMANTICS = [
  "claw.packages.exact-versions.v1",
  "claw.workspace.files.v1",
  "plugin.activation.v1",
  "plugin.config-schema.v1",
  "skill.invocation-policy.v1",
  "skill.prompt-content.v1",
];
const INPUT_KEYS = new Set([
  "activationAttempted",
  "authority",
  "consumer",
  "definitions",
  "expectedDefinitionIds",
  "mutationAttempted",
]);
const CONSUMER_KEYS = new Set(["contractVersion", "id", "supportedSemantics"]);
const DEFINITION_KEYS = new Set([
  "digest",
  "family",
  "nativeId",
  "optionalSemantics",
  "requiredSemantics",
  "revision",
]);
const EXPECTED_DEFINITION_KEYS = new Set([
  "definitionId",
  "digest",
  "family",
  "revision",
  "status",
]);
const SENSITIVE_KEYS = new Set([
  "apiKey",
  "auth",
  "authorization",
  "content",
  "credential",
  "environment",
  "password",
  "payload",
  "prompt",
  "secret",
  "token",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every((entry) => typeof entry === "string") &&
    JSON.stringify(actual.toSorted((left, right) => left.localeCompare(right))) ===
      JSON.stringify(expected.toSorted((left, right) => left.localeCompare(right)))
  );
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isUniqueStringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function containsSensitiveField(value) {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveField);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, entry]) => SENSITIVE_KEYS.has(key) || containsSensitiveField(entry),
  );
}

function validRevision(family, revision) {
  if (typeof revision !== "string") {
    return false;
  }
  if (family === "plugin") {
    return /^semver:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(revision);
  }
  if (family === "claw") {
    return revision === "schema:1";
  }
  return /^sha256:[a-f0-9]{16}$/u.test(revision);
}

function validDefinition(definition) {
  return (
    hasOnlyKeys(definition, DEFINITION_KEYS) &&
    FAMILIES.includes(definition.family) &&
    typeof definition.nativeId === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/u.test(definition.nativeId) &&
    validRevision(definition.family, definition.revision) &&
    typeof definition.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(definition.digest) &&
    isUniqueStringArray(definition.requiredSemantics) &&
    isUniqueStringArray(definition.optionalSemantics) &&
    definition.requiredSemantics.every(
      (semantic) => !definition.optionalSemantics.includes(semantic),
    )
  );
}

function validExpectedDefinition(definition) {
  return (
    hasOnlyKeys(definition, EXPECTED_DEFINITION_KEYS) &&
    FAMILIES.includes(definition.family) &&
    typeof definition.definitionId === "string" &&
    definition.definitionId.startsWith(`${definition.family}:`) &&
    validRevision(definition.family, definition.revision) &&
    typeof definition.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(definition.digest) &&
    ["blocked", "compatible"].includes(definition.status)
  );
}

function projectDefinitions(definitions) {
  return definitions
    .map(({ definitionId, digest, family, revision, status }) => ({
      definitionId,
      family,
      revision,
      digest,
      status,
    }))
    .toSorted((left, right) => left.definitionId.localeCompare(right.definitionId));
}

export function validateInertDefinitionCompatibility(input) {
  const failures = [];
  if (containsSensitiveField(input)) {
    failures.push({ code: "SensitiveFieldPresent" });
  }
  if (!hasOnlyKeys(input, INPUT_KEYS)) {
    failures.push({ code: "InputInvalid" });
  }

  const consumer = isRecord(input) && isRecord(input.consumer) ? input.consumer : {};
  if (
    !hasOnlyKeys(consumer, CONSUMER_KEYS) ||
    consumer.id !== "openclaw-typescript" ||
    consumer.contractVersion !== 1 ||
    !sameMembers(consumer.supportedSemantics, SUPPORTED_SEMANTICS)
  ) {
    failures.push({ code: "ConsumerContractMismatch" });
  }

  const definitions = isRecord(input) && Array.isArray(input.definitions) ? input.definitions : [];
  if (!Array.isArray(input?.definitions) || !definitions.every(validDefinition)) {
    failures.push({ code: "DefinitionInvalid" });
  }

  const supported = new Set(
    Array.isArray(consumer.supportedSemantics)
      ? consumer.supportedSemantics.filter((entry) => typeof entry === "string")
      : [],
  );
  const seenIds = new Set();
  const seenFamilies = [];
  const results = [];
  for (const definition of definitions.filter(validDefinition)) {
    const definitionId = `${definition.family}:${definition.nativeId}`;
    if (seenIds.has(definitionId)) {
      failures.push({ code: "DefinitionDuplicated", definitionId });
    }
    seenIds.add(definitionId);
    seenFamilies.push(definition.family);
    const unknownRequired = definition.requiredSemantics.filter(
      (semantic) => !supported.has(semantic),
    );
    const unknownOptional = definition.optionalSemantics.filter(
      (semantic) => !supported.has(semantic),
    );
    for (const semantic of [
      ...definition.requiredSemantics,
      ...definition.optionalSemantics,
    ].filter((entry) => supported.has(entry) && !entry.startsWith(`${definition.family}.`))) {
      failures.push({
        code: "SemanticOwnerMismatch",
        definitionId,
        semantic,
      });
    }
    for (const semantic of unknownRequired) {
      failures.push({
        code: "UnknownRequiredSemantic",
        definitionId,
        semantic,
      });
    }
    results.push({
      definitionId,
      family: definition.family,
      revision: definition.revision,
      digest: definition.digest,
      status: unknownRequired.length === 0 ? "compatible" : "blocked",
      unknownOptional,
      unknownRequired,
    });
  }

  if (!sameMembers(seenFamilies, FAMILIES)) {
    failures.push({ code: "DefinitionFamilySetMismatch" });
  }
  const expectedDefinitionIds =
    isRecord(input) && Array.isArray(input.expectedDefinitionIds)
      ? input.expectedDefinitionIds
      : [];
  if (!sameMembers([...seenIds], expectedDefinitionIds)) {
    failures.push({ code: "DefinitionIdentityMismatch" });
  }
  const preservedOptionalSemantics = results
    .flatMap((result) => result.unknownOptional)
    .toSorted((left, right) => left.localeCompare(right));
  if (preservedOptionalSemantics.length === 0) {
    failures.push({ code: "OptionalCompatibilityNotExercised" });
  }
  if (
    !isRecord(input) ||
    input.activationAttempted !== false ||
    input.mutationAttempted !== false
  ) {
    failures.push({ code: "PreActivationBoundaryViolated" });
  }
  if (!isRecord(input) || input.authority !== "none") {
    failures.push({ code: "AuthorityOverclaimed" });
  }

  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    authority: "none",
    activationAttempted: input?.activationAttempted === true,
    mutationAttempted: input?.mutationAttempted === true,
    definitions: results,
    preservedOptionalSemantics,
    failures,
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/inert-definition-compatibility-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (
    !hasOnlyKeys(fixture, new Set(["cases", "fixtureId", "schemaVersion"])) ||
    fixture.schemaVersion !== 1 ||
    fixture.fixtureId !== FIXTURE_ID ||
    !Array.isArray(fixture.cases) ||
    !sameMembers(
      fixture.cases.map((entry) => entry?.id),
      CASE_IDS,
    )
  ) {
    throw new Error("definition compatibility fixture envelope is invalid");
  }
  const cases = fixture.cases.map((entry) => {
    if (
      !hasOnlyKeys(entry, new Set(["expected", "id", "input"])) ||
      typeof entry.id !== "string" ||
      !hasOnlyKeys(
        entry.expected,
        new Set(["definitions", "failureCodes", "preservedOptionalSemantics", "status"]),
      ) ||
      !["accepted", "rejected"].includes(entry.expected.status) ||
      !Array.isArray(entry.expected.definitions) ||
      !entry.expected.definitions.every(validExpectedDefinition) ||
      !isUniqueStringArray(entry.expected.failureCodes) ||
      !isUniqueStringArray(entry.expected.preservedOptionalSemantics)
    ) {
      throw new Error("definition compatibility fixture case is invalid");
    }
    const result = validateInertDefinitionCompatibility(entry.input);
    const failureCodes = result.failures
      .map((failure) => failure.code)
      .toSorted((left, right) => left.localeCompare(right));
    const expectedCodes = Array.isArray(entry.expected.failureCodes)
      ? entry.expected.failureCodes.toSorted((left, right) => left.localeCompare(right))
      : [];
    if (
      result.status !== entry.expected.status ||
      JSON.stringify(failureCodes) !== JSON.stringify(expectedCodes) ||
      JSON.stringify(projectDefinitions(result.definitions)) !==
        JSON.stringify(projectDefinitions(entry.expected.definitions)) ||
      JSON.stringify(result.preservedOptionalSemantics) !==
        JSON.stringify(entry.expected.preservedOptionalSemantics)
    ) {
      throw new Error(`Fixture case ${entry.id} did not match its expected result`);
    }
    return { id: entry.id, result };
  });
  return { schemaVersion: 1, fixtureId: FIXTURE_ID, cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runFixture(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
