import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoningTokens", "total"];
const REDACTED_REF = /^sha256:[a-f0-9]{64}$/u;
const AUTH_PROFILE_REF = /^hmac-sha256:v1:[a-f0-9]{64}$/u;
const INPUT_KEYS = new Set([
  "schemaVersion",
  "evidenceType",
  "runId",
  "result",
  "attempts",
  "modelCalls",
  "runUsage",
]);
const ATTEMPT_KEYS = new Set([
  "candidateAttemptId",
  "runId",
  "ordinal",
  "provider",
  "model",
  "authProfileRef",
  "preparedRuntimeGeneration",
  "result",
  "reason",
  "modelCallIds",
  "usage",
]);
const CALL_KEYS = new Set([
  "modelCallId",
  "candidateAttemptId",
  "candidateLink",
  "runId",
  "provider",
  "model",
  "result",
  "usage",
  "upstreamRequestIdHash",
]);
const CANDIDATE_LINK_KEYS = new Set(["source", "phase"]);

function addUsage(target, usage) {
  if (!usage) {
    return;
  }
  for (const field of USAGE_FIELDS) {
    target[field] += usage[field] ?? 0;
  }
}

function emptyUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
}

function sameUsage(actual, expected) {
  return USAGE_FIELDS.every((field) => (actual?.[field] ?? 0) === (expected?.[field] ?? 0));
}

function isValidUsage(usage, extraKeys = []) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return false;
  }
  const allowedKeys = new Set([...USAGE_FIELDS, ...extraKeys]);
  return (
    Object.keys(usage).every((key) => allowedKeys.has(key)) &&
    USAGE_FIELDS.every(
      (field) =>
        usage[field] === undefined ||
        (typeof usage[field] === "number" && Number.isFinite(usage[field]) && usage[field] >= 0),
    )
  );
}

function hasOnlyKeys(value, allowedKeys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

export function validateProviderAttemptUsageEvidence(input) {
  const failures = [];
  const attempts = Array.isArray(input?.attempts) ? input.attempts : [];
  const calls = Array.isArray(input?.modelCalls) ? input.modelCalls : [];
  const runId = input?.runId;

  if (
    input?.schemaVersion !== 1 ||
    input?.evidenceType !== "model.candidate_attempts" ||
    typeof runId !== "string" ||
    !["completed_with_fallback", "blocked"].includes(input?.result) ||
    !Array.isArray(input?.attempts) ||
    !Array.isArray(input?.modelCalls)
  ) {
    failures.push({ code: "ContractMismatch" });
  }
  if (
    !hasOnlyKeys(input, INPUT_KEYS) ||
    attempts.some(
      (attempt) =>
        !hasOnlyKeys(attempt, ATTEMPT_KEYS) ||
        (attempt.usage !== null && !isValidUsage(attempt.usage)),
    ) ||
    calls.some(
      (call) =>
        !hasOnlyKeys(call, CALL_KEYS) ||
        !hasOnlyKeys(call.candidateLink, CANDIDATE_LINK_KEYS) ||
        (call.usage !== undefined && !isValidUsage(call.usage)),
    ) ||
    !isValidUsage(input?.runUsage, ["reconciles"])
  ) {
    failures.push({ code: "SensitivePayloadPresent" });
  }

  for (const id of duplicateValues(attempts.map((attempt) => attempt.candidateAttemptId))) {
    failures.push({ code: "DuplicateCandidateAttemptId", candidateAttemptId: id });
  }
  for (const identity of duplicateValues(
    calls.map((call) => `${call.candidateAttemptId}\u0000${call.modelCallId}`),
  )) {
    const [candidateAttemptId, modelCallId] = identity.split("\u0000");
    failures.push({
      code: "DuplicateModelCallIdentity",
      candidateAttemptId,
      modelCallId,
    });
  }

  const attemptsById = new Map();
  for (const [index, attempt] of attempts.entries()) {
    attemptsById.set(attempt.candidateAttemptId, attempt);
    if (
      attempt.runId !== runId ||
      attempt.ordinal !== index + 1 ||
      typeof attempt.candidateAttemptId !== "string" ||
      typeof attempt.provider !== "string" ||
      typeof attempt.model !== "string" ||
      !AUTH_PROFILE_REF.test(attempt.authProfileRef ?? "") ||
      !REDACTED_REF.test(attempt.preparedRuntimeGeneration ?? "") ||
      !["retryable_failure", "succeeded", "blocked"].includes(attempt.result)
    ) {
      failures.push({
        code: "CandidateBindingInvalid",
        candidateAttemptId: attempt.candidateAttemptId,
      });
    }
  }

  const callsByCandidate = new Map();
  for (const call of calls) {
    if (
      call.candidateLink?.source !== "fallback_runner" ||
      call.candidateLink?.phase !== "before_dispatch"
    ) {
      failures.push({
        code: "CandidateLinkNotDispatchBound",
        modelCallId: call.modelCallId,
      });
    }
    const attempt = attemptsById.get(call.candidateAttemptId);
    if (
      !attempt ||
      typeof call.modelCallId !== "string" ||
      call.runId !== runId ||
      call.provider !== attempt.provider ||
      call.model !== attempt.model ||
      !["completed", "error"].includes(call.result) ||
      (call.upstreamRequestIdHash !== undefined && !REDACTED_REF.test(call.upstreamRequestIdHash))
    ) {
      failures.push({
        code: "ModelCallParentInvalid",
        modelCallId: call.modelCallId,
      });
      continue;
    }
    const candidateCalls = callsByCandidate.get(call.candidateAttemptId) ?? [];
    candidateCalls.push(call);
    callsByCandidate.set(call.candidateAttemptId, candidateCalls);
  }

  const observedRunUsage = emptyUsage();
  for (const attempt of attempts) {
    const observedCalls = callsByCandidate.get(attempt.candidateAttemptId) ?? [];
    const observedCallIds = observedCalls.map((call) => call.modelCallId).toSorted();
    const declaredCallIds = (attempt.modelCallIds ?? []).toSorted();
    if (JSON.stringify(observedCallIds) !== JSON.stringify(declaredCallIds)) {
      failures.push({
        code: "CandidateCallSetMismatch",
        candidateAttemptId: attempt.candidateAttemptId,
      });
    }

    if (attempt.result === "blocked") {
      if (
        attempt.reason !== "prepared_runtime_generation_changed" ||
        observedCalls.length !== 0 ||
        attempt.usage !== null
      ) {
        failures.push({
          code: "FencedCandidateDispatched",
          candidateAttemptId: attempt.candidateAttemptId,
        });
      }
      continue;
    }
    if (
      (attempt.result === "retryable_failure" &&
        (observedCalls.length === 0 || observedCalls.some((call) => call.result !== "error"))) ||
      (attempt.result === "succeeded" && !observedCalls.some((call) => call.result === "completed"))
    ) {
      failures.push({
        code: "CandidateOutcomeMismatch",
        candidateAttemptId: attempt.candidateAttemptId,
      });
    }

    const observedCandidateUsage = emptyUsage();
    for (const call of observedCalls) {
      addUsage(observedCandidateUsage, call.usage);
      addUsage(observedRunUsage, call.usage);
    }
    if (!sameUsage(attempt.usage, observedCandidateUsage)) {
      failures.push({
        code: "CandidateUsageMismatch",
        candidateAttemptId: attempt.candidateAttemptId,
      });
    }
  }

  if (!sameUsage(input?.runUsage, observedRunUsage) || input?.runUsage?.reconciles !== true) {
    failures.push({ code: "RunUsageMismatch" });
  }

  if (input?.result === "completed_with_fallback") {
    const primary = attempts[0];
    const fallback = attempts.find((attempt) => attempt.result === "succeeded");
    if (
      primary?.result !== "retryable_failure" ||
      !fallback ||
      attempts.length !== 2 ||
      fallback.ordinal <= primary.ordinal ||
      (fallback.provider === primary.provider && fallback.model === primary.model)
    ) {
      failures.push({ code: "FallbackSequenceInvalid" });
    }
  } else if (attempts.length !== 1 || attempts[0]?.result !== "blocked" || calls.length !== 0) {
    failures.push({ code: "FallbackSequenceInvalid" });
  }

  return {
    fixtureId: "lobster.mpu.provider-attempt-usage.v1",
    status: failures.length === 0 ? "accepted" : "rejected",
    failures,
    reconciliation: {
      candidateCount: attempts.length,
      modelCallCount: calls.length,
      runUsage: observedRunUsage,
    },
  };
}

export function runFixture(path = resolve(ROOT, ".lobster/provider-attempt-usage-fixture.json")) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const cases = fixture.cases.map((entry) => {
    const result = validateProviderAttemptUsageEvidence(entry.input);
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
