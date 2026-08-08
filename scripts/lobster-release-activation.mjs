import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_VERSION = 1;
const CONTRACT_NAME = "release-activation";
const CONTRACT_SEMVER = "1.0.0";
const AUTHORITY = "none";
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REF_RE =
  /^(?:installation|plan|release-proof|evidence|attempt|service-incarnation|readiness-generation)-sha256:[0-9a-f]{64}$/;
const CONTRACT_DIGEST_RE = /^hmac-sha256:[0-9a-f]{64}$/;
const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.-]+)?$/;
const SENSITIVE_KEY_RE =
  /^(?:authorization|cookie|password|privateKey|rawParameters|rawResult|secret|token)$/i;

const topLevelKeys = [
  "contractVersion",
  "authority",
  "fixtureId",
  "inventory",
  "attempts",
  "finalState",
  "contract",
];
const inventoryKeys = [
  "installationRef",
  "planRefs",
  "releaseProofRefs",
  "evidenceRefs",
  "expectedAttemptIds",
];
const attemptKeys = [
  "attemptId",
  "subject",
  "release",
  "compatibility",
  "mutation",
  "phases",
  "active",
  "recovery",
  "result",
  "reason",
  "certainty",
];
const subjectKeys = ["owner", "installationRef", "planRef"];
const releaseKeys = ["prior", "target"];
const releaseIdentityKeys = ["version", "artifactDigest", "proofRef"];
const compatibilityKeys = ["state", "plugins"];
const stateCompatibilityKeys = ["currentSchema", "targetSupportedSchema", "result"];
const pluginCompatibilityKeys = ["result", "restartDebt"];
const mutationKeys = ["package", "state", "service"];
const phaseKeys = ["owner", "phase", "result", "evidenceRef"];
const activeKeys = ["version", "artifactDigest", "serviceIncarnationRef", "readinessGenerationRef"];
const recoveryKeys = ["code", "state"];
const finalStateKeys = [
  "readyAttemptCount",
  "blockedAttemptCount",
  "unknownAttemptCount",
  "aggregateAssurance",
];
const contractKeys = ["name", "version", "authority", "digest"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addFailure(failures, code, message) {
  failures.push({ code, message });
}

function rejectUnknownKeys(value, allowed, location, failures) {
  if (!isRecord(value)) {
    addFailure(failures, "ContractMismatch", `${location} must be an object`);
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    addFailure(
      failures,
      "ContractMismatch",
      `${location} contains unsupported fields: ${unknown.toSorted().join(", ")}`,
    );
    return false;
  }
  return true;
}

function hasSensitivePayload(value, location, failures) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => hasSensitivePayload(item, `${location}[${index}]`, failures));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      addFailure(
        failures,
        "SensitivePayloadPresent",
        `${location}.${key} is not allowed in portable evidence`,
      );
    }
    hasSensitivePayload(child, `${location}.${key}`, failures);
  }
}

function isUniqueStringArray(value, pattern) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && pattern.test(item)) &&
    new Set(value).size === value.length
  );
}

function validateReleaseIdentity(identity, location, proofRefs, failures) {
  if (!rejectUnknownKeys(identity, releaseIdentityKeys, location, failures)) {
    return false;
  }
  const valid =
    VERSION_RE.test(identity.version ?? "") &&
    DIGEST_RE.test(identity.artifactDigest ?? "") &&
    REF_RE.test(identity.proofRef ?? "") &&
    proofRefs.has(identity.proofRef);
  if (!valid) {
    addFailure(
      failures,
      "ReleaseIdentityInvalid",
      `${location} must bind a version, immutable digest, and inventoried release proof`,
    );
  }
  return valid;
}

function validateCommonAttemptShape(attempt, index, inventory, failures) {
  const location = `attempts[${index}]`;
  if (!rejectUnknownKeys(attempt, attemptKeys, location, failures)) {
    return false;
  }
  let valid = true;
  if (
    !REF_RE.test(attempt.attemptId ?? "") ||
    !inventory.expectedAttemptIds.has(attempt.attemptId)
  ) {
    addFailure(
      failures,
      "AttemptInventoryMismatch",
      `${location}.attemptId is not declared by inventory`,
    );
    valid = false;
  }
  if (!rejectUnknownKeys(attempt.subject, subjectKeys, `${location}.subject`, failures)) {
    valid = false;
  } else if (
    attempt.subject.owner !== "openclaw-local-updater" ||
    attempt.subject.installationRef !== inventory.installationRef ||
    !inventory.planRefs.has(attempt.subject.planRef)
  ) {
    addFailure(
      failures,
      "AttemptInventoryMismatch",
      `${location}.subject must bind the inventoried installation and plan`,
    );
    valid = false;
  }
  if (!rejectUnknownKeys(attempt.release, releaseKeys, `${location}.release`, failures)) {
    valid = false;
  } else {
    valid =
      validateReleaseIdentity(
        attempt.release.prior,
        `${location}.release.prior`,
        inventory.releaseProofRefs,
        failures,
      ) && valid;
    if (
      attempt.release.prior?.version === attempt.release.target?.version ||
      attempt.release.prior?.artifactDigest === attempt.release.target?.artifactDigest
    ) {
      addFailure(
        failures,
        "ReleaseIdentityInvalid",
        `${location} must distinguish the prior release from the exact target`,
      );
      valid = false;
    }
    valid =
      validateReleaseIdentity(
        attempt.release.target,
        `${location}.release.target`,
        inventory.releaseProofRefs,
        failures,
      ) && valid;
  }
  if (
    !rejectUnknownKeys(
      attempt.compatibility,
      compatibilityKeys,
      `${location}.compatibility`,
      failures,
    ) ||
    !rejectUnknownKeys(
      attempt.compatibility?.state,
      stateCompatibilityKeys,
      `${location}.compatibility.state`,
      failures,
    ) ||
    !rejectUnknownKeys(
      attempt.compatibility?.plugins,
      pluginCompatibilityKeys,
      `${location}.compatibility.plugins`,
      failures,
    )
  ) {
    valid = false;
  }
  if (
    !rejectUnknownKeys(attempt.mutation, mutationKeys, `${location}.mutation`, failures) ||
    !rejectUnknownKeys(attempt.active, activeKeys, `${location}.active`, failures) ||
    !rejectUnknownKeys(attempt.recovery, recoveryKeys, `${location}.recovery`, failures)
  ) {
    valid = false;
  }
  if (!Array.isArray(attempt.phases) || attempt.phases.length === 0) {
    addFailure(failures, "PhaseSequenceInvalid", `${location}.phases must not be empty`);
    valid = false;
  } else {
    for (const [phaseIndex, phase] of attempt.phases.entries()) {
      if (
        !rejectUnknownKeys(phase, phaseKeys, `${location}.phases[${phaseIndex}]`, failures) ||
        !inventory.evidenceRefs.has(phase?.evidenceRef)
      ) {
        addFailure(
          failures,
          "PhaseSequenceInvalid",
          `${location}.phases[${phaseIndex}] must bind inventoried evidence`,
        );
        valid = false;
      }
    }
  }
  if (attempt.certainty !== "confirmed") {
    addFailure(failures, "RecoveryCertaintyInvalid", `${location}.certainty must be confirmed`);
    valid = false;
  }
  return valid;
}

const readyPhases = [
  ["package", "activate", "complete"],
  ["doctor", "migrate", "complete"],
  ["plugins", "converge", "complete"],
  ["service", "restart", "complete"],
  ["readiness", "prove", "ready"],
];

function validateReadyAttempt(attempt, index, failures) {
  const location = `attempts[${index}]`;
  const state = attempt.compatibility?.state;
  const plugins = attempt.compatibility?.plugins;
  if (
    !Number.isSafeInteger(state?.currentSchema) ||
    !Number.isSafeInteger(state?.targetSupportedSchema) ||
    state.currentSchema > state.targetSupportedSchema ||
    state.result !== "compatible" ||
    plugins?.result !== "compatible" ||
    plugins.restartDebt !== "none"
  ) {
    addFailure(
      failures,
      "CompatibilityInvalid",
      `${location} ready result requires compatible state and plugins with no restart debt`,
    );
  }
  if (
    attempt.mutation?.package !== "activated" ||
    attempt.mutation?.state !== "migrated" ||
    attempt.mutation?.service !== "restarted"
  ) {
    addFailure(
      failures,
      "MutationBoundaryInvalid",
      `${location} ready result must retain each completed mutation`,
    );
  }
  const sequenceMatches =
    attempt.phases?.length === readyPhases.length &&
    readyPhases.every(
      ([owner, phase, result], phaseIndex) =>
        attempt.phases[phaseIndex]?.owner === owner &&
        attempt.phases[phaseIndex]?.phase === phase &&
        attempt.phases[phaseIndex]?.result === result,
    );
  if (!sequenceMatches) {
    addFailure(
      failures,
      "PhaseSequenceInvalid",
      `${location} ready phases must retain owner order through target readiness`,
    );
  }
  if (
    attempt.active?.version !== attempt.release?.target?.version ||
    attempt.active?.artifactDigest !== attempt.release?.target?.artifactDigest ||
    !REF_RE.test(attempt.active?.serviceIncarnationRef ?? "") ||
    !REF_RE.test(attempt.active?.readinessGenerationRef ?? "")
  ) {
    addFailure(
      failures,
      "ActivationBindingMismatch",
      `${location} readiness must bind the exact target and service incarnation`,
    );
  }
  if (attempt.recovery?.code !== "not_required" || attempt.recovery?.state !== "not_required") {
    addFailure(
      failures,
      "RecoveryCertaintyInvalid",
      `${location} successful activation must not claim a recovery`,
    );
  }
  if ("reason" in attempt) {
    addFailure(failures, "ContractMismatch", `${location} ready result cannot include reason`);
  }
}

function validateBlockedAttempt(attempt, index, failures) {
  const location = `attempts[${index}]`;
  const state = attempt.compatibility?.state;
  const plugins = attempt.compatibility?.plugins;
  if (
    !Number.isSafeInteger(state?.currentSchema) ||
    !Number.isSafeInteger(state?.targetSupportedSchema) ||
    state.currentSchema <= state.targetSupportedSchema ||
    state.result !== "newer_than_target" ||
    plugins?.result !== "not_evaluated" ||
    plugins.restartDebt !== "unknown" ||
    attempt.reason !== "STATE_SCHEMA_NEWER_THAN_TARGET"
  ) {
    addFailure(
      failures,
      "CompatibilityInvalid",
      `${location} block must prove a newer current schema before plugin evaluation`,
    );
  }
  if (
    attempt.mutation?.package !== "not_started" ||
    attempt.mutation?.state !== "not_changed" ||
    attempt.mutation?.service !== "not_stopped"
  ) {
    addFailure(
      failures,
      "MutationBoundaryInvalid",
      `${location} schema refusal must precede package, state, and service mutation`,
    );
  }
  const preflight = attempt.phases?.[0];
  if (
    attempt.phases?.length !== 1 ||
    preflight?.owner !== "compatibility" ||
    preflight.phase !== "preflight" ||
    preflight.result !== "blocked"
  ) {
    addFailure(
      failures,
      "PhaseSequenceInvalid",
      `${location} blocked attempt must stop at compatibility preflight`,
    );
  }
  if (
    attempt.active?.version !== attempt.release?.prior?.version ||
    attempt.active?.artifactDigest !== attempt.release?.prior?.artifactDigest ||
    !REF_RE.test(attempt.active?.serviceIncarnationRef ?? "") ||
    !REF_RE.test(attempt.active?.readinessGenerationRef ?? "")
  ) {
    addFailure(
      failures,
      "ActivationBindingMismatch",
      `${location} blocked attempt must retain the prior active release`,
    );
  }
  if (attempt.recovery?.code !== "not_required" || attempt.recovery?.state !== "not_required") {
    addFailure(
      failures,
      "RecoveryCertaintyInvalid",
      `${location} pre-mutation refusal must not claim rollback or state restoration`,
    );
  }
}

export function validateReleaseActivationFixture(input) {
  const failures = [];
  hasSensitivePayload(input, "fixture", failures);
  if (!rejectUnknownKeys(input, topLevelKeys, "fixture", failures)) {
    return buildResult(input, failures);
  }
  if (
    input.contractVersion !== CONTRACT_VERSION ||
    input.authority !== AUTHORITY ||
    typeof input.fixtureId !== "string" ||
    input.fixtureId.length === 0
  ) {
    addFailure(
      failures,
      "ContractMismatch",
      "fixture contractVersion, authority, or fixtureId is invalid",
    );
  }
  rejectUnknownKeys(input.contract, contractKeys, "contract", failures);
  if (
    input.contract?.name !== CONTRACT_NAME ||
    input.contract?.version !== CONTRACT_SEMVER ||
    input.contract?.authority !== AUTHORITY ||
    !CONTRACT_DIGEST_RE.test(input.contract?.digest ?? "")
  ) {
    addFailure(failures, "ContractMismatch", "contract declaration is invalid");
  }
  rejectUnknownKeys(input.inventory, inventoryKeys, "inventory", failures);
  const inventory = {
    installationRef: input.inventory?.installationRef,
    planRefs: new Set(input.inventory?.planRefs ?? []),
    releaseProofRefs: new Set(input.inventory?.releaseProofRefs ?? []),
    evidenceRefs: new Set(input.inventory?.evidenceRefs ?? []),
    expectedAttemptIds: new Set(input.inventory?.expectedAttemptIds ?? []),
  };
  if (
    !REF_RE.test(inventory.installationRef ?? "") ||
    !isUniqueStringArray(input.inventory?.planRefs, REF_RE) ||
    !isUniqueStringArray(input.inventory?.releaseProofRefs, REF_RE) ||
    !isUniqueStringArray(input.inventory?.evidenceRefs, REF_RE) ||
    !isUniqueStringArray(input.inventory?.expectedAttemptIds, REF_RE)
  ) {
    addFailure(
      failures,
      "AttemptInventoryMismatch",
      "inventory must contain unique, typed immutable references",
    );
  }
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  if (!Array.isArray(input.attempts)) {
    addFailure(failures, "ContractMismatch", "attempts must be an array");
  }
  const seenAttemptIds = new Set();
  const seenPlanRefs = new Set();
  const seenEvidenceRefs = new Set();
  for (const [index, attempt] of attempts.entries()) {
    validateCommonAttemptShape(attempt, index, inventory, failures);
    if (seenAttemptIds.has(attempt?.attemptId)) {
      addFailure(
        failures,
        "AttemptInventoryMismatch",
        `attempts[${index}].attemptId is duplicated`,
      );
    }
    seenAttemptIds.add(attempt?.attemptId);
    if (seenPlanRefs.has(attempt?.subject?.planRef)) {
      addFailure(
        failures,
        "AttemptInventoryMismatch",
        `attempts[${index}].subject.planRef is reused`,
      );
    }
    seenPlanRefs.add(attempt?.subject?.planRef);
    for (const phase of attempt?.phases ?? []) {
      if (seenEvidenceRefs.has(phase?.evidenceRef)) {
        addFailure(
          failures,
          "PhaseSequenceInvalid",
          `attempts[${index}] reuses phase evidence ${phase?.evidenceRef}`,
        );
      }
      seenEvidenceRefs.add(phase?.evidenceRef);
    }
    if (attempt?.result === "ready") {
      validateReadyAttempt(attempt, index, failures);
    } else if (attempt?.result === "blocked") {
      validateBlockedAttempt(attempt, index, failures);
    } else {
      addFailure(
        failures,
        "ActivationBindingMismatch",
        `attempts[${index}].result must be ready or blocked`,
      );
    }
  }
  if (
    seenAttemptIds.size !== inventory.expectedAttemptIds.size ||
    [...inventory.expectedAttemptIds].some((id) => !seenAttemptIds.has(id)) ||
    seenPlanRefs.size !== inventory.planRefs.size ||
    [...inventory.planRefs].some((ref) => !seenPlanRefs.has(ref))
  ) {
    addFailure(
      failures,
      "AttemptInventoryMismatch",
      "attempts must exactly cover inventoried attempt and plan references",
    );
  }
  if (
    seenEvidenceRefs.size !== inventory.evidenceRefs.size ||
    [...inventory.evidenceRefs].some((ref) => !seenEvidenceRefs.has(ref))
  ) {
    addFailure(
      failures,
      "PhaseSequenceInvalid",
      "attempt phases must exactly cover inventoried evidence references",
    );
  }
  validateFinalState(input.finalState, attempts, failures);
  return buildResult(input, failures);
}

function validateFinalState(finalState, attempts, failures) {
  rejectUnknownKeys(finalState, finalStateKeys, "finalState", failures);
  const readyAttemptCount = attempts.filter((attempt) => attempt?.result === "ready").length;
  const blockedAttemptCount = attempts.filter((attempt) => attempt?.result === "blocked").length;
  const unknownAttemptCount = attempts.length - readyAttemptCount - blockedAttemptCount;
  if (
    finalState?.readyAttemptCount !== readyAttemptCount ||
    finalState?.blockedAttemptCount !== blockedAttemptCount ||
    finalState?.unknownAttemptCount !== unknownAttemptCount
  ) {
    addFailure(
      failures,
      "FinalStateMismatch",
      "finalState counts must be derived from attempt results",
    );
  }
  if (finalState?.aggregateAssurance === "complete") {
    if (readyAttemptCount !== 1 || blockedAttemptCount !== 1 || unknownAttemptCount !== 0) {
      addFailure(
        failures,
        "AssuranceOverclaimed",
        "complete assurance requires exactly one ready and one blocked attempt",
      );
    }
  } else {
    addFailure(
      failures,
      "AssuranceOverclaimed",
      "fixture must explicitly prove complete aggregate assurance",
    );
  }
}

function buildResult(input, failures) {
  const attempts = Array.isArray(input?.attempts) ? input.attempts : [];
  const readyAttemptCount = attempts.filter((attempt) => attempt?.result === "ready").length;
  const blockedAttemptCount = attempts.filter((attempt) => attempt?.result === "blocked").length;
  return {
    contractVersion: CONTRACT_VERSION,
    authority: AUTHORITY,
    fixtureId: typeof input?.fixtureId === "string" ? input.fixtureId : "",
    status: failures.length === 0 ? "pass" : "fail",
    readyAttemptCount,
    blockedAttemptCount,
    unknownAttemptCount: attempts.length - readyAttemptCount - blockedAttemptCount,
    failures,
  };
}

async function main() {
  const fixturePath =
    process.argv[2] ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      ".lobster",
      "release-activation-fixture.json",
    );
  const input = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const result = validateReleaseActivationFixture(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
