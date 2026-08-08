import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.dgr.restart-safe-bounded-lease.v1";
const RESOURCE_REF = /^sha256:[a-f0-9]{64}$/u;
const HOLDER_REF = /^hmac-sha256:v1:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9:._-]{0,127}$/u;
const INPUT_KEYS = new Set(["schemaVersion", "evidenceType", "resource", "events", "final"]);
const RESOURCE_KEYS = new Set(["resourceId", "owner", "capacity", "unit"]);
const FINAL_KEYS = new Set(["activeLeaseIds", "settledLeaseIds", "capacityInUse", "reconciles"]);
const EVENT_KEYS = {
  acquire: new Set([
    "sequence",
    "type",
    "operationId",
    "leaseId",
    "generation",
    "holderRef",
    "quantity",
    "at",
    "expiresAt",
    "outcome",
    "reason",
    "retryAfter",
  ]),
  restart: new Set(["sequence", "type", "at", "runtimeGeneration", "persistedLeaseIds"]),
  assert: new Set([
    "sequence",
    "type",
    "leaseId",
    "generation",
    "holderRef",
    "at",
    "outcome",
    "reason",
    "currentGeneration",
  ]),
  renew: new Set([
    "sequence",
    "type",
    "leaseId",
    "generation",
    "holderRef",
    "at",
    "expiresAt",
    "outcome",
  ]),
  expire: new Set(["sequence", "type", "leaseId", "generation", "at", "outcome"]),
  release: new Set(["sequence", "type", "leaseId", "generation", "holderRef", "at", "outcome"]),
  settle: new Set(["sequence", "type", "leaseId", "generation", "at", "outcome", "quantity"]),
};

function hasOnlyKeys(value, allowedKeys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function validIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every(validIdentifier) &&
    JSON.stringify([...actual].toSorted()) === JSON.stringify([...expected].toSorted())
  );
}

export function validateRestartSafeBoundedLeaseEvidence(input) {
  const failures = [];
  const seenFailureCodes = new Set();
  const fail = (code, event) => {
    if (seenFailureCodes.has(code)) {
      return;
    }
    seenFailureCodes.add(code);
    failures.push({
      code,
      ...(Number.isInteger(event?.sequence) ? { sequence: event.sequence } : {}),
      ...(validIdentifier(event?.leaseId) ? { leaseId: event.leaseId } : {}),
      ...(validIdentifier(event?.operationId) ? { operationId: event.operationId } : {}),
    });
  };
  const resource = input?.resource;
  const events = Array.isArray(input?.events) ? input.events : [];
  const final = input?.final;

  if (
    input?.schemaVersion !== 1 ||
    input?.evidenceType !== "resource.bounded_lease" ||
    !hasOnlyKeys(input, INPUT_KEYS) ||
    !hasOnlyKeys(resource, RESOURCE_KEYS) ||
    !hasOnlyKeys(final, FINAL_KEYS) ||
    !Array.isArray(input?.events)
  ) {
    fail("ContractMismatch");
  }
  if (
    !RESOURCE_REF.test(resource?.resourceId ?? "") ||
    resource?.owner !== "openclaw-state-lease" ||
    resource?.capacity !== 1 ||
    resource?.unit !== "slot" ||
    events.some((event) => {
      const allowedKeys = EVENT_KEYS[event?.type];
      return (
        !allowedKeys ||
        !hasOnlyKeys(event, allowedKeys) ||
        (event.holderRef !== undefined && !HOLDER_REF.test(event.holderRef)) ||
        (event.runtimeGeneration !== undefined && !RESOURCE_REF.test(event.runtimeGeneration ?? ""))
      );
    })
  ) {
    fail("SensitivePayloadPresent");
  }

  const active = new Map();
  const operationLeases = new Map();
  const knownLeases = new Map();
  const pendingSettlements = new Map();
  const settled = new Set();
  let previousAt = -1;
  let currentGeneration = 0;
  let restartCount = 0;
  let exhaustionCount = 0;
  let existingAcquisitionCount = 0;
  let fencedCount = 0;

  for (const [index, event] of events.entries()) {
    if (
      event?.sequence !== index + 1 ||
      !Number.isInteger(event?.at) ||
      event.at < 0 ||
      event.at < previousAt
    ) {
      fail("EventOrderInvalid", event);
    }
    if (Number.isInteger(event?.at)) {
      previousAt = Math.max(previousAt, event.at);
    }

    if (event?.type === "acquire") {
      const identityValid =
        validIdentifier(event.operationId) &&
        HOLDER_REF.test(event.holderRef ?? "") &&
        event.quantity === 1 &&
        Number.isInteger(event.generation) &&
        event.generation > 0;
      if (!identityValid) {
        fail("OperationIdentityInvalid", event);
        continue;
      }
      const existingLeaseId = operationLeases.get(event.operationId);
      if (event.outcome === "admitted") {
        if (
          existingLeaseId !== undefined ||
          !validIdentifier(event.leaseId) ||
          knownLeases.has(event.leaseId) ||
          !Number.isInteger(event.expiresAt) ||
          event.expiresAt <= event.at
        ) {
          fail("OperationIdentityInvalid", event);
        }
        if (active.size >= resource?.capacity) {
          fail("CapacityExceeded", event);
        }
        if (event.generation !== currentGeneration + 1) {
          fail("LeaseGenerationInvalid", event);
        }
        if (
          existingLeaseId === undefined &&
          validIdentifier(event.leaseId) &&
          !knownLeases.has(event.leaseId) &&
          active.size < resource?.capacity
        ) {
          const lease = {
            leaseId: event.leaseId,
            operationId: event.operationId,
            generation: event.generation,
            holderRef: event.holderRef,
            expiresAt: event.expiresAt,
          };
          active.set(event.leaseId, lease);
          knownLeases.set(event.leaseId, lease);
          operationLeases.set(event.operationId, event.leaseId);
          currentGeneration = event.generation;
        }
      } else if (event.outcome === "existing") {
        const lease = knownLeases.get(existingLeaseId);
        if (
          !lease ||
          event.leaseId !== existingLeaseId ||
          event.generation !== lease.generation ||
          event.holderRef !== lease.holderRef ||
          event.expiresAt !== lease.expiresAt ||
          !active.has(existingLeaseId)
        ) {
          fail("OperationIdentityInvalid", event);
        } else {
          existingAcquisitionCount += 1;
        }
      } else if (event.outcome === "exhausted") {
        if (
          active.size < resource?.capacity ||
          event.leaseId !== null ||
          event.reason !== "capacity_exhausted" ||
          !Number.isInteger(event.retryAfter) ||
          event.retryAfter <= event.at ||
          event.generation !== currentGeneration
        ) {
          fail("ExhaustionInvalid", event);
        } else {
          exhaustionCount += 1;
        }
      } else {
        fail("OperationIdentityInvalid", event);
      }
      continue;
    }

    if (event?.type === "restart") {
      restartCount += 1;
      if (
        !RESOURCE_REF.test(event.runtimeGeneration ?? "") ||
        !sameStringSet(event.persistedLeaseIds, active.keys())
      ) {
        fail("RestartStateMismatch", event);
      }
      continue;
    }

    if (event?.type === "assert") {
      const lease = active.get(event.leaseId);
      const stale =
        !lease ||
        lease.generation !== event.generation ||
        lease.holderRef !== event.holderRef ||
        event.generation !== currentGeneration;
      if (
        !stale ||
        event.outcome !== "fenced" ||
        event.reason !== "stale_generation" ||
        event.currentGeneration !== currentGeneration
      ) {
        fail("StaleHolderNotFenced", event);
      } else {
        fencedCount += 1;
      }
      continue;
    }

    if (event?.type === "renew") {
      const lease = active.get(event.leaseId);
      if (
        !lease ||
        event.outcome !== "renewed" ||
        event.generation !== lease.generation ||
        event.holderRef !== lease.holderRef ||
        event.generation !== currentGeneration ||
        !Number.isInteger(event.expiresAt) ||
        event.expiresAt <= lease.expiresAt ||
        event.expiresAt <= event.at
      ) {
        fail("RenewalInvalid", event);
      } else {
        lease.expiresAt = event.expiresAt;
      }
      continue;
    }

    if (event?.type === "expire" || event?.type === "release") {
      const lease = active.get(event.leaseId);
      const expectedOutcome = event.type === "expire" ? "expired" : "released";
      const validTerminal =
        lease &&
        event.generation === lease.generation &&
        event.generation === currentGeneration &&
        event.outcome === expectedOutcome &&
        (event.type !== "expire" || event.at >= lease.expiresAt) &&
        (event.type !== "release" || event.holderRef === lease.holderRef);
      if (!validTerminal) {
        fail("LeaseTerminationInvalid", event);
      } else {
        active.delete(event.leaseId);
        pendingSettlements.set(event.leaseId, expectedOutcome);
      }
      continue;
    }

    if (event?.type === "settle") {
      const lease = knownLeases.get(event.leaseId);
      const expectedOutcome = pendingSettlements.get(event.leaseId);
      if (
        !lease ||
        expectedOutcome === undefined ||
        settled.has(event.leaseId) ||
        event.generation !== lease.generation ||
        event.outcome !== expectedOutcome ||
        event.quantity !== 1
      ) {
        fail("TerminalSettlementInvalid", event);
      } else {
        pendingSettlements.delete(event.leaseId);
        settled.add(event.leaseId);
      }
      continue;
    }

    fail("ContractMismatch", event);
  }

  if (pendingSettlements.size > 0 || [...knownLeases.keys()].some((id) => !settled.has(id))) {
    fail("TerminalSettlementInvalid");
  }
  if (
    !sameStringSet(final?.activeLeaseIds, active.keys()) ||
    !sameStringSet(final?.settledLeaseIds, settled) ||
    final?.capacityInUse !== active.size ||
    final?.reconciles !== true
  ) {
    fail("FinalStateMismatch");
  }
  if (restartCount < 1 || exhaustionCount < 1 || existingAcquisitionCount < 1 || fencedCount < 1) {
    fail("ProofIncomplete");
  }

  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    failures,
    reconciliation: {
      capacity: resource?.capacity,
      capacityInUse: active.size,
      leaseCount: knownLeases.size,
      settledLeaseCount: settled.size,
      restartCount,
      exhaustionCount,
      existingAcquisitionCount,
      fencedCount,
    },
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/restart-safe-bounded-lease-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const cases = fixture.cases.map((entry) => {
    const result = validateRestartSafeBoundedLeaseEvidence(entry.input);
    const failureCodes = result.failures.map((failure) => failure.code).toSorted();
    const expectedCodes = (entry.expected.failureCodes ?? []).toSorted();
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
