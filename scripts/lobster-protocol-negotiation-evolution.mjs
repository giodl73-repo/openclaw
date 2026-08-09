import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.rfn.protocol-negotiation-evolution.v1";
const CASE_IDS = [
  "adjacent-node-protocol-is-role-bounded",
  "adjacent-operator-protocol-is-refused",
];
const OWNER_KEYS = new Set([
  "compatibilityWindow",
  "currentProtocol",
  "id",
  "minimumClientProtocol",
  "minimumNodeProtocol",
  "minimumProbeProtocol",
  "releaseDuration",
]);
const INPUT_KEYS = new Set([
  "authority",
  "maxProtocol",
  "minProtocol",
  "mode",
  "role",
  "runtimeMutationAttempted",
]);
const IMPLEMENTATION_KEYS = new Set([
  "evidence",
  "id",
  "language",
  "maxProtocol",
  "minProtocol",
  "role",
]);
const EXPECTED_IMPLEMENTATIONS = [
  {
    id: "kotlin-android-node",
    language: "kotlin",
    role: "node",
    minProtocol: 3,
    maxProtocol: 4,
    evidence: "constant-guard",
  },
  {
    id: "rust-linux-quick-chat",
    language: "rust",
    role: "operator",
    minProtocol: 4,
    maxProtocol: 4,
    evidence: "current-only-source",
  },
  {
    id: "swift-openclaw-kit",
    language: "swift",
    role: "node",
    minProtocol: 3,
    maxProtocol: 4,
    evidence: "constant-guard",
  },
];
const SENSITIVE_KEYS = new Set([
  "auth",
  "authorization",
  "credential",
  "password",
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

function validOwner(owner) {
  return (
    hasOnlyKeys(owner, OWNER_KEYS) &&
    owner.id === "openclaw-typescript-gateway" &&
    owner.currentProtocol === 4 &&
    owner.minimumClientProtocol === 4 &&
    owner.minimumNodeProtocol === 3 &&
    owner.minimumProbeProtocol === 3 &&
    owner.compatibilityWindow === "role-bounded-current-and-previous" &&
    owner.releaseDuration === "undeclared"
  );
}

function normalizedImplementations(value) {
  if (!Array.isArray(value) || !value.every((entry) => hasOnlyKeys(entry, IMPLEMENTATION_KEYS))) {
    return [];
  }
  return value
    .map((entry) => ({ ...entry }))
    .toSorted((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function validateProtocolNegotiation(input, owner) {
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

  const minProtocol = input?.minProtocol;
  const maxProtocol = input?.maxProtocol;
  if (
    !Number.isInteger(minProtocol) ||
    !Number.isInteger(maxProtocol) ||
    minProtocol < 1 ||
    maxProtocol < minProtocol
  ) {
    failures.push({ code: "ProtocolRangeInvalid" });
  }
  if (input?.runtimeMutationAttempted !== false) {
    failures.push({ code: "PreAdmissionBoundaryViolated" });
  }
  if (input?.authority !== "none") {
    failures.push({ code: "AuthorityOverclaimed" });
  }

  const current = owner?.currentProtocol;
  const supportsCurrent =
    Number.isInteger(current) && maxProtocol >= current && minProtocol <= current;
  const supportsProbe =
    input?.mode === "probe" && maxProtocol >= owner?.minimumProbeProtocol && minProtocol <= current;
  const supportsPreviousNode =
    input?.role === "node" &&
    input?.mode === "node" &&
    maxProtocol >= owner?.minimumNodeProtocol &&
    minProtocol <= owner?.minimumNodeProtocol;
  const wouldAdmit = supportsCurrent || supportsProbe || supportsPreviousNode;
  const compatibilityMode = supportsCurrent
    ? "current"
    : supportsProbe
      ? "legacy-probe"
      : supportsPreviousNode
        ? "legacy-node"
        : "none";

  let failure = null;
  if (!wouldAdmit && validOwner(owner)) {
    failure = {
      code: "PROTOCOL_MISMATCH",
      clientMinProtocol: minProtocol,
      clientMaxProtocol: maxProtocol,
      expectedProtocol: owner.currentProtocol,
      minimumProbeProtocol: owner.minimumProbeProtocol,
    };
    failures.push(failure);
  }

  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    authority: "none",
    owner: "openclaw-typescript-gateway",
    compatibilityMode,
    emittedProtocol: wouldAdmit && failures.length === 0 ? current : null,
    runtimeMutationAttempted: input?.runtimeMutationAttempted === true,
    releaseDuration: "undeclared",
    rustAdjacentVersionProven: false,
    failure,
    failures,
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/protocol-negotiation-evolution-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (
    !hasOnlyKeys(
      fixture,
      new Set(["cases", "fixtureId", "implementationEvidence", "owner", "schemaVersion"]),
    ) ||
    fixture.schemaVersion !== 1 ||
    fixture.fixtureId !== FIXTURE_ID ||
    !validOwner(fixture.owner) ||
    stable(normalizedImplementations(fixture.implementationEvidence)) !==
      stable(EXPECTED_IMPLEMENTATIONS) ||
    !Array.isArray(fixture.cases) ||
    stable(
      fixture.cases
        .map((entry) => entry?.id)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ) !== stable(CASE_IDS.toSorted((left, right) => left.localeCompare(right)))
  ) {
    throw new Error("protocol negotiation fixture envelope is invalid");
  }

  const cases = fixture.cases.map((entry) => {
    if (
      !hasOnlyKeys(entry, new Set(["expected", "id", "input"])) ||
      !hasOnlyKeys(
        entry.expected,
        new Set(["compatibilityMode", "emittedProtocol", "failure", "status"]),
      )
    ) {
      throw new Error("protocol negotiation fixture case is invalid");
    }
    const result = validateProtocolNegotiation(entry.input, fixture.owner);
    const actual = {
      status: result.status,
      compatibilityMode: result.compatibilityMode,
      emittedProtocol: result.emittedProtocol,
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
    implementationEvidence: normalizedImplementations(fixture.implementationEvidence),
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
