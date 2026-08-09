import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_ID = "lobster.dgr.immutable-lifecycle-obligations.v1";
const HASH_REF = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_REF = /^hmac-sha256:v1:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9:._-]{0,127}$/u;
const INPUT_KEYS = new Set(["schemaVersion", "evidenceType", "plan", "events", "final"]);
const PLAN_KEYS = new Set([
  "planId",
  "membershipGeneration",
  "acceptedAt",
  "authorityRef",
  "policyGeneration",
  "requiredChildIds",
  "children",
]);
const CHILD_KEYS = new Set(["childId", "operationId", "ownerGeneration", "mode"]);
const FINAL_CHECK_KEYS = new Set([
  "sequence",
  "kind",
  "childId",
  "operationId",
  "authority",
  "authorityRef",
  "policyGeneration",
  "ownerGeneration",
  "hold",
  "holdGeneration",
  "outcome",
  "reason",
]);
const MUTATION_KEYS = new Set([
  "sequence",
  "kind",
  "childId",
  "operationId",
  "effectRef",
  "outcome",
]);
const ACKNOWLEDGEMENT_KEYS = new Set([
  "sequence",
  "kind",
  "childId",
  "operationId",
  "effectRef",
  "outcome",
]);
const RECONCILIATION_KEYS = new Set([
  "sequence",
  "kind",
  "childId",
  "operationId",
  "effectRef",
  "evidenceRef",
  "outcome",
  "settlement",
]);
const SETTLEMENT_KEYS = new Set([
  "sequence",
  "kind",
  "childId",
  "operationId",
  "effectRef",
  "evidenceRef",
  "settlement",
]);
const FINAL_KEYS = new Set([
  "planId",
  "membershipGeneration",
  "requiredChildIds",
  "settledChildIds",
  "effectCounts",
  "status",
  "assuranceComplete",
]);
const EFFECT_COUNT_KEYS = new Set(["childId", "count"]);

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
    validIdentifierList(expected) &&
    JSON.stringify([...actual].toSorted((a, b) => a.localeCompare(b))) ===
      JSON.stringify([...expected].toSorted((a, b) => a.localeCompare(b)))
  );
}

function allowedEventKeys(kind) {
  if (kind === "final_check") {
    return FINAL_CHECK_KEYS;
  }
  if (kind === "mutation") {
    return MUTATION_KEYS;
  }
  if (kind === "acknowledgement") {
    return ACKNOWLEDGEMENT_KEYS;
  }
  if (kind === "reconciliation") {
    return RECONCILIATION_KEYS;
  }
  if (kind === "settlement") {
    return SETTLEMENT_KEYS;
  }
  return new Set();
}

function validPlan(plan) {
  if (
    !hasOnlyKeys(plan, PLAN_KEYS) ||
    !OPERATION_REF.test(plan?.planId ?? "") ||
    !HASH_REF.test(plan?.membershipGeneration ?? "") ||
    !Number.isInteger(plan?.acceptedAt) ||
    plan.acceptedAt <= 0 ||
    !HASH_REF.test(plan?.authorityRef ?? "") ||
    !HASH_REF.test(plan?.policyGeneration ?? "") ||
    !validIdentifierList(plan?.requiredChildIds) ||
    !Array.isArray(plan?.children)
  ) {
    return false;
  }
  const childIds = [];
  for (const child of plan.children) {
    if (
      !hasOnlyKeys(child, CHILD_KEYS) ||
      !validIdentifier(child?.childId) ||
      childIds.includes(child.childId) ||
      !OPERATION_REF.test(child?.operationId ?? "") ||
      !HASH_REF.test(child?.ownerGeneration ?? "") ||
      !["export", "unlink", "archive_and_remove", "purge", "expire"].includes(child?.mode)
    ) {
      return false;
    }
    childIds.push(child.childId);
  }
  return sameStringSet(childIds, plan.requiredChildIds);
}

function validEventShape(event) {
  const allowedKeys = allowedEventKeys(event?.kind);
  if (
    !hasOnlyKeys(event, allowedKeys) ||
    !Number.isInteger(event?.sequence) ||
    !validIdentifier(event?.childId) ||
    !OPERATION_REF.test(event?.operationId ?? "")
  ) {
    return false;
  }
  if (event.kind === "final_check") {
    return (
      ["authorized", "revoked"].includes(event.authority) &&
      HASH_REF.test(event.authorityRef ?? "") &&
      HASH_REF.test(event.policyGeneration ?? "") &&
      HASH_REF.test(event.ownerGeneration ?? "") &&
      ["none", "active"].includes(event.hold) &&
      HASH_REF.test(event.holdGeneration ?? "") &&
      ["authorized", "blocked"].includes(event.outcome)
    );
  }
  if (event.kind === "mutation") {
    return HASH_REF.test(event.effectRef ?? "") && event.outcome === "applied";
  }
  if (event.kind === "acknowledgement") {
    return HASH_REF.test(event.effectRef ?? "") && ["received", "unknown"].includes(event.outcome);
  }
  if (event.kind === "reconciliation") {
    return (
      HASH_REF.test(event.effectRef ?? "") &&
      HASH_REF.test(event.evidenceRef ?? "") &&
      event.outcome === "resolved_existing" &&
      event.settlement === "complete"
    );
  }
  return (
    event.kind === "settlement" &&
    HASH_REF.test(event.effectRef ?? "") &&
    HASH_REF.test(event.evidenceRef ?? "") &&
    event.settlement === "complete"
  );
}

export function validateImmutableLifecycleObligations(input) {
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
      ...(validIdentifier(details?.childId) ? { childId: details.childId } : {}),
    });
  };
  const plan = input?.plan;
  const events = Array.isArray(input?.events) ? input.events : [];
  const final = input?.final;

  if (
    input?.schemaVersion !== 1 ||
    input?.evidenceType !== "data.lifecycle_obligations" ||
    !hasOnlyKeys(input, INPUT_KEYS) ||
    !validPlan(plan) ||
    !Array.isArray(input?.events) ||
    !hasOnlyKeys(final, FINAL_KEYS) ||
    !Array.isArray(final?.effectCounts) ||
    final.effectCounts.some((entry) => !hasOnlyKeys(entry, EFFECT_COUNT_KEYS))
  ) {
    fail("ContractMismatch");
  }
  if (events.some((event) => !hasOnlyKeys(event, allowedEventKeys(event?.kind)))) {
    fail("SensitivePayloadPresent");
  }
  if (!validPlan(plan)) {
    fail("PlanInvalid");
  }

  const children = new Map(
    Array.isArray(plan?.children) ? plan.children.map((child) => [child.childId, child]) : [],
  );
  const states = new Map(
    [...children.keys()].map((childId) => [
      childId,
      {
        authorized: false,
        authorizedSequence: undefined,
        effectCount: 0,
        effectRef: undefined,
        acknowledgement: undefined,
        settled: false,
        sawHoldBlock: false,
      },
    ]),
  );

  for (const [index, event] of events.entries()) {
    if (event?.sequence !== index + 1 || !validEventShape(event)) {
      fail("EventInvalid", event);
    }
    const child = children.get(event?.childId);
    if (!child) {
      fail("UnplannedChild", event);
      continue;
    }
    const state = states.get(event.childId);
    if (event.operationId !== child.operationId) {
      fail("OperationIdentityChanged", event);
    }

    if (event.kind === "final_check") {
      state.authorized = false;
      state.authorizedSequence = undefined;
      const authorityCurrent =
        event.authority === "authorized" && event.authorityRef === plan.authorityRef;
      const policyCurrent = event.policyGeneration === plan.policyGeneration;
      const ownerCurrent = event.ownerGeneration === child.ownerGeneration;
      const held = event.hold === "active";
      const expectedReason = !authorityCurrent
        ? "authority_revoked"
        : !policyCurrent
          ? "policy_changed"
          : !ownerCurrent
            ? "owner_generation_changed"
            : held
              ? "hold_active"
              : undefined;
      if (!authorityCurrent && event.outcome === "authorized") {
        fail("StaleAuthorityAuthorized", event);
      }
      if (!policyCurrent && event.outcome === "authorized") {
        fail("PolicyGenerationChanged", event);
      }
      if (!ownerCurrent && event.outcome === "authorized") {
        fail("OwnerGenerationChanged", event);
      }
      if (held && event.outcome === "authorized") {
        fail("HeldMutationAuthorized", event);
      }
      if (expectedReason === undefined) {
        if (event.outcome !== "authorized" || event.reason !== undefined) {
          fail("FinalFenceInvalid", event);
        } else {
          state.authorized = true;
          state.authorizedSequence = event.sequence;
        }
      } else {
        if (event.outcome !== "blocked" || event.reason !== expectedReason) {
          fail("FinalFenceInvalid", event);
        }
        state.sawHoldBlock ||= expectedReason === "hold_active";
      }
      continue;
    }

    if (event.kind === "mutation") {
      if (
        !state.authorized ||
        state.authorizedSequence !== event.sequence - 1 ||
        event.operationId !== child.operationId
      ) {
        fail("EffectWithoutAuthorization", event);
      }
      state.authorized = false;
      state.authorizedSequence = undefined;
      state.effectCount += 1;
      if (state.effectCount > 1) {
        fail("DuplicateMutation", event);
      }
      state.effectRef ??= event.effectRef;
      if (event.effectRef !== state.effectRef) {
        fail("DuplicateMutation", event);
      }
      continue;
    }

    if (event.effectRef !== state.effectRef || state.effectCount === 0) {
      fail("SettlementInvalid", event);
      continue;
    }
    if (event.kind === "acknowledgement") {
      state.acknowledgement = event.outcome;
    } else if (event.kind === "reconciliation") {
      if (state.acknowledgement !== "unknown" || event.operationId !== child.operationId) {
        fail("ReconciliationInvalid", event);
      } else {
        state.settled = true;
        state.acknowledgement = "resolved";
      }
    } else if (event.kind === "settlement") {
      if (state.acknowledgement !== "received") {
        fail("SettlementInvalid", event);
      } else {
        state.settled = true;
      }
    }
  }

  const requiredChildIds = validIdentifierList(plan?.requiredChildIds) ? plan.requiredChildIds : [];
  const settledChildIds = [...states.entries()]
    .filter(([, state]) => state.settled)
    .map(([childId]) => childId);
  const effectCounts = [...states.entries()].map(([childId, state]) => ({
    childId,
    count: state.effectCount,
  }));
  const unresolvedAcknowledgements = [...states.values()].filter(
    (state) => state.acknowledgement === "unknown",
  ).length;
  const blockedBeforeEffect = [...states.values()].filter((state) => state.sawHoldBlock).length;
  const allSettled =
    requiredChildIds.length > 0 &&
    settledChildIds.length === requiredChildIds.length &&
    unresolvedAcknowledgements === 0 &&
    effectCounts.every((entry) => entry.count === 1);

  if (unresolvedAcknowledgements > 0) {
    fail("AmbiguousAcknowledgementUnresolved");
  }
  if (!sameStringSet(final?.requiredChildIds, requiredChildIds)) {
    fail("RequiredMembershipChanged");
  }
  if (
    final?.planId !== plan?.planId ||
    final?.membershipGeneration !== plan?.membershipGeneration ||
    !sameStringSet(final?.settledChildIds, settledChildIds) ||
    JSON.stringify(final?.effectCounts) !== JSON.stringify(effectCounts) ||
    final?.status !== (allSettled ? "complete" : "partial") ||
    final?.assuranceComplete !== allSettled
  ) {
    fail("FinalStateMismatch");
  }
  if (final?.assuranceComplete === true && !allSettled) {
    fail("AggregateOverclaimed");
  }

  failures.sort((a, b) => a.code.localeCompare(b.code));
  return {
    fixtureId: FIXTURE_ID,
    status: failures.length === 0 ? "accepted" : "rejected",
    failures,
    reconciliation: {
      requiredChildCount: requiredChildIds.length,
      settledChildCount: settledChildIds.length,
      blockedBeforeEffect,
      effectCount: effectCounts.reduce((sum, entry) => sum + entry.count, 0),
      unresolvedAcknowledgements,
      status: allSettled ? "complete" : "partial",
      assuranceComplete: allSettled,
    },
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/immutable-lifecycle-obligations-fixture.json"),
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
      result: validateImmutableLifecycleObligations(entry.input),
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(runFixture(), null, 2)}\n`);
}
