import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.kcc.mixed-owner-restore-composition.v1";
const CASE_IDS = ["incompatible-agent-blocks-entire-set", "verified-current-owner-set-is-ready"];
const FIXTURE_KEYS = new Set(["cases", "fixtureId", "owner", "schemaVersion"]);
const OWNER_KEYS = new Set(["id", "publicationAtomicity", "restoreMode", "supportedSchemas"]);
const SUPPORTED_SCHEMA_KEYS = new Set(["agent", "global"]);
const INPUT_KEYS = new Set(["authority", "publicationAttempted", "requiredOwners", "snapshots"]);
const SNAPSHOT_KEYS = new Set([
  "digest",
  "owner",
  "schemaVersion",
  "sizeBytes",
  "snapshotId",
  "targetFresh",
  "verified",
]);
const EXPECTED_KEYS = new Set(["failure", "readiness", "status"]);
const REQUIRED_OWNERS = ["agent:ops-team", "global"];
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SENSITIVE_KEYS = new Set([
  "auth",
  "authorization",
  "credential",
  "databasePath",
  "password",
  "path",
  "payload",
  "secret",
  "token",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
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

function stable(value) {
  return JSON.stringify(value);
}

function sortedStrings(value) {
  return Array.isArray(value)
    ? value.map(String).toSorted((left, right) => left.localeCompare(right))
    : [];
}

function validOwner(owner) {
  return (
    hasOnlyKeys(owner, OWNER_KEYS) &&
    owner.id === "openclaw-typescript-sqlite-snapshot" &&
    hasOnlyKeys(owner.supportedSchemas, SUPPORTED_SCHEMA_KEYS) &&
    owner.supportedSchemas.global === 6 &&
    owner.supportedSchemas.agent === 16 &&
    owner.restoreMode === "fresh-only" &&
    owner.publicationAtomicity === "per-owner-only"
  );
}

function schemaOwner(ownerId) {
  if (ownerId === "global") {
    return "global";
  }
  return typeof ownerId === "string" && /^agent:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(ownerId)
    ? "agent"
    : null;
}

function validSnapshot(snapshot) {
  return (
    hasOnlyKeys(snapshot, SNAPSHOT_KEYS) &&
    schemaOwner(snapshot.owner) !== null &&
    HASH_PATTERN.test(snapshot.snapshotId) &&
    Number.isInteger(snapshot.schemaVersion) &&
    snapshot.schemaVersion > 0 &&
    typeof snapshot.verified === "boolean" &&
    typeof snapshot.targetFresh === "boolean" &&
    HASH_PATTERN.test(snapshot.digest) &&
    Number.isSafeInteger(snapshot.sizeBytes) &&
    snapshot.sizeBytes > 0
  );
}

export function validateMixedOwnerRestoreComposition(input, owner) {
  const failures = [];
  if (containsSensitiveField(input)) {
    failures.push({ code: "SensitiveFieldPresent" });
  }
  if (!hasOnlyKeys(input, INPUT_KEYS)) {
    failures.push({ code: "InputInvalid" });
  }
  if (!validOwner(owner)) {
    failures.push({ code: "OwnerContractMismatch" });
  }

  const requiredOwners = sortedStrings(input?.requiredOwners);
  if (
    stable(requiredOwners) !== stable(REQUIRED_OWNERS) ||
    new Set(requiredOwners).size !== requiredOwners.length
  ) {
    failures.push({ code: "RequiredOwnerInventoryMismatch" });
  }

  const snapshots = Array.isArray(input?.snapshots) ? input.snapshots : [];
  if (!Array.isArray(input?.snapshots) || !snapshots.every(validSnapshot)) {
    failures.push({ code: "SnapshotFactsInvalid" });
  }
  const snapshotOwners = sortedStrings(snapshots.map((snapshot) => snapshot?.owner));
  if (
    stable(snapshotOwners) !== stable(REQUIRED_OWNERS) ||
    new Set(snapshotOwners).size !== snapshotOwners.length
  ) {
    failures.push({ code: "SnapshotOwnerInventoryMismatch" });
  }

  if (input?.publicationAttempted !== false) {
    failures.push({ code: "PreflightBoundaryViolated" });
  }
  if (input?.authority !== "none") {
    failures.push({ code: "AuthorityOverclaimed" });
  }

  if (validOwner(owner)) {
    for (const snapshot of snapshots.filter(validSnapshot)) {
      const kind = schemaOwner(snapshot.owner);
      const supportedSchemaVersion = kind ? owner.supportedSchemas[kind] : undefined;
      if (snapshot.schemaVersion !== supportedSchemaVersion) {
        failures.push({
          code: "OwnerSchemaIncompatible",
          owner: snapshot.owner,
          actualSchemaVersion: snapshot.schemaVersion,
          supportedSchemaVersion,
        });
      }
      if (!snapshot.verified) {
        failures.push({ code: "SnapshotUnverified", owner: snapshot.owner });
      }
      if (!snapshot.targetFresh) {
        failures.push({ code: "RestoreTargetNotFresh", owner: snapshot.owner });
      }
    }
  }

  const failure =
    failures.find((entry) => entry.code === "OwnerSchemaIncompatible") ?? failures[0] ?? null;
  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    authority: "none",
    owner: "openclaw-typescript-sqlite-snapshot",
    readiness: failures.length === 0 ? "ready-for-owner-native-restore" : "blocked",
    publicationAttempted: input?.publicationAttempted === true,
    crossOwnerAtomicPublicationProven: false,
    failure,
    failures,
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/mixed-owner-restore-composition-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (
    !hasOnlyKeys(fixture, FIXTURE_KEYS) ||
    fixture.schemaVersion !== 1 ||
    fixture.fixtureId !== FIXTURE_ID ||
    !validOwner(fixture.owner) ||
    !Array.isArray(fixture.cases) ||
    stable(sortedStrings(fixture.cases.map((entry) => entry?.id))) !== stable(CASE_IDS)
  ) {
    throw new Error("mixed-owner restore composition fixture envelope is invalid");
  }

  const cases = fixture.cases.map((entry) => {
    if (
      !hasOnlyKeys(entry, new Set(["expected", "id", "input"])) ||
      !hasOnlyKeys(entry.expected, EXPECTED_KEYS)
    ) {
      throw new Error("mixed-owner restore composition fixture case is invalid");
    }
    const result = validateMixedOwnerRestoreComposition(entry.input, fixture.owner);
    const actual = {
      status: result.status,
      readiness: result.readiness,
      failure: result.failure,
    };
    if (stable(actual) !== stable(entry.expected)) {
      throw new Error(`Fixture case ${entry.id} did not match its expected result`);
    }
    return { id: entry.id, result };
  });

  return {
    schemaVersion: 1,
    fixtureId: FIXTURE_ID,
    owner: fixture.owner.id,
    cases,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runFixture(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
