import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.rfn.remote-node-invocation-trust.v1";
const HASH_REF = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_REF = /^hmac-sha256:v1:[a-f0-9]{64}$/u;
const COMMAND = /^[a-z][a-z0-9._-]{0,63}$/u;
const INPUT_KEYS = new Set(["schemaVersion", "evidenceType", "inventory", "operations", "final"]);
const INVENTORY_KEYS = new Set(["nodeRef", "command", "policyRefs", "expectedOperationIds"]);
const OPERATION_KEYS = new Set([
  "operationId",
  "route",
  "command",
  "capabilityAdvertised",
  "authority",
  "subject",
  "current",
  "invocation",
  "stream",
  "cancellation",
  "result",
  "reason",
  "effect",
]);
const AUTHORITY_KEYS = new Set(["decision", "policyRef"]);
const SUBJECT_KEYS = new Set(["nodeRef", "pairingGeneration", "connectionRef"]);
const CURRENT_KEYS = new Set(["pairingGeneration", "connectionRef"]);
const INVOCATION_KEYS = new Set(["invokeRef", "idempotencyRef", "dispatched"]);
const STREAM_KEYS = new Set(["progress", "terminalSettled"]);
const PROGRESS_KEYS = new Set(["sequence", "evidenceRef"]);
const CANCELLATION_KEYS = new Set(["requested", "acknowledged"]);
const EFFECT_KEYS = new Set(["result", "certainty", "evidenceRef"]);
const FINAL_KEYS = new Set(["reportedOperationIds", "counts", "status", "assuranceComplete"]);
const COUNT_KEYS = new Set(["completed", "blocked", "cancelled", "unknownEffects"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function validRefList(value, pattern) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && pattern.test(entry)) &&
    new Set(value).size === value.length
  );
}

function sameStringSet(actual, expected, pattern) {
  return (
    validRefList(actual, pattern) &&
    validRefList(expected, pattern) &&
    JSON.stringify([...actual].toSorted((a, b) => a.localeCompare(b))) ===
      JSON.stringify([...expected].toSorted((a, b) => a.localeCompare(b)))
  );
}

function validInventory(inventory) {
  return (
    hasOnlyKeys(inventory, INVENTORY_KEYS) &&
    HASH_REF.test(inventory?.nodeRef ?? "") &&
    COMMAND.test(inventory?.command ?? "") &&
    validRefList(inventory?.policyRefs, HASH_REF) &&
    validRefList(inventory?.expectedOperationIds, OPERATION_REF)
  );
}

function validOperationShape(operation) {
  if (
    !hasOnlyKeys(operation, OPERATION_KEYS) ||
    !OPERATION_REF.test(operation?.operationId ?? "") ||
    operation?.route !== "node_transport" ||
    !COMMAND.test(operation?.command ?? "") ||
    typeof operation?.capabilityAdvertised !== "boolean" ||
    !hasOnlyKeys(operation?.authority, AUTHORITY_KEYS) ||
    !["allow", "deny"].includes(operation?.authority?.decision) ||
    !HASH_REF.test(operation?.authority?.policyRef ?? "") ||
    !hasOnlyKeys(operation?.subject, SUBJECT_KEYS) ||
    !HASH_REF.test(operation?.subject?.nodeRef ?? "") ||
    !HASH_REF.test(operation?.subject?.pairingGeneration ?? "") ||
    !HASH_REF.test(operation?.subject?.connectionRef ?? "") ||
    !hasOnlyKeys(operation?.current, CURRENT_KEYS) ||
    !HASH_REF.test(operation?.current?.pairingGeneration ?? "") ||
    !HASH_REF.test(operation?.current?.connectionRef ?? "") ||
    !hasOnlyKeys(operation?.invocation, INVOCATION_KEYS) ||
    !OPERATION_REF.test(operation?.invocation?.idempotencyRef ?? "") ||
    typeof operation?.invocation?.dispatched !== "boolean" ||
    !hasOnlyKeys(operation?.stream, STREAM_KEYS) ||
    !Array.isArray(operation?.stream?.progress) ||
    operation.stream.progress.some(
      (entry) =>
        !hasOnlyKeys(entry, PROGRESS_KEYS) ||
        !Number.isInteger(entry?.sequence) ||
        entry.sequence < 0 ||
        !HASH_REF.test(entry?.evidenceRef ?? ""),
    ) ||
    typeof operation?.stream?.terminalSettled !== "boolean" ||
    !hasOnlyKeys(operation?.cancellation, CANCELLATION_KEYS) ||
    typeof operation?.cancellation?.requested !== "boolean" ||
    typeof operation?.cancellation?.acknowledged !== "boolean" ||
    !["completed", "blocked", "cancelled"].includes(operation?.result) ||
    !hasOnlyKeys(operation?.effect, EFFECT_KEYS) ||
    !["completed", "not_started", "unknown", "stopped"].includes(operation?.effect?.result) ||
    !["confirmed", "unknown"].includes(operation?.effect?.certainty)
  ) {
    return false;
  }
  return operation.invocation.dispatched
    ? HASH_REF.test(operation.invocation.invokeRef ?? "")
    : operation.invocation.invokeRef === null;
}

function validProgress(progress) {
  return progress.every((entry, index) => entry.sequence === index);
}

export function validateRemoteNodeInvocationTrust(input) {
  const failures = [];
  const seenFailureCodes = new Set();
  const fail = (code, operation) => {
    if (seenFailureCodes.has(code)) {
      return;
    }
    seenFailureCodes.add(code);
    failures.push({
      code,
      ...(OPERATION_REF.test(operation?.operationId ?? "")
        ? { operationId: operation.operationId }
        : {}),
    });
  };
  const inventory = input?.inventory;
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  const final = input?.final;

  if (
    input?.schemaVersion !== 1 ||
    input?.evidenceType !== "node.invocation_trust" ||
    !hasOnlyKeys(input, INPUT_KEYS) ||
    !validInventory(inventory) ||
    !Array.isArray(input?.operations) ||
    !hasOnlyKeys(final, FINAL_KEYS) ||
    !hasOnlyKeys(final?.counts, COUNT_KEYS)
  ) {
    fail("ContractMismatch");
  }
  if (
    operations.some(
      (operation) =>
        !hasOnlyKeys(operation, OPERATION_KEYS) ||
        !hasOnlyKeys(operation?.authority, AUTHORITY_KEYS) ||
        !hasOnlyKeys(operation?.subject, SUBJECT_KEYS) ||
        !hasOnlyKeys(operation?.current, CURRENT_KEYS) ||
        !hasOnlyKeys(operation?.invocation, INVOCATION_KEYS) ||
        !hasOnlyKeys(operation?.stream, STREAM_KEYS) ||
        !hasOnlyKeys(operation?.cancellation, CANCELLATION_KEYS) ||
        !hasOnlyKeys(operation?.effect, EFFECT_KEYS) ||
        (Array.isArray(operation?.stream?.progress) &&
          operation.stream.progress.some((entry) => !hasOnlyKeys(entry, PROGRESS_KEYS))),
    )
  ) {
    fail("SensitivePayloadPresent");
  }

  const operationIds = [];
  const counts = {
    completed: 0,
    blocked: 0,
    cancelled: 0,
    unknownEffects: 0,
  };

  for (const operation of operations) {
    if (!validOperationShape(operation)) {
      fail("OperationInvalid", operation);
      continue;
    }
    if (operationIds.includes(operation.operationId)) {
      fail("OperationInventoryMismatch", operation);
    } else {
      operationIds.push(operation.operationId);
    }

    const policyCurrent = inventory?.policyRefs?.includes(operation.authority.policyRef) === true;
    const authorityAllows = operation.authority.decision === "allow" && policyCurrent;
    const subjectCurrent =
      operation.subject.nodeRef === inventory?.nodeRef &&
      operation.subject.pairingGeneration === operation.current.pairingGeneration &&
      operation.subject.connectionRef === operation.current.connectionRef;
    const streamValid =
      validProgress(operation.stream.progress) && operation.stream.terminalSettled === true;

    if (!policyCurrent) {
      fail("AuthorityInvalid", operation);
    }
    if (!streamValid) {
      fail("StreamInvalid", operation);
    }
    if (operation.command !== inventory?.command) {
      fail("OperationInvalid", operation);
    }

    if (operation.result === "completed") {
      counts.completed += 1;
      if (!subjectCurrent) {
        fail("SubjectBindingMismatch", operation);
      }
      if (!operation.invocation.dispatched || operation.invocation.invokeRef === null) {
        fail("DispatchProvenanceInvalid", operation);
      }
      if (
        !authorityAllows ||
        operation.cancellation.requested ||
        operation.cancellation.acknowledged ||
        operation.reason !== undefined ||
        operation.effect.result !== "completed" ||
        operation.effect.certainty !== "confirmed" ||
        !HASH_REF.test(operation.effect.evidenceRef ?? "")
      ) {
        fail("EffectCertaintyInvalid", operation);
      }
    } else if (operation.result === "blocked") {
      counts.blocked += 1;
      const pairingChanged =
        operation.reason === "PAIRING_CHANGED" &&
        operation.subject.pairingGeneration !== operation.current.pairingGeneration;
      const routeChanged =
        operation.reason === "ROUTE_CHANGED" &&
        operation.subject.pairingGeneration === operation.current.pairingGeneration &&
        operation.subject.connectionRef !== operation.current.connectionRef;
      const policyDenied =
        operation.reason === "POLICY_DENIED" &&
        operation.authority.decision === "deny" &&
        policyCurrent;
      if (!pairingChanged && !routeChanged && !policyDenied) {
        fail("SubjectBindingMismatch", operation);
      }
      if (operation.invocation.dispatched || operation.invocation.invokeRef !== null) {
        fail("DispatchProvenanceInvalid", operation);
      }
      if (
        operation.stream.progress.length !== 0 ||
        operation.cancellation.requested ||
        operation.cancellation.acknowledged ||
        operation.effect.result !== "not_started" ||
        operation.effect.certainty !== "confirmed" ||
        operation.effect.evidenceRef !== undefined
      ) {
        fail("EffectCertaintyInvalid", operation);
      }
    } else {
      counts.cancelled += 1;
      if (!subjectCurrent) {
        fail("SubjectBindingMismatch", operation);
      }
      if (
        !authorityAllows ||
        operation.reason !== "ABORTED" ||
        !operation.invocation.dispatched ||
        operation.invocation.invokeRef === null ||
        operation.cancellation.requested !== true ||
        operation.cancellation.acknowledged !== false
      ) {
        fail("DispatchProvenanceInvalid", operation);
      }
      if (
        operation.effect.result !== "unknown" ||
        operation.effect.certainty !== "unknown" ||
        operation.effect.evidenceRef !== undefined
      ) {
        fail("CancellationCertaintyOverclaimed", operation);
      }
    }

    if (operation.effect.certainty === "unknown") {
      counts.unknownEffects += 1;
    }
  }

  const expectedOperationIds = validRefList(inventory?.expectedOperationIds, OPERATION_REF)
    ? inventory.expectedOperationIds
    : [];
  if (!sameStringSet(operationIds, expectedOperationIds, OPERATION_REF)) {
    fail("OperationInventoryMismatch");
  }
  const expectedStatus = counts.unknownEffects > 0 ? "partial" : "complete";
  const assuranceComplete =
    operationIds.length > 0 &&
    sameStringSet(operationIds, expectedOperationIds, OPERATION_REF) &&
    counts.unknownEffects === 0 &&
    failures.length === 0;

  if (
    !sameStringSet(final?.reportedOperationIds, expectedOperationIds, OPERATION_REF) ||
    JSON.stringify(final?.counts) !== JSON.stringify(counts) ||
    final?.status !== expectedStatus ||
    final?.assuranceComplete !== assuranceComplete
  ) {
    fail("FinalStateMismatch");
  }
  if (final?.assuranceComplete === true && !assuranceComplete) {
    fail("AssuranceOverclaimed");
  }

  failures.sort((a, b) => a.code.localeCompare(b.code));
  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    failures,
    reconciliation: {
      expectedOperationCount: expectedOperationIds.length,
      reportedOperationCount: operationIds.length,
      counts,
      status: expectedStatus,
      assuranceComplete,
    },
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/remote-node-invocation-trust-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (fixture.schemaVersion !== 1 || fixture.fixtureId !== FIXTURE_ID) {
    throw new Error(`unsupported fixture: ${fixture.fixtureId ?? "unknown"}`);
  }
  return {
    schemaVersion: 1,
    fixtureId: FIXTURE_ID,
    cases: fixture.cases.map((entry) => ({
      id: entry.id,
      result: validateRemoteNodeInvocationTrust(entry.input),
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(runFixture(), null, 2)}\n`);
}
