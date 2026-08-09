import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.kcc.mixed-owner-checkpoint-copy-facts.v1";
const HASH_REF = /^sha256:[a-f0-9]{64}$/u;
const COPY_REF = /^hmac-sha256:v1:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9:._-]{0,127}$/u;
const INPUT_KEYS = new Set([
  "schemaVersion",
  "evidenceType",
  "checkpointAttempts",
  "copyInventory",
  "copySettlements",
  "final",
]);
const ATTEMPT_KEYS = new Set([
  "sequence",
  "attemptId",
  "requiredOwnerIds",
  "ownerFacts",
  "outcome",
  "reason",
]);
const OWNER_FACT_KEYS = new Set([
  "ownerId",
  "sourceGeneration",
  "manifestRef",
  "artifactRef",
  "compatibility",
  "consistency",
  "outcome",
  "reason",
]);
const COPY_INVENTORY_KEYS = new Set(["sourceGeneration", "expectedOwnerIds"]);
const COPY_SETTLEMENT_KEYS = new Set([
  "ownerId",
  "copyId",
  "copyClass",
  "control",
  "sourceRef",
  "evidenceRef",
  "settlement",
  "retentionRef",
  "expiresAt",
]);
const FINAL_KEYS = new Set([
  "acceptedCheckpointId",
  "copyStatus",
  "assuranceComplete",
  "reportedOwnerIds",
  "counts",
  "reconciles",
]);
const COUNT_KEYS = new Set(["complete", "retained", "externallyControlled", "unknown"]);
const COPY_CLASSES = new Set([
  "canonical",
  "index",
  "derived",
  "export",
  "archive",
  "backup",
  "external",
  "delegated",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function validIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validIdentifierList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(validIdentifier) &&
    new Set(value).size === value.length
  );
}

function sameStringSet(actual, expected) {
  return (
    validIdentifierList(actual) &&
    JSON.stringify([...actual].toSorted((a, b) => a.localeCompare(b))) ===
      JSON.stringify([...expected].toSorted((a, b) => a.localeCompare(b)))
  );
}

function expectedRefusalReason(fact) {
  if (fact?.consistency === "dirty") {
    return "dirty_state";
  }
  if (fact?.compatibility === "incompatible") {
    return "incompatible_version";
  }
  return "state_unknown";
}

function validOwnerFactShape(fact) {
  return (
    hasOnlyKeys(fact, OWNER_FACT_KEYS) &&
    validIdentifier(fact.ownerId) &&
    HASH_REF.test(fact.sourceGeneration ?? "") &&
    HASH_REF.test(fact.manifestRef ?? "") &&
    HASH_REF.test(fact.artifactRef ?? "") &&
    ["compatible", "incompatible", "unknown"].includes(fact.compatibility) &&
    ["clean", "dirty", "unknown"].includes(fact.consistency) &&
    ["included", "refused"].includes(fact.outcome)
  );
}

function validCopySettlementShape(settlement) {
  return (
    hasOnlyKeys(settlement, COPY_SETTLEMENT_KEYS) &&
    validIdentifier(settlement.ownerId) &&
    COPY_REF.test(settlement.copyId ?? "") &&
    COPY_CLASSES.has(settlement.copyClass) &&
    ["local", "external", "unknown"].includes(settlement.control) &&
    HASH_REF.test(settlement.sourceRef ?? "") &&
    HASH_REF.test(settlement.evidenceRef ?? "") &&
    ["complete", "retained", "externally_controlled", "unknown"].includes(settlement.settlement)
  );
}

export function validateMixedOwnerCheckpointCopyFacts(input) {
  const failures = [];
  const seenFailureCodes = new Set();
  const fail = (code, details) => {
    if (seenFailureCodes.has(code)) {
      return;
    }
    seenFailureCodes.add(code);
    failures.push({
      code,
      ...(Number.isInteger(details?.sequence) ? { sequence: details.sequence } : {}),
      ...(validIdentifier(details?.attemptId) ? { attemptId: details.attemptId } : {}),
      ...(validIdentifier(details?.ownerId) ? { ownerId: details.ownerId } : {}),
    });
  };
  const attempts = Array.isArray(input?.checkpointAttempts) ? input.checkpointAttempts : [];
  const inventory = input?.copyInventory;
  const settlements = Array.isArray(input?.copySettlements) ? input.copySettlements : [];
  const final = input?.final;

  if (
    input?.schemaVersion !== 1 ||
    input?.evidenceType !== "knowledge.checkpoint_copy_facts" ||
    !hasOnlyKeys(input, INPUT_KEYS) ||
    !Array.isArray(input?.checkpointAttempts) ||
    !Array.isArray(input?.copySettlements) ||
    !hasOnlyKeys(inventory, COPY_INVENTORY_KEYS) ||
    !hasOnlyKeys(final, FINAL_KEYS) ||
    !hasOnlyKeys(final?.counts, COUNT_KEYS)
  ) {
    fail("ContractMismatch");
  }
  if (
    attempts.some(
      (attempt) =>
        !hasOnlyKeys(attempt, ATTEMPT_KEYS) ||
        !Array.isArray(attempt?.ownerFacts) ||
        attempt.ownerFacts.some((fact) => !hasOnlyKeys(fact, OWNER_FACT_KEYS)),
    ) ||
    settlements.some((settlement) => !hasOnlyKeys(settlement, COPY_SETTLEMENT_KEYS))
  ) {
    fail("SensitivePayloadPresent");
  }

  const attemptIds = new Set();
  const acceptedAttempts = [];
  const dirtyRefusalSequences = [];

  for (const [index, attempt] of attempts.entries()) {
    const ownerFacts = Array.isArray(attempt?.ownerFacts) ? attempt.ownerFacts : [];
    if (
      attempt?.sequence !== index + 1 ||
      !validIdentifier(attempt?.attemptId) ||
      attemptIds.has(attempt?.attemptId)
    ) {
      fail("CheckpointOrderInvalid", attempt);
    } else {
      attemptIds.add(attempt.attemptId);
    }

    const requiredOwnerIds = validIdentifierList(attempt?.requiredOwnerIds)
      ? attempt.requiredOwnerIds
      : [];
    const factOwnerIds = [];
    let hasDirty = false;
    let hasIncompatible = false;
    let hasUnknown = false;

    for (const fact of ownerFacts) {
      if (!validOwnerFactShape(fact) || factOwnerIds.includes(fact?.ownerId)) {
        fail("CheckpointOwnerFactInvalid", { ...attempt, ownerId: fact?.ownerId });
        continue;
      }
      factOwnerIds.push(fact.ownerId);
      hasDirty ||= fact.consistency === "dirty";
      hasIncompatible ||= fact.compatibility === "incompatible";
      hasUnknown ||= fact.consistency === "unknown" || fact.compatibility === "unknown";
      const canInclude = fact.consistency === "clean" && fact.compatibility === "compatible";
      if (canInclude) {
        if (fact.outcome !== "included" || fact.reason !== undefined) {
          fail("CheckpointOwnerFactInvalid", { ...attempt, ownerId: fact.ownerId });
        }
      } else if (fact.outcome !== "refused" || fact.reason !== expectedRefusalReason(fact)) {
        if (fact.consistency === "dirty" && fact.outcome === "included") {
          fail("DirtyCheckpointAdmitted", { ...attempt, ownerId: fact.ownerId });
        } else if (fact.compatibility === "incompatible" && fact.outcome === "included") {
          fail("IncompatibleCheckpointAdmitted", { ...attempt, ownerId: fact.ownerId });
        } else if (fact.outcome === "included") {
          fail("UnknownCheckpointAdmitted", { ...attempt, ownerId: fact.ownerId });
        } else {
          fail("CheckpointOwnerFactInvalid", { ...attempt, ownerId: fact.ownerId });
        }
      }
    }

    if (!sameStringSet(factOwnerIds, requiredOwnerIds)) {
      fail("CheckpointInventoryMismatch", attempt);
    }

    if (attempt?.outcome === "accepted") {
      if (hasDirty) {
        fail("DirtyCheckpointAdmitted", attempt);
      }
      if (hasIncompatible) {
        fail("IncompatibleCheckpointAdmitted", attempt);
      }
      if (hasUnknown) {
        fail("UnknownCheckpointAdmitted", attempt);
      }
      if (
        attempt.reason !== undefined ||
        ownerFacts.some((fact) => fact?.outcome !== "included") ||
        requiredOwnerIds.length === 0
      ) {
        fail("CheckpointOutcomeInvalid", attempt);
      }
      if (
        !hasDirty &&
        !hasIncompatible &&
        !hasUnknown &&
        attempt.reason === undefined &&
        ownerFacts.every((fact) => fact?.outcome === "included") &&
        requiredOwnerIds.length > 0 &&
        sameStringSet(factOwnerIds, requiredOwnerIds)
      ) {
        acceptedAttempts.push(attempt);
      }
    } else if (attempt?.outcome === "refused") {
      const expectedReason = hasDirty
        ? "dirty_owner"
        : hasIncompatible
          ? "incompatible_owner"
          : "owner_state_unknown";
      if (
        (!hasDirty && !hasIncompatible && !hasUnknown) ||
        attempt.reason !== expectedReason ||
        ownerFacts.every((fact) => fact?.outcome === "included")
      ) {
        fail("CheckpointOutcomeInvalid", attempt);
      }
      if (hasDirty && attempt.reason === "dirty_owner") {
        dirtyRefusalSequences.push(attempt.sequence);
      }
    } else {
      fail("CheckpointOutcomeInvalid", attempt);
    }
  }

  const acceptedSequence =
    acceptedAttempts.length === 1 ? acceptedAttempts[0]?.sequence : undefined;
  if (
    !Number.isInteger(acceptedSequence) ||
    !dirtyRefusalSequences.some((sequence) => sequence < acceptedSequence)
  ) {
    fail("DirtyRefusalMissing");
  }
  if (acceptedAttempts.length !== 1) {
    fail("CompatibleCheckpointMissing");
  }

  const expectedOwnerIds = validIdentifierList(inventory?.expectedOwnerIds)
    ? inventory.expectedOwnerIds
    : [];
  if (!HASH_REF.test(inventory?.sourceGeneration ?? "") || expectedOwnerIds.length === 0) {
    fail("CopyInventoryMismatch");
  }

  const reportedOwnerIds = [];
  const counts = {
    complete: 0,
    retained: 0,
    externallyControlled: 0,
    unknown: 0,
  };

  for (const settlement of settlements) {
    if (!validCopySettlementShape(settlement) || reportedOwnerIds.includes(settlement?.ownerId)) {
      fail("CopySettlementInvalid", settlement);
      continue;
    }
    reportedOwnerIds.push(settlement.ownerId);
    if (settlement.sourceRef !== inventory?.sourceGeneration) {
      fail("CopySettlementInvalid", settlement);
    }

    if (settlement.settlement === "complete") {
      counts.complete += 1;
      if (
        settlement.control !== "local" ||
        !["canonical", "index", "derived"].includes(settlement.copyClass) ||
        settlement.retentionRef !== undefined ||
        settlement.expiresAt !== undefined
      ) {
        fail("CopySettlementInvalid", settlement);
      }
    } else if (settlement.settlement === "retained") {
      counts.retained += 1;
      if (
        settlement.control !== "local" ||
        !["export", "archive", "backup"].includes(settlement.copyClass) ||
        !HASH_REF.test(settlement.retentionRef ?? "") ||
        !Number.isInteger(settlement.expiresAt) ||
        settlement.expiresAt <= 0
      ) {
        fail("CopySettlementInvalid", settlement);
      }
    } else if (settlement.settlement === "externally_controlled") {
      counts.externallyControlled += 1;
      if (
        settlement.control !== "external" ||
        settlement.copyClass !== "external" ||
        settlement.retentionRef !== undefined ||
        settlement.expiresAt !== undefined
      ) {
        fail("CopySettlementInvalid", settlement);
      }
    } else {
      counts.unknown += 1;
      if (
        settlement.control !== "unknown" ||
        settlement.copyClass !== "delegated" ||
        settlement.retentionRef !== undefined ||
        settlement.expiresAt !== undefined
      ) {
        fail("CopySettlementInvalid", settlement);
      }
    }
  }

  if (!sameStringSet(reportedOwnerIds, expectedOwnerIds)) {
    fail("CopyInventoryMismatch");
  }

  const expectedCopyStatus =
    settlements.length > 0 && settlements.every((entry) => entry?.settlement === "complete")
      ? "complete"
      : "partial";
  const expectedAssuranceComplete = expectedCopyStatus === "complete";
  const acceptedCheckpointId =
    acceptedAttempts.length === 1 ? acceptedAttempts[0]?.attemptId : undefined;
  if (final?.copyStatus !== expectedCopyStatus) {
    fail("CopyOutcomeInvalid");
  }
  if (final?.assuranceComplete === true && !expectedAssuranceComplete) {
    fail("AssuranceOverclaimed");
  }
  if (
    final?.acceptedCheckpointId !== acceptedCheckpointId ||
    final?.assuranceComplete !== expectedAssuranceComplete ||
    !sameStringSet(final?.reportedOwnerIds, reportedOwnerIds) ||
    final?.counts?.complete !== counts.complete ||
    final?.counts?.retained !== counts.retained ||
    final?.counts?.externallyControlled !== counts.externallyControlled ||
    final?.counts?.unknown !== counts.unknown ||
    final?.reconciles !== true
  ) {
    fail("FinalStateMismatch");
  }

  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    failures,
    reconciliation: {
      attemptCount: attempts.length,
      dirtyRefusalCount: dirtyRefusalSequences.length,
      acceptedCheckpointCount: acceptedAttempts.length,
      expectedCopyOwnerCount: expectedOwnerIds.length,
      reportedCopyOwnerCount: reportedOwnerIds.length,
      counts,
      copyStatus: expectedCopyStatus,
      assuranceComplete: expectedAssuranceComplete,
    },
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/mixed-owner-checkpoint-copy-facts-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const cases = fixture.cases.map((entry) => {
    const result = validateMixedOwnerCheckpointCopyFacts(entry.input);
    const failureCodes = result.failures
      .map((failure) => failure.code)
      .toSorted((a, b) => a.localeCompare(b));
    const expectedCodes = (entry.expected.failureCodes ?? []).toSorted((a, b) =>
      a.localeCompare(b),
    );
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
