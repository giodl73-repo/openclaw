import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.exa.authorized-external-action.v1";
const HASH_REF = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_REF = /^hmac-sha256:v1:[a-f0-9]{64}$/u;
const TOOL_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
const INPUT_KEYS = new Set(["schemaVersion", "evidenceType", "inventory", "operations", "final"]);
const INVENTORY_KEYS = new Set([
  "requesterRef",
  "sessionRef",
  "toolName",
  "toolOwner",
  "surfaceRef",
  "targetClass",
  "currentPolicyRef",
  "expectedOperationIds",
]);
const OPERATION_KEYS = new Set([
  "operationId",
  "request",
  "capability",
  "authority",
  "target",
  "invocation",
  "result",
  "reason",
  "runtime",
  "effect",
]);
const REQUEST_KEYS = new Set(["admissionRef", "requesterRef", "sessionRef", "runRef"]);
const CAPABILITY_KEYS = new Set(["toolCallRef", "toolName", "toolOwner", "surfaceRef"]);
const AUTHORITY_KEYS = new Set([
  "decision",
  "approvalRef",
  "approvalResolution",
  "approvedPolicyRef",
  "currentPolicyRef",
  "approvedAt",
  "expiresAt",
  "observedAt",
]);
const TARGET_KEYS = new Set(["class", "credentialRef"]);
const INVOCATION_KEYS = new Set(["idempotencyRef", "paramsRef", "dispatched"]);
const RUNTIME_KEYS = new Set(["status"]);
const EFFECT_KEYS = new Set(["effectRef", "result", "duplicate", "certainty", "evidenceRef"]);
const FINAL_KEYS = new Set(["reportedOperationIds", "counts", "status", "assuranceComplete"]);
const COUNT_KEYS = new Set(["completed", "blocked", "replayed", "unknownEffects", "uniqueEffects"]);

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

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validInventory(inventory) {
  return (
    hasOnlyKeys(inventory, INVENTORY_KEYS) &&
    HASH_REF.test(inventory?.requesterRef ?? "") &&
    HASH_REF.test(inventory?.sessionRef ?? "") &&
    TOOL_NAME.test(inventory?.toolName ?? "") &&
    TOOL_NAME.test(inventory?.toolOwner ?? "") &&
    HASH_REF.test(inventory?.surfaceRef ?? "") &&
    TOOL_NAME.test(inventory?.targetClass ?? "") &&
    HASH_REF.test(inventory?.currentPolicyRef ?? "") &&
    validRefList(inventory?.expectedOperationIds, OPERATION_REF)
  );
}

function validOperationShape(operation) {
  return (
    hasOnlyKeys(operation, OPERATION_KEYS) &&
    OPERATION_REF.test(operation?.operationId ?? "") &&
    hasOnlyKeys(operation?.request, REQUEST_KEYS) &&
    ["admissionRef", "requesterRef", "sessionRef", "runRef"].every((key) =>
      HASH_REF.test(operation?.request?.[key] ?? ""),
    ) &&
    hasOnlyKeys(operation?.capability, CAPABILITY_KEYS) &&
    HASH_REF.test(operation?.capability?.toolCallRef ?? "") &&
    TOOL_NAME.test(operation?.capability?.toolName ?? "") &&
    TOOL_NAME.test(operation?.capability?.toolOwner ?? "") &&
    HASH_REF.test(operation?.capability?.surfaceRef ?? "") &&
    hasOnlyKeys(operation?.authority, AUTHORITY_KEYS) &&
    operation?.authority?.decision === "allow" &&
    HASH_REF.test(operation?.authority?.approvalRef ?? "") &&
    ["allow_once", "allow_always"].includes(operation?.authority?.approvalResolution) &&
    HASH_REF.test(operation?.authority?.approvedPolicyRef ?? "") &&
    HASH_REF.test(operation?.authority?.currentPolicyRef ?? "") &&
    validTimestamp(operation?.authority?.approvedAt) &&
    validTimestamp(operation?.authority?.expiresAt) &&
    validTimestamp(operation?.authority?.observedAt) &&
    hasOnlyKeys(operation?.target, TARGET_KEYS) &&
    TOOL_NAME.test(operation?.target?.class ?? "") &&
    HASH_REF.test(operation?.target?.credentialRef ?? "") &&
    hasOnlyKeys(operation?.invocation, INVOCATION_KEYS) &&
    OPERATION_REF.test(operation?.invocation?.idempotencyRef ?? "") &&
    HASH_REF.test(operation?.invocation?.paramsRef ?? "") &&
    typeof operation?.invocation?.dispatched === "boolean" &&
    ["completed", "blocked", "replayed"].includes(operation?.result) &&
    hasOnlyKeys(operation?.runtime, RUNTIME_KEYS) &&
    ["succeeded", "blocked"].includes(operation?.runtime?.status) &&
    hasOnlyKeys(operation?.effect, EFFECT_KEYS) &&
    ["applied", "already_applied", "not_started", "unknown"].includes(operation?.effect?.result) &&
    typeof operation?.effect?.duplicate === "boolean" &&
    ["confirmed", "unknown"].includes(operation?.effect?.certainty) &&
    (operation?.effect?.effectRef === null || HASH_REF.test(operation?.effect?.effectRef ?? "")) &&
    (operation?.effect?.evidenceRef === undefined || HASH_REF.test(operation.effect.evidenceRef))
  );
}

export function validateAuthorizedExternalAction(input) {
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
    input?.evidenceType !== "external_action.lifecycle" ||
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
        !hasOnlyKeys(operation?.request, REQUEST_KEYS) ||
        !hasOnlyKeys(operation?.capability, CAPABILITY_KEYS) ||
        !hasOnlyKeys(operation?.authority, AUTHORITY_KEYS) ||
        !hasOnlyKeys(operation?.target, TARGET_KEYS) ||
        !hasOnlyKeys(operation?.invocation, INVOCATION_KEYS) ||
        !hasOnlyKeys(operation?.runtime, RUNTIME_KEYS) ||
        !hasOnlyKeys(operation?.effect, EFFECT_KEYS),
    )
  ) {
    fail("SensitivePayloadPresent");
  }

  const operationIds = [];
  const settledByIdempotency = new Map();
  const uniqueEffectRefs = new Set();
  const counts = {
    completed: 0,
    blocked: 0,
    replayed: 0,
    unknownEffects: 0,
    uniqueEffects: 0,
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

    if (
      operation.request.requesterRef !== inventory?.requesterRef ||
      operation.request.sessionRef !== inventory?.sessionRef
    ) {
      fail("RequesterBindingMismatch", operation);
    }
    if (
      operation.capability.toolName !== inventory?.toolName ||
      operation.capability.toolOwner !== inventory?.toolOwner ||
      operation.capability.surfaceRef !== inventory?.surfaceRef ||
      operation.target.class !== inventory?.targetClass
    ) {
      fail("CapabilityBindingMismatch", operation);
    }

    const approvalCurrent =
      operation.authority.approvedPolicyRef === operation.authority.currentPolicyRef &&
      operation.authority.currentPolicyRef === inventory?.currentPolicyRef;
    const approvalExpired =
      Date.parse(operation.authority.observedAt) > Date.parse(operation.authority.expiresAt) ||
      Date.parse(operation.authority.observedAt) < Date.parse(operation.authority.approvedAt);
    if (approvalExpired) {
      fail("ApprovalExpired", operation);
    }

    if (operation.result === "blocked") {
      counts.blocked += 1;
      if (
        operation.reason !== "POLICY_GENERATION_CHANGED" ||
        operation.authority.approvedPolicyRef === operation.authority.currentPolicyRef ||
        operation.authority.currentPolicyRef !== inventory?.currentPolicyRef
      ) {
        fail("AuthorityInvalid", operation);
      }
      if (operation.invocation.dispatched) {
        fail("DispatchProvenanceInvalid", operation);
      }
      if (
        operation.runtime.status !== "blocked" ||
        operation.effect.effectRef !== null ||
        operation.effect.result !== "not_started" ||
        operation.effect.duplicate ||
        operation.effect.certainty !== "confirmed" ||
        operation.effect.evidenceRef !== undefined
      ) {
        fail("EffectSettlementInvalid", operation);
      }
      continue;
    }

    if (!approvalCurrent || approvalExpired) {
      fail("AuthorityInvalid", operation);
    }
    if (!operation.invocation.dispatched) {
      fail("DispatchProvenanceInvalid", operation);
    }
    if (operation.runtime.status !== "succeeded") {
      fail("EffectSettlementInvalid", operation);
    }

    const prior = settledByIdempotency.get(operation.invocation.idempotencyRef);
    if (operation.result === "completed") {
      counts.completed += 1;
      if (prior) {
        fail("IdempotencyConflict", operation);
      }
      if (
        operation.reason !== undefined ||
        operation.effect.result !== "applied" ||
        operation.effect.duplicate ||
        operation.effect.certainty !== "confirmed" ||
        !HASH_REF.test(operation.effect.effectRef ?? "") ||
        !HASH_REF.test(operation.effect.evidenceRef ?? "")
      ) {
        fail("EffectSettlementInvalid", operation);
      } else {
        settledByIdempotency.set(operation.invocation.idempotencyRef, {
          paramsRef: operation.invocation.paramsRef,
          effectRef: operation.effect.effectRef,
        });
        uniqueEffectRefs.add(operation.effect.effectRef);
      }
    } else {
      counts.replayed += 1;
      if (
        !prior ||
        prior.paramsRef !== operation.invocation.paramsRef ||
        prior.effectRef !== operation.effect.effectRef
      ) {
        fail("IdempotencyConflict", operation);
      }
      if (
        operation.reason !== undefined ||
        operation.effect.result !== "already_applied" ||
        !operation.effect.duplicate ||
        operation.effect.certainty !== "confirmed" ||
        !HASH_REF.test(operation.effect.effectRef ?? "") ||
        !HASH_REF.test(operation.effect.evidenceRef ?? "")
      ) {
        fail("EffectSettlementInvalid", operation);
      }
    }

    if (operation.effect.certainty === "unknown") {
      counts.unknownEffects += 1;
    }
  }

  counts.uniqueEffects = uniqueEffectRefs.size;
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
  path = resolve(ROOT, ".lobster/authorized-external-action-fixture.json"),
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
      result: validateAuthorizedExternalAction(entry.input),
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(runFixture(), null, 2)}\n`);
}
