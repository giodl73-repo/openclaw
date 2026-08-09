import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_VERSION = 1;
const AUTHORITY = "none";
const SESSION_RE = /^session-sha256:[0-9a-f]{64}$/;
const GENERATION_RE = /^generation-sha256:[0-9a-f]{64}$/;
const COPY_RE = /^copy-sha256:[0-9a-f]{64}$/;
const OPERATION_RE = /^operation-sha256:[0-9a-f]{64}$/;
const PRINCIPAL_RE = /^principal-sha256:[0-9a-f]{64}$/;
const POLICY_RE = /^policy-sha256:[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CONTRACT_DIGEST_RE = /^hmac-sha256:[0-9a-f]{64}$/;
const SENSITIVE_RE =
  /^(?:authorizationHeader|content|cookie|password|privateKey|rawTranscript|secret|token)$/i;

const KEYS = {
  top: [
    "contractVersion",
    "authority",
    "fixtureId",
    "inventory",
    "operations",
    "finalState",
    "contract",
  ],
  inventory: ["sessionRefs", "generationRefs", "copyRefs", "operationIds"],
  operation: [
    "operationId",
    "kind",
    "mode",
    "target",
    "authorization",
    "export",
    "mutation",
    "settlements",
    "restartReconciled",
    "result",
    "reason",
    "aggregateAssurance",
    "certainty",
  ],
  target: ["sessionRef", "currentGenerationRef", "expectedGenerationRef"],
  authorization: ["requesterRef", "policyGenerationRef"],
  export: [
    "copyRef",
    "owner",
    "format",
    "schemaVersion",
    "includedClasses",
    "omittedClasses",
    "warnings",
    "integrity",
    "disclosureClass",
    "expiresAt",
  ],
  mutation: ["registry", "transcript", "indexes", "archiveCreated"],
  settlement: [
    "copyRef",
    "owner",
    "relationship",
    "required",
    "initialResult",
    "finalResult",
    "retryable",
    "retainUntil",
  ],
  finalState: [
    "exportCompleteCount",
    "deleteCompleteCount",
    "deletePartialCount",
    "blockedCount",
    "unknownCount",
    "aggregateAssurance",
  ],
  contract: ["name", "version", "authority", "digest"],
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(failures, code, message) {
  failures.push({ code, message });
}

function keys(value, allowed, location, failures) {
  if (!isRecord(value)) {
    fail(failures, "ContractMismatch", `${location} must be an object`);
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(
      failures,
      "ContractMismatch",
      `${location} contains unsupported fields: ${unknown.toSorted().join(", ")}`,
    );
    return false;
  }
  return true;
}

function scanSensitive(value, location, failures) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanSensitive(child, `${location}[${index}]`, failures));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_RE.test(key)) {
      fail(
        failures,
        "SensitivePayloadPresent",
        `${location}.${key} is not allowed in lifecycle evidence`,
      );
    }
    scanSensitive(child, `${location}.${key}`, failures);
  }
}

function uniqueRefs(value, pattern) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && pattern.test(item)) &&
    new Set(value).size === value.length
  );
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateTarget(operation, index, inventory, failures) {
  const location = `operations[${index}].target`;
  if (!keys(operation.target, KEYS.target, location, failures)) {
    return;
  }
  if (
    !SESSION_RE.test(operation.target.sessionRef ?? "") ||
    !inventory.sessionRefs.has(operation.target.sessionRef) ||
    !GENERATION_RE.test(operation.target.currentGenerationRef ?? "") ||
    !inventory.generationRefs.has(operation.target.currentGenerationRef) ||
    !GENERATION_RE.test(operation.target.expectedGenerationRef ?? "") ||
    !inventory.generationRefs.has(operation.target.expectedGenerationRef)
  ) {
    fail(failures, "InventoryMismatch", `${location} must use inventoried typed references`);
  }
}

function validateAuthorization(operation, index, failures) {
  const location = `operations[${index}].authorization`;
  if (!keys(operation.authorization, KEYS.authorization, location, failures)) {
    return;
  }
  if (
    !PRINCIPAL_RE.test(operation.authorization.requesterRef ?? "") ||
    !POLICY_RE.test(operation.authorization.policyGenerationRef ?? "")
  ) {
    fail(
      failures,
      "AuthorizationInvalid",
      `${location} must retain requester and policy generation references`,
    );
  }
}

function validateExport(operation, index, inventory, usedCopies, failures) {
  const location = `operations[${index}]`;
  if (operation.target?.currentGenerationRef !== operation.target?.expectedGenerationRef) {
    fail(failures, "GenerationFenceInvalid", `${location} export generation is stale`);
  }
  if (!keys(operation.export, KEYS.export, `${location}.export`, failures)) {
    return;
  }
  const evidence = operation.export;
  if (!inventory.copyRefs.has(evidence.copyRef)) {
    fail(failures, "InventoryMismatch", `${location}.export.copyRef is not inventoried`);
  }
  usedCopies.add(evidence.copyRef);
  const included = ["system-prompt", "tool-definitions", "transcript"];
  const valid =
    evidence.owner === "workspace-export" &&
    evidence.format === "html" &&
    evidence.schemaVersion === 1 &&
    JSON.stringify(evidence.includedClasses) === JSON.stringify(included) &&
    JSON.stringify(evidence.omittedClasses) === JSON.stringify(["delegated-backend-transcript"]) &&
    JSON.stringify(evidence.warnings) === JSON.stringify(["DELEGATED_BACKEND_OMITTED"]) &&
    DIGEST_RE.test(evidence.integrity ?? "") &&
    evidence.disclosureClass === "confidential" &&
    validDate(evidence.expiresAt) &&
    operation.result === "complete" &&
    operation.certainty === "confirmed";
  if (!valid) {
    fail(
      failures,
      "ExportEvidenceInvalid",
      `${location} must describe the exact created copy, omissions, disclosure, and integrity`,
    );
  }
  for (const forbidden of [
    "mode",
    "mutation",
    "settlements",
    "restartReconciled",
    "reason",
    "aggregateAssurance",
  ]) {
    if (forbidden in operation) {
      fail(failures, "ContractMismatch", `${location} export cannot include ${forbidden}`);
    }
  }
}

function validateSettlementShape(settlement, location, inventory, usedCopies, failures) {
  if (!keys(settlement, KEYS.settlement, location, failures)) {
    return;
  }
  if (!COPY_RE.test(settlement.copyRef ?? "") || !inventory.copyRefs.has(settlement.copyRef)) {
    fail(failures, "InventoryMismatch", `${location}.copyRef is not inventoried`);
  }
  usedCopies.add(settlement.copyRef);
  if (
    typeof settlement.owner !== "string" ||
    typeof settlement.relationship !== "string" ||
    settlement.required !== true ||
    typeof settlement.initialResult !== "string" ||
    typeof settlement.finalResult !== "string" ||
    typeof settlement.retryable !== "boolean" ||
    ("retainUntil" in settlement && !validDate(settlement.retainUntil))
  ) {
    fail(failures, "SettlementInvalid", `${location} has invalid owner settlement fields`);
  }
}

const archiveSettlementContract = [
  ["canonical-transcript", "canonical", "complete", "complete", false],
  ["transcript-index", "transactional-derived", "complete", "complete", false],
  ["workspace-export", "user-created-export", "retained", "retained", false],
  ["delete-archive", "retained-archive", "retained", "retained", false],
  ["qmd-live-projection", "eventual-derived", "deferred", "complete", true],
  ["qmd-archive-projection", "retained-derived", "retained", "retained", false],
  ["backup", "retained-backup", "retained", "retained", false],
  ["provider", "external-copy", "externally_controlled", "externally_controlled", false],
];

function settlementMatches(settlement, contract) {
  const [owner, relationship, initialResult, finalResult, retryable] = contract;
  return (
    settlement?.owner === owner &&
    settlement.relationship === relationship &&
    settlement.initialResult === initialResult &&
    settlement.finalResult === finalResult &&
    settlement.retryable === retryable
  );
}

function validateArchiveDelete(operation, index, inventory, usedCopies, failures) {
  const location = `operations[${index}]`;
  if (operation.target?.currentGenerationRef !== operation.target?.expectedGenerationRef) {
    fail(failures, "GenerationFenceInvalid", `${location} accepted delete generation is stale`);
  }
  if (
    operation.mutation?.registry !== "removed" ||
    operation.mutation?.transcript !== "removed" ||
    operation.mutation?.indexes !== "removed_transactionally" ||
    operation.mutation?.archiveCreated !== true
  ) {
    fail(
      failures,
      "MutationBoundaryInvalid",
      `${location} archive-and-remove mutation does not match owner behavior`,
    );
  }
  const settlements = Array.isArray(operation.settlements) ? operation.settlements : [];
  settlements.forEach((settlement, settlementIndex) =>
    validateSettlementShape(
      settlement,
      `${location}.settlements[${settlementIndex}]`,
      inventory,
      usedCopies,
      failures,
    ),
  );
  const matches =
    settlements.length === archiveSettlementContract.length &&
    archiveSettlementContract.every((contract, settlementIndex) =>
      settlementMatches(settlements[settlementIndex], contract),
    ) &&
    validDate(settlements[3]?.retainUntil) &&
    validDate(settlements[6]?.retainUntil);
  if (!matches) {
    fail(
      failures,
      "SettlementInvalid",
      `${location} must retain archives, exports, backup, external state, and restart reconciliation`,
    );
  }
  if (
    operation.restartReconciled !== true ||
    operation.result !== "partial" ||
    operation.aggregateAssurance !== "complete" ||
    operation.certainty !== "confirmed"
  ) {
    fail(
      failures,
      "PurgeOverclaimed",
      `${location} ordinary deletion must remain a complete inventory with a partial outcome`,
    );
  }
}

const purgeSettlementContract = [
  ["canonical-transcript", "canonical", "complete", "complete", false],
  ["transcript-index", "transactional-derived", "complete", "complete", false],
  ["qmd-live-projection", "eventual-derived", "deferred", "complete", true],
];

function validatePurge(operation, index, inventory, usedCopies, failures) {
  const location = `operations[${index}]`;
  if (operation.target?.currentGenerationRef !== operation.target?.expectedGenerationRef) {
    fail(failures, "GenerationFenceInvalid", `${location} accepted purge generation is stale`);
  }
  if (
    operation.mutation?.registry !== "removed" ||
    operation.mutation?.transcript !== "removed" ||
    operation.mutation?.indexes !== "removed_transactionally" ||
    operation.mutation?.archiveCreated !== false
  ) {
    fail(failures, "MutationBoundaryInvalid", `${location} purge mutation is invalid`);
  }
  const settlements = Array.isArray(operation.settlements) ? operation.settlements : [];
  settlements.forEach((settlement, settlementIndex) =>
    validateSettlementShape(
      settlement,
      `${location}.settlements[${settlementIndex}]`,
      inventory,
      usedCopies,
      failures,
    ),
  );
  const matches =
    settlements.length === purgeSettlementContract.length &&
    purgeSettlementContract.every((contract, settlementIndex) =>
      settlementMatches(settlements[settlementIndex], contract),
    );
  if (
    !matches ||
    operation.restartReconciled !== true ||
    operation.result !== "complete" ||
    operation.aggregateAssurance !== "complete" ||
    operation.certainty !== "confirmed"
  ) {
    fail(
      failures,
      "PurgeOverclaimed",
      `${location} purge requires every bounded local copy complete after restart`,
    );
  }
}

function validateBlocked(operation, index, failures) {
  const location = `operations[${index}]`;
  if (
    operation.target?.currentGenerationRef === operation.target?.expectedGenerationRef ||
    operation.mutation?.registry !== "not_started" ||
    operation.mutation?.transcript !== "not_started" ||
    operation.mutation?.indexes !== "not_started" ||
    operation.mutation?.archiveCreated !== false ||
    !Array.isArray(operation.settlements) ||
    operation.settlements.length !== 0 ||
    operation.restartReconciled !== false ||
    operation.result !== "blocked" ||
    operation.reason !== "GENERATION_CHANGED" ||
    operation.aggregateAssurance !== "complete" ||
    operation.certainty !== "confirmed"
  ) {
    fail(
      failures,
      "GenerationFenceInvalid",
      `${location} stale generation must block before every owner mutation`,
    );
  }
}

function validateDelete(operation, index, inventory, usedCopies, failures) {
  const location = `operations[${index}]`;
  if (!keys(operation.mutation, KEYS.mutation, `${location}.mutation`, failures)) {
    return;
  }
  if ("export" in operation) {
    fail(failures, "ContractMismatch", `${location} delete cannot include export evidence`);
  }
  if (operation.result === "blocked") {
    if (!["archive-and-remove", "purge"].includes(operation.mode)) {
      fail(failures, "ContractMismatch", `${location}.mode is unsupported`);
    }
    validateBlocked(operation, index, failures);
    return;
  }

  if ("reason" in operation) {
    fail(failures, "ContractMismatch", `${location} accepted delete cannot include reason`);
  }
  if (operation.mode === "archive-and-remove") {
    validateArchiveDelete(operation, index, inventory, usedCopies, failures);
  } else if (operation.mode === "purge") {
    validatePurge(operation, index, inventory, usedCopies, failures);
  } else {
    fail(failures, "ContractMismatch", `${location}.mode is unsupported`);
  }
}

function validateTraceRelationships(operations, failures) {
  const [exportOperation, archiveDelete, purge, blocked] = operations;
  const valid =
    operations.length === 4 &&
    exportOperation?.kind === "export" &&
    exportOperation.result === "complete" &&
    archiveDelete?.kind === "delete" &&
    archiveDelete.mode === "archive-and-remove" &&
    archiveDelete.result === "partial" &&
    archiveDelete.target?.sessionRef === exportOperation.target?.sessionRef &&
    archiveDelete.target?.currentGenerationRef === exportOperation.target?.currentGenerationRef &&
    purge?.kind === "delete" &&
    purge.mode === "purge" &&
    purge.result === "complete" &&
    purge.target?.sessionRef !== exportOperation.target?.sessionRef &&
    blocked?.kind === "delete" &&
    blocked.mode === "purge" &&
    blocked.result === "blocked" &&
    blocked.target?.sessionRef === purge.target?.sessionRef &&
    blocked.target?.currentGenerationRef === purge.target?.currentGenerationRef &&
    blocked.target?.expectedGenerationRef !== blocked.target?.currentGenerationRef;
  if (!valid) {
    fail(
      failures,
      "GenerationFenceInvalid",
      "trace must bind export to archive deletion and stale refusal to the bounded purge target",
    );
  }
}

function counts(operations) {
  return {
    exportCompleteCount: operations.filter(
      (operation) => operation?.kind === "export" && operation.result === "complete",
    ).length,
    deleteCompleteCount: operations.filter(
      (operation) => operation?.kind === "delete" && operation.result === "complete",
    ).length,
    deletePartialCount: operations.filter(
      (operation) => operation?.kind === "delete" && operation.result === "partial",
    ).length,
    blockedCount: operations.filter((operation) => operation?.result === "blocked").length,
    unknownCount: operations.filter(
      (operation) => !["complete", "partial", "blocked"].includes(operation?.result),
    ).length,
  };
}

function result(input, failures) {
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  return {
    contractVersion: CONTRACT_VERSION,
    authority: AUTHORITY,
    fixtureId: typeof input?.fixtureId === "string" ? input.fixtureId : "",
    status: failures.length === 0 ? "pass" : "fail",
    ...counts(operations),
    failures,
  };
}

export function validateSessionCopyLifecycleFixture(input) {
  const failures = [];
  scanSensitive(input, "fixture", failures);
  if (!keys(input, KEYS.top, "fixture", failures)) {
    return result(input, failures);
  }
  if (
    input.contractVersion !== CONTRACT_VERSION ||
    input.authority !== AUTHORITY ||
    typeof input.fixtureId !== "string" ||
    input.fixtureId.length === 0
  ) {
    fail(failures, "ContractMismatch", "fixture identity or authority is invalid");
  }
  keys(input.contract, KEYS.contract, "contract", failures);
  if (
    input.contract?.name !== "session-copy-lifecycle" ||
    input.contract?.version !== "1.0.0" ||
    input.contract?.authority !== AUTHORITY ||
    !CONTRACT_DIGEST_RE.test(input.contract?.digest ?? "")
  ) {
    fail(failures, "ContractMismatch", "contract declaration is invalid");
  }
  keys(input.inventory, KEYS.inventory, "inventory", failures);
  const inventory = {
    sessionRefs: new Set(input.inventory?.sessionRefs ?? []),
    generationRefs: new Set(input.inventory?.generationRefs ?? []),
    copyRefs: new Set(input.inventory?.copyRefs ?? []),
    operationIds: new Set(input.inventory?.operationIds ?? []),
  };
  if (
    !uniqueRefs(input.inventory?.sessionRefs, SESSION_RE) ||
    !uniqueRefs(input.inventory?.generationRefs, GENERATION_RE) ||
    !uniqueRefs(input.inventory?.copyRefs, COPY_RE) ||
    !uniqueRefs(input.inventory?.operationIds, OPERATION_RE)
  ) {
    fail(failures, "InventoryMismatch", "inventory references must be typed and unique");
  }
  const operations = Array.isArray(input.operations) ? input.operations : [];
  if (!Array.isArray(input.operations)) {
    fail(failures, "ContractMismatch", "operations must be an array");
  }
  const seenOperations = new Set();
  const usedCopies = new Set();
  const usedSessions = new Set();
  const usedGenerations = new Set();
  for (const [index, operation] of operations.entries()) {
    const location = `operations[${index}]`;
    if (!keys(operation, KEYS.operation, location, failures)) {
      continue;
    }
    if (
      !OPERATION_RE.test(operation.operationId ?? "") ||
      !inventory.operationIds.has(operation.operationId) ||
      seenOperations.has(operation.operationId)
    ) {
      fail(failures, "InventoryMismatch", `${location}.operationId is invalid or duplicated`);
    }
    seenOperations.add(operation.operationId);
    validateTarget(operation, index, inventory, failures);
    if (typeof operation.target?.sessionRef === "string") {
      usedSessions.add(operation.target.sessionRef);
    }
    if (typeof operation.target?.currentGenerationRef === "string") {
      usedGenerations.add(operation.target.currentGenerationRef);
    }
    if (typeof operation.target?.expectedGenerationRef === "string") {
      usedGenerations.add(operation.target.expectedGenerationRef);
    }
    validateAuthorization(operation, index, failures);
    if (operation.kind === "export") {
      validateExport(operation, index, inventory, usedCopies, failures);
    } else if (operation.kind === "delete") {
      validateDelete(operation, index, inventory, usedCopies, failures);
    } else {
      fail(failures, "ContractMismatch", `${location}.kind is unsupported`);
    }
  }
  if (
    seenOperations.size !== inventory.operationIds.size ||
    [...inventory.operationIds].some((id) => !seenOperations.has(id))
  ) {
    fail(failures, "InventoryMismatch", "operations must exactly cover operation inventory");
  }
  if (
    usedCopies.size !== inventory.copyRefs.size ||
    [...inventory.copyRefs].some((copyRef) => !usedCopies.has(copyRef))
  ) {
    fail(failures, "InventoryMismatch", "operations must exactly cover copy inventory");
  }
  if (
    usedSessions.size !== inventory.sessionRefs.size ||
    [...inventory.sessionRefs].some((sessionRef) => !usedSessions.has(sessionRef)) ||
    usedGenerations.size !== inventory.generationRefs.size ||
    [...inventory.generationRefs].some((generationRef) => !usedGenerations.has(generationRef))
  ) {
    fail(
      failures,
      "InventoryMismatch",
      "operations must exactly cover session and generation inventory",
    );
  }
  validateTraceRelationships(operations, failures);
  keys(input.finalState, KEYS.finalState, "finalState", failures);
  const actual = counts(operations);
  if (Object.entries(actual).some(([key, value]) => input.finalState?.[key] !== value)) {
    fail(failures, "FinalStateMismatch", "finalState counts must derive from operations");
  }
  if (
    input.finalState?.aggregateAssurance !== "complete" ||
    actual.exportCompleteCount !== 1 ||
    actual.deleteCompleteCount !== 1 ||
    actual.deletePartialCount !== 1 ||
    actual.blockedCount !== 1 ||
    actual.unknownCount !== 0
  ) {
    fail(
      failures,
      "AssuranceOverclaimed",
      "complete assurance requires the exact export, partial delete, purge, and fence trace",
    );
  }
  return result(input, failures);
}

async function main() {
  const fixturePath =
    process.argv[2] ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      ".lobster",
      "session-copy-lifecycle-fixture.json",
    );
  const input = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const validation = validateSessionCopyLifecycleFixture(input);
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  if (validation.status !== "pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
