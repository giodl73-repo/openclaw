#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFailedTrailer } from "./lib/failed-trailer.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_CONTRACTS = [
  ["XPK-001", [], "#/sharedResults"],
  ["XPK-002", ["XPK-001"], "#/relationshipReferences"],
  ["XPK-003", ["XPK-001", "XPK-002"], "#/evidenceIntegrity"],
  ["XPK-004", ["XPK-001", "XPK-002", "XPK-003"], "#/managedMutation"],
  ["XPK-005", ["XPK-001", "XPK-003"], "#/deploymentProfiles"],
  ["XPK-006", ["XPK-001", "XPK-002", "XPK-005"], "#/implementationSelection"],
  ["XPK-007", ["XPK-001", "XPK-002", "XPK-003"], "#/fixtureRegistry"],
  ["XPK-008", ["XPK-002", "XPK-003", "XPK-005"], "#/trustOrder"],
  ["XPK-009", ["XPK-001", "XPK-006", "XPK-008"], "#/ledger"],
];
const EXPECTED_SHARED_RESULTS = [
  ["configuration-activation", "CFA", ["CFA"]],
  ["readiness-profile", "CFA", ["CFA", "RFN"]],
  ["unit-release-recovery", "EAR", ["EAR"]],
  ["checkpoint-restore", "KCC", ["KCC"]],
  ["fleet-lifecycle", "OAF", ["OAF"]],
  ["run-attempt", "ARO", ["ARO"]],
  ["provider-usage", "MPU", ["MPU"]],
  ["authority-effect-delivery", "IAE", ["IAE"]],
  ["knowledge-continuity", "KCC", ["KCC"]],
  ["lifecycle-resource", "DGR", ["DGR"]],
  ["operator-projection", "EXA", ["EXA"]],
  ["artifact-release-evidence", "EAR", ["EAR"]],
];
const EXPECTED_REFERENCES = [
  ["ownerRef", ["ownerType", "ownerId"]],
  ["subjectRef", ["ownerNativeSubjectId"]],
  ["generationRef", ["immutableGenerationOrExplicitLegacyUnknown"]],
  ["operationRef", ["acceptedSemanticOperationId"]],
  ["decisionRef", ["decisionId", "generation", "expiry", "normalizedIntent"]],
  ["attemptRef", ["boundedTryId", "fixedGenerations"]],
  ["parentRef", ["relationshipType", "parentOwnerRef"]],
  ["childRef", ["immutableChildId", "parentPlanOrOperation", "acceptedMembership"]],
  [
    "copyRef",
    [
      "sourceOwner",
      "sourceGeneration",
      "copyOwner",
      "copyId",
      "relationship",
      "retentionOrHold",
      "externalOrUnknown",
    ],
  ],
  [
    "leaseRef",
    [
      "resourceOwner",
      "scope",
      "generation",
      "holder",
      "capacity",
      "expiry",
      "fencingToken",
      "settlement",
    ],
  ],
  [
    "deliveryRef",
    [
      "deliveryOperation",
      "nativeAttempt",
      "routeGeneration",
      "renderGeneration",
      "receipt",
      "replayPolicy",
      "certainty",
    ],
  ],
  [
    "artifactRef",
    ["sourceCoordinate", "immutableDigest", "provenanceAuthority", "verificationResult"],
  ],
  [
    "componentRef",
    [
      "componentOwner",
      "artifactRef",
      "protocolRange",
      "schemaRange",
      "stateRange",
      "migrationRequirements",
    ],
  ],
  [
    "releaseRef",
    [
      "exactComponentTuple",
      "candidateGeneration",
      "activation",
      "readiness",
      "recovery",
      "publicationEvidence",
    ],
  ],
  [
    "planRef",
    ["acceptedPlanId", "immutableRequiredChildren", "membershipGeneration", "acceptanceTime"],
  ],
  ["evidenceRefs", ["integrityBearingReferencesOnly"]],
  ["compatibility", ["state"]],
];
const EXPECTED_RELATIONSHIP_EVIDENCE_FIELDS = [
  "observedChronology",
  "acceptedChronology",
  "effectiveChronology",
  "settledChronology",
  "freshness",
  "certainty",
  "disclosure",
  "omission",
  "supersession",
];
const EXPECTED_RELATIONSHIP_INVARIANTS = [
  "owner-native-payload-is-not-copied",
  "shared-reference-meanings-cannot-be-redefined",
  "domain-specific-opaque-references-may-be-added",
];
const EXPECTED_PROFILES = [
  "local-baseline",
  "local-governed",
  "managed-workspace",
  "managed-fleet",
];
const EXPECTED_PROFILE_RULES = [
  {
    kind: "template",
    managedDependency: "none",
    riskPosture: "existing-local-behavior-remains-complete",
    legacyArtifactPolicy: "existing-local-policy-with-explicit-migration-sunset",
    offlineBehavior: "owner-native-local-behavior",
    degradedBehavior: "managed-governance-remains-removable",
    containment: "local-owner-actions-only",
    breakGlass: "not-applicable-without-protected-managed-effects",
    measurementOwner: "local-runtime-owner",
    budgetPolicy: "concrete-positive-thresholds-required-in-profile-instance-before-admission",
  },
  {
    kind: "template",
    managedDependency: "local-policy-and-evidence",
    riskPosture: "declared-protected-operations-fail-closed",
    legacyArtifactPolicy: "warn-quarantine-or-block-with-explicit-sunset",
    offlineBehavior: "cached-local-policy-only",
    degradedBehavior: "ordinary-owner-operations-retain-documented-local-behavior",
    containment: "route-isolation-credential-revocation-admission-freeze-process-stop",
    breakGlass: "separately-authorized-time-bounded-evidenced",
    measurementOwner: "local-governance-owner",
    budgetPolicy: "concrete-positive-thresholds-required-in-profile-instance-before-admission",
  },
  {
    kind: "template",
    managedDependency: "lobster-desired-state-and-policy",
    riskPosture: "fresh-signed-cache-allowed-required-decisions-fail-closed",
    legacyArtifactPolicy: "quarantine-or-block-with-managed-migration-sunset",
    offlineBehavior: "fresh-signed-cache-with-risk-class-expiry",
    degradedBehavior: "required-unavailable-decisions-fail-closed-by-risk-class",
    containment: "route-isolation-credential-revocation-admission-freeze-process-stop",
    breakGlass: "separately-authorized-time-bounded-evidenced",
    measurementOwner: "workspace-operations-owner",
    budgetPolicy: "concrete-positive-thresholds-required-in-profile-instance-before-admission",
  },
  {
    kind: "template",
    managedDependency: "lobster-rollout-retention-budget-and-repair",
    riskPosture: "per-unit-truth-authoritative-aggregate-unknown-never-success",
    legacyArtifactPolicy: "fleet-quarantine-with-enforced-migration-sunset",
    offlineBehavior: "per-unit-policy-cache-with-unknown-reachability",
    degradedBehavior: "aggregate-unknown-or-partial-never-becomes-success",
    containment: "route-isolation-credential-revocation-admission-freeze-process-stop-quarantine",
    breakGlass: "separately-authorized-time-bounded-evidenced",
    measurementOwner: "fleet-operations-owner",
    budgetPolicy: "concrete-positive-thresholds-required-in-profile-instance-before-admission",
  },
];
const EXPECTED_EVIDENCE_FIELDS = [
  "evidenceId",
  "producer",
  "subjectRef",
  "operationRef",
  "attemptRef",
  "chronology",
  "authorityGeneration",
  "policyGeneration",
  "ownerGeneration",
  "artifactGeneration",
  "componentGeneration",
  "releaseGeneration",
  "contentDigest",
  "integrityMechanism",
  "classification",
  "disclosureClass",
  "omissions",
  "retention",
  "legalHold",
  "expiry",
  "supersessionRefs",
  "verificationResult",
  "verifierRef",
  "exportRefs",
];
const EXPECTED_EVIDENCE_CLASSIFICATIONS = [
  "accepted",
  "denied",
  "failed",
  "partial",
  "unknown",
  "superseded",
  "corrected",
];
const EXPECTED_EVIDENCE_FAILURE_CLASSES = [
  "best-effort-diagnostics",
  "required-operational-receipt",
  "protected-effect-authorization",
  "post-effect-settlement",
  "compliance-export",
];
const EXPECTED_EVIDENCE_FAILURE_MATRIX = [
  {
    class: "best-effort-diagnostics",
    behavior: "proceed-with-explicit-coverage-gap",
  },
  {
    class: "required-operational-receipt",
    behavior: "return-unknown-or-deferred-and-reconcile-by-operation",
  },
  {
    class: "protected-effect-authorization",
    behavior: "do-not-dispatch-until-durably-accepted",
  },
  {
    class: "post-effect-settlement",
    behavior: "preserve-owner-result-and-reconcile-without-replay",
  },
  {
    class: "compliance-export",
    behavior: "mark-incomplete-and-do-not-attest",
  },
];
const EXPECTED_EVIDENCE_VERIFICATION_CHECKS = [
  "content-integrity",
  "signer-or-authority",
  "generation-binding",
  "chronology",
  "supersession",
  "retention-state",
];
const EXPECTED_EVIDENCE_ATTESTATION_RULES = [
  "export-is-not-attestation-unless-all-required-evidence-verifies",
  "export-is-not-attestation-unless-coverage-is-complete",
];
const EXPECTED_EVIDENCE_PROJECTION_RULES = [
  "preserve-stable-machine-identifiers",
  "sanitize-human-detail",
  "do-not-copy-secrets-or-unrestricted-owner-payloads",
];
const EXPECTED_TERMINAL_CLASSES = [
  "parse-failure",
  "unsupported-operation",
  "missing-authority",
  "policy-deny",
  "user-deny",
  "timeout",
  "target-mismatch",
  "approved-handler-failure",
];
const EXPECTED_MUTATION_FIELDS = [
  "actorRef",
  "authorityGeneration",
  "policyGeneration",
  "ownerRef",
  "subjectRef",
  "normalizedTarget",
  "expectedGeneration",
  "operationRef",
  "idempotency",
  "intentDigest",
  "preview",
  "validation",
  "ownerResult",
  "conflict",
  "retry",
  "syncLoop",
  "sourceGeneration",
  "loopPreventionToken",
  "sanitizedError",
];
const EXPECTED_BUDGET_REQUIREMENTS = [
  ["latency", ["p95", "p99"], "milliseconds"],
  ["cold-start", ["p95", "p99"], "milliseconds"],
  ["memory", ["p95", "p99"], "bytes"],
  ["freshness", ["maximum"], "seconds"],
  ["reconnect", ["p95", "p99"], "milliseconds"],
  ["queue-backpressure", ["maximum-depth", "maximum-age"], "items-and-milliseconds"],
  ["recovery", ["p95", "p99"], "seconds"],
];
const EXPECTED_DEGRADED_SERVICES = [
  "policy",
  "approval",
  "evidence",
  "release",
  "identity",
  "fleet",
];
const EXPECTED_CONTAINMENT_ACTIONS = [
  "route-isolation",
  "credential-revocation",
  "admission-freeze",
  "process-stop",
  "quarantine",
  "unknown-reachability",
];
const EXPECTED_RISK_INVARIANTS = [
  "protected-effects-cannot-be-made-permissive-by-admin-override",
  "break-glass-is-separately-authorized-time-bounded-and-evidenced",
  "aggregate-unknown-or-partial-never-becomes-success",
];
const EXPECTED_FIXTURE_FIELDS = [
  "id",
  "schemaVersion",
  "ownerOracle",
  "status",
  "acceptedResult",
  "structuredFailure",
  "compatibility",
  "runners",
];
const EXPECTED_COMPATIBILITY_STATES = [
  "current",
  "legacy",
  "optional-unknown",
  "incompatible",
  "unsupported",
  "malformed",
  "unknown",
];
const EXPECTED_LEDGER_FIELDS = [
  "id",
  "classification",
  "owner",
  "baseCommit",
  "sourceSha",
  "patchId",
  "dependencies",
  "destination",
  "fixtureIds",
  "replacement",
  "minimumRelease",
  "mixedVersionWindow",
  "rollback",
  "delete",
  "retain",
  "zeroOldPathEvidence",
  "expiry",
  "status",
];
const EXPECTED_TRUST_ORDER = [
  "resolve-immutable-artifact",
  "verify-digest-signature-authority-expiry-revocation",
  "parse",
  "validate-protocol-schema-state-compatibility",
  "create-or-validate-checkpoint",
  "stage-and-migrate-under-target-owner",
  "load-policy-and-authority",
  "activate-one-implementation",
  "observe-exact-candidate-readiness",
  "commit-or-recover",
  "publish-actual-artifact-proof",
];
const EXPECTED_PUBLISHED_ARTIFACT_PROOF = [
  "published-bytes-in-clean-environment",
  "compatible-component-set",
  "partial-publication",
  "fresh-install",
  "upgrade",
  "downgrade-refusal",
  "rollback",
  "recovery-blocked",
];

function fail(message) {
  throw new Error(message);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function requireLowercaseSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    fail(`${label} must be a full lowercase Git commit SHA`);
  }
}

function isValidUtcTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/);
  if (!match) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  );
}

function requireExactList(actual, expected, label) {
  if (!Array.isArray(actual) || stableJson(actual) !== stableJson(expected)) {
    fail(`${label} must match the required order and values`);
  }
}

function requireUniqueStrings(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    fail(`${label} must be an array of non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    fail(`${label} must not contain duplicates`);
  }
}

function validateExecution(manifest) {
  if (
    !Array.isArray(manifest.contracts) ||
    manifest.contracts.length !== EXPECTED_CONTRACTS.length
  ) {
    fail("contracts must contain XPK-001 through XPK-009");
  }
  const seen = new Set();
  for (const [index, contract] of manifest.contracts.entries()) {
    const [expectedId, expectedDependencies, expectedOwnerPath] = EXPECTED_CONTRACTS[index];
    if (contract?.id !== expectedId) {
      fail(`contracts[${index}].id must be ${String(expectedId)}`);
    }
    requireExactList(contract.dependsOn, expectedDependencies, `${contract.id}.dependsOn`);
    for (const dependency of contract.dependsOn) {
      if (!seen.has(dependency)) {
        fail(`${contract.id} dependency ${dependency} must appear earlier`);
      }
    }
    seen.add(contract.id);
    requireNonEmpty(contract.title, `${contract.id}.title`);
    if (contract.ownerPath !== expectedOwnerPath) {
      fail(`${contract.id}.ownerPath must be ${String(expectedOwnerPath)}`);
    }
    requireNonEmpty(contract.acceptedArtifact, `${contract.id}.acceptedArtifact`);
    requireNonEmpty(contract.structuredFailure, `${contract.id}.structuredFailure`);
  }
}

function validateSharedResults(manifest) {
  if (
    !Array.isArray(manifest.sharedResults) ||
    manifest.sharedResults.length !== EXPECTED_SHARED_RESULTS.length
  ) {
    fail("sharedResults must publish the complete Wave 0 ownership map");
  }
  const ids = new Set();
  for (const [index, result] of manifest.sharedResults.entries()) {
    const [expectedId, expectedOwner, expectedImplementations] = EXPECTED_SHARED_RESULTS[index];
    requireNonEmpty(result?.id, `sharedResults[${index}].id`);
    if (ids.has(result.id)) {
      fail(`shared result ${result.id} has more than one producer`);
    }
    ids.add(result.id);
    if (result.id !== expectedId || result.semanticOwner !== expectedOwner) {
      fail(
        `sharedResults[${index}] must be owned as ${String(expectedId)} by ${String(expectedOwner)}`,
      );
    }
    requireExactList(
      result.producerImplementations,
      expectedImplementations,
      `sharedResults[${index}].producerImplementations`,
    );
    requireUniqueStrings(result.consumers, `sharedResults[${index}].consumers`);
    if (result.consumers.length === 0) {
      fail(`sharedResults[${index}].consumers must not be empty`);
    }
  }
}

function validateReferences(manifest) {
  if (!Array.isArray(manifest.relationshipReferences)) {
    fail("relationshipReferences must be an array");
  }
  for (const [index, reference] of manifest.relationshipReferences.entries()) {
    const [expectedName, expectedFacets] = EXPECTED_REFERENCES[index] ?? [];
    if (reference?.name !== expectedName) {
      fail(`relationshipReferences[${index}].name must be ${String(expectedName)}`);
    }
    if (reference.payloadNeutral !== true) {
      fail(`relationshipReferences[${index}] must remain payload-neutral`);
    }
    requireExactList(
      reference.requiredFacets,
      expectedFacets,
      `relationshipReferences[${index}].requiredFacets`,
    );
  }
  if (manifest.relationshipReferences.length !== EXPECTED_REFERENCES.length) {
    fail("relationshipReferences must publish the complete shared reference vocabulary");
  }
  requireExactList(
    manifest.relationshipEvidenceFields,
    EXPECTED_RELATIONSHIP_EVIDENCE_FIELDS,
    "relationshipEvidenceFields",
  );
  requireExactList(
    manifest.relationshipInvariants,
    EXPECTED_RELATIONSHIP_INVARIANTS,
    "relationshipInvariants",
  );
}

function validateEvidence(manifest) {
  const evidence = manifest.evidenceIntegrity;
  requireExactList(
    evidence?.requiredFields,
    EXPECTED_EVIDENCE_FIELDS,
    "evidenceIntegrity.requiredFields",
  );
  requireExactList(
    evidence?.classifications,
    EXPECTED_EVIDENCE_CLASSIFICATIONS,
    "evidenceIntegrity.classifications",
  );
  if (!Array.isArray(evidence?.failureMatrix) || evidence.failureMatrix.length !== 5) {
    fail("evidenceIntegrity.failureMatrix must define all five evidence classes");
  }
  const classes = new Set();
  for (const [index, entry] of evidence.failureMatrix.entries()) {
    requireNonEmpty(entry?.class, `evidenceIntegrity.failureMatrix[${index}].class`);
    requireNonEmpty(entry?.behavior, `evidenceIntegrity.failureMatrix[${index}].behavior`);
    if (classes.has(entry.class)) {
      fail(`evidence failure class ${entry.class} is duplicated`);
    }
    classes.add(entry.class);
  }
  requireExactList(
    [...classes],
    EXPECTED_EVIDENCE_FAILURE_CLASSES,
    "evidenceIntegrity.failureMatrix classes",
  );
  if (stableJson(evidence.failureMatrix) !== stableJson(EXPECTED_EVIDENCE_FAILURE_MATRIX)) {
    fail("evidenceIntegrity.failureMatrix must preserve required sink-failure behavior");
  }
  requireExactList(
    evidence.verificationChecks,
    EXPECTED_EVIDENCE_VERIFICATION_CHECKS,
    "evidenceIntegrity.verificationChecks",
  );
  requireExactList(
    evidence.attestationRules,
    EXPECTED_EVIDENCE_ATTESTATION_RULES,
    "evidenceIntegrity.attestationRules",
  );
  requireExactList(
    evidence.projectionRules,
    EXPECTED_EVIDENCE_PROJECTION_RULES,
    "evidenceIntegrity.projectionRules",
  );
  requireExactList(
    evidence.terminalClasses,
    EXPECTED_TERMINAL_CLASSES,
    "evidenceIntegrity.terminalClasses",
  );
}

function validateMutation(manifest) {
  const mutation = manifest.managedMutation;
  requireExactList(
    mutation?.steps,
    [
      "authenticate-actor",
      "resolve-authority-and-policy",
      "normalize-owner-target",
      "load-expected-generation",
      "preview-or-validate",
      "authorize-normalized-intent",
      "owner-accepts-or-rejects",
      "owner-mutates",
      "owner-validates-and-settles",
      "return-sanitized-result-and-evidence",
    ],
    "managedMutation.steps",
  );
  requireExactList(
    mutation.requiredFields,
    EXPECTED_MUTATION_FIELDS,
    "managedMutation.requiredFields",
  );
  if (mutation.retryIdentity !== "operationRef") {
    fail("managedMutation.retryIdentity must be operationRef");
  }
  if (mutation.connectorDelivery !== "at-least-once-reconcile-before-replay") {
    fail("managedMutation.connectorDelivery must reconcile at-least-once delivery before replay");
  }
}

function validateProfiles(manifest) {
  if (!Array.isArray(manifest.deploymentProfiles)) {
    fail("deploymentProfiles must be an array");
  }
  const profileIds = manifest.deploymentProfiles?.map((profile) => profile.id);
  requireExactList(profileIds, EXPECTED_PROFILES, "deploymentProfiles");
  for (const [index, profile] of manifest.deploymentProfiles.entries()) {
    for (const [field, expected] of Object.entries(EXPECTED_PROFILE_RULES[index])) {
      if (profile[field] !== expected) {
        fail(`deploymentProfiles[${index}].${field} must preserve the Wave 0 fail-mode contract`);
      }
    }
  }
  if (
    !Array.isArray(manifest.budgetRequirements) ||
    manifest.budgetRequirements.length !== EXPECTED_BUDGET_REQUIREMENTS.length
  ) {
    fail("budgetRequirements must define every measurable budget category");
  }
  for (const [index, budget] of manifest.budgetRequirements.entries()) {
    const [expectedCategory, expectedStatistics, expectedUnit] =
      EXPECTED_BUDGET_REQUIREMENTS[index];
    if (budget?.category !== expectedCategory || budget.unit !== expectedUnit) {
      fail(
        `budgetRequirements[${index}] must define ${String(expectedCategory)} in ${String(expectedUnit)}`,
      );
    }
    requireExactList(
      budget.statistics,
      expectedStatistics,
      `budgetRequirements[${index}].statistics`,
    );
    if (budget.thresholdType !== "positive-number" || budget.requiredPerProfileInstance !== true) {
      fail(`budgetRequirements[${index}] must require a positive profile-instance threshold`);
    }
  }
  requireExactList(
    manifest.requiredDegradedServices,
    EXPECTED_DEGRADED_SERVICES,
    "requiredDegradedServices",
  );
  requireExactList(
    manifest.requiredContainmentActions,
    EXPECTED_CONTAINMENT_ACTIONS,
    "requiredContainmentActions",
  );
  requireExactList(manifest.riskInvariants, EXPECTED_RISK_INVARIANTS, "riskInvariants");
}

function validateSelection(manifest) {
  requireExactList(
    manifest.implementationSelection?.invariants,
    [
      "desired-placement-is-not-local-selection",
      "one-authoritative-implementation-binds-before-admission-or-mutation",
      "shadow-is-effect-free",
      "rollback-settlement-is-explicit",
      "unknown-settlement-does-not-become-success",
    ],
    "implementationSelection.invariants",
  );
}

function validateFixtures(manifest, fixtures) {
  if (manifest.fixtureRegistry?.path !== "fixtures.json") {
    fail("fixtureRegistry.path must be fixtures.json");
  }
  requireExactList(
    manifest.fixtureRegistry.requiredFields,
    EXPECTED_FIXTURE_FIELDS,
    "fixtureRegistry.requiredFields",
  );
  requireExactList(
    manifest.fixtureRegistry.compatibilityStates,
    EXPECTED_COMPATIBILITY_STATES,
    "fixtureRegistry.compatibilityStates",
  );
  if (!fixtures || fixtures.schemaVersion !== 1 || !Array.isArray(fixtures.fixtures)) {
    fail("fixtures.json must use schemaVersion 1 and contain fixtures");
  }
  if (fixtures.fixtures.length === 0) {
    fail("fixtures.json must reserve at least one stable fixture identity");
  }
  const fixtureIds = new Set();
  for (const [index, fixture] of fixtures.fixtures.entries()) {
    requireNonEmpty(fixture?.id, `fixtures[${index}].id`);
    for (const field of manifest.fixtureRegistry.requiredFields) {
      if (fixture[field] === undefined || fixture[field] === null || fixture[field] === "") {
        fail(`fixtures[${index}].${field} is required by XPK-007`);
      }
    }
    if (fixtureIds.has(fixture.id)) {
      fail(`fixture ${fixture.id} is duplicated`);
    }
    fixtureIds.add(fixture.id);
    if (fixture.status !== "reserved" && fixture.status !== "implemented") {
      fail(`fixture ${fixture.id}.status must be reserved or implemented`);
    }
    if (fixture.status === "implemented") {
      requireNonEmpty(fixture.runner, `fixture ${fixture.id}.runner`);
      requireNonEmpty(fixture.evidence, `fixture ${fixture.id}.evidence`);
      if (!existsSync(resolve(ROOT, fixture.runner))) {
        fail(`fixture ${fixture.id}.runner must resolve to an executable runner`);
      }
      if (!existsSync(resolve(ROOT, fixture.evidence))) {
        fail(`fixture ${fixture.id}.evidence must resolve to checked-in evidence`);
      }
    }
    if (fixture.acceptedResult === fixture.structuredFailure) {
      fail(`fixture ${fixture.id} must distinguish accepted and failure results`);
    }
    if (
      stableJson(fixture.compatibility) !==
      stableJson({
        current: "required",
        legacy: "explicit",
        optionalUnknown: "preserve",
        requiredUnknown: "reject",
      })
    ) {
      fail(`fixture ${fixture.id} must preserve the reserved compatibility contract`);
    }
    if (
      fixture.runners?.typescript !== "required" ||
      fixture.runners?.rust !== "optional-until-cutover"
    ) {
      fail(`fixture ${fixture.id} must define TypeScript and Rust runner expectations`);
    }
  }
}

function validateTrustOrder(manifest) {
  requireExactList(manifest.trustOrder, EXPECTED_TRUST_ORDER, "trustOrder");
  requireExactList(
    manifest.publishedArtifactProofRequirements,
    EXPECTED_PUBLISHED_ARTIFACT_PROOF,
    "publishedArtifactProofRequirements",
  );
}

function validateLedger(manifest, fixtures, disposition) {
  if (manifest.ledger?.path !== "disposition.json") {
    fail("ledger.path must be disposition.json");
  }
  requireExactList(manifest.ledger.classifications, ["B1", "B2", "B3"], "ledger.classifications");
  requireExactList(
    manifest.ledger.statuses,
    ["planned", "build-only", "evidence-only", "release-eligible", "active", "expired", "deleted"],
    "ledger.statuses",
  );
  requireExactList(manifest.ledger.requiredFields, EXPECTED_LEDGER_FIELDS, "ledger.requiredFields");
  if (!disposition || disposition.schemaVersion !== 1 || !Array.isArray(disposition.entries)) {
    fail("disposition.json must expose an entries array");
  }
  requireExactList(
    disposition.format?.classifications,
    manifest.ledger.classifications,
    "disposition.format.classifications",
  );
  requireExactList(
    disposition.format?.statuses,
    manifest.ledger.statuses,
    "disposition.format.statuses",
  );
  requireExactList(
    disposition.format?.requiredFields,
    manifest.ledger.requiredFields,
    "disposition.format.requiredFields",
  );
  const fixtureIds = new Set(fixtures.fixtures.map((fixture) => fixture.id));
  const seenEntryIds = new Set();
  for (const [index, entry] of disposition.entries.entries()) {
    const label = `disposition.entries[${index}]`;
    for (const field of [
      "id",
      "owner",
      "destination",
      "replacement",
      "mixedVersionWindow",
      "rollback",
      "zeroOldPathEvidence",
    ]) {
      requireNonEmpty(entry[field], `${label}.${field}`);
    }
    if (seenEntryIds.has(entry.id)) {
      fail(`${label}.id ${entry.id} is duplicated`);
    }
    if (!manifest.ledger.classifications.includes(entry.classification)) {
      fail(`${label}.classification must be B1, B2, or B3`);
    }
    if (!manifest.ledger.statuses.includes(entry.status)) {
      fail(`${label}.status must be a declared ledger status`);
    }
    requireLowercaseSha(entry.baseCommit, `${label}.baseCommit`);
    requireLowercaseSha(entry.sourceSha, `${label}.sourceSha`);
    requireLowercaseSha(entry.patchId, `${label}.patchId`);
    for (const field of ["dependencies", "fixtureIds", "delete", "retain"]) {
      requireUniqueStrings(entry[field], `${label}.${field}`);
    }
    for (const dependency of entry.dependencies) {
      if (!seenEntryIds.has(dependency)) {
        fail(`${label}.dependencies reference ${dependency} before it is declared`);
      }
    }
    seenEntryIds.add(entry.id);
    if (entry.fixtureIds.length === 0) {
      fail(`${label}.fixtureIds must name decisive evidence`);
    }
    for (const fixtureId of entry.fixtureIds) {
      if (!fixtureIds.has(fixtureId)) {
        fail(`${label}.fixtureIds references unknown fixture ${fixtureId}`);
      }
    }
    if (entry.delete.length === 0) {
      fail(`${label}.delete must name the exact deletion target`);
    }
    if (!/^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.minimumRelease)) {
      fail(`${label}.minimumRelease must be an OpenClaw release version`);
    }
    if (!isValidUtcTimestamp(entry.expiry)) {
      fail(`${label}.expiry must be an RFC 3339 UTC timestamp`);
    }
  }
}

export function validateContracts({ manifest, fixtures, disposition }) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.phase !== "wave-0") {
    fail("contracts manifest must use schemaVersion 1 and phase wave-0");
  }
  requireNonEmpty(manifest.owner, "owner");
  if (manifest.authority !== "definition-only" || manifest.admissionReady !== false) {
    fail("Wave 0 contracts must remain definition-only with no admission authority");
  }
  requireLowercaseSha(manifest.baseCommit, "baseCommit");
  if (manifest.validationCommand !== "corepack pnpm lobster:contracts") {
    fail("validationCommand must be corepack pnpm lobster:contracts");
  }
  validateExecution(manifest);
  validateSharedResults(manifest);
  validateReferences(manifest);
  validateEvidence(manifest);
  validateMutation(manifest);
  validateProfiles(manifest);
  validateSelection(manifest);
  validateFixtures(manifest, fixtures);
  validateTrustOrder(manifest);
  validateLedger(manifest, fixtures, disposition);
  return {
    schemaVersion: 1,
    phase: manifest.phase,
    authority: manifest.authority,
    admissionReady: manifest.admissionReady,
    contractCount: manifest.contracts.length,
    sharedResultCount: manifest.sharedResults.length,
    relationshipReferenceCount: manifest.relationshipReferences.length,
    fixtureCount: fixtures.fixtures.length,
    ledgerEntryCount: disposition.entries.length,
    contractSetDigest: digest({ manifest, fixtures, disposition }),
  };
}

function parseArgs(argv) {
  const options = {
    manifest: resolve(ROOT, ".lobster/contracts.json"),
    fixtures: resolve(ROOT, ".lobster/fixtures.json"),
    disposition: resolve(ROOT, ".lobster/disposition.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      options.manifest = resolve(argv[++index] ?? fail("--manifest requires a path"));
    } else if (argument === "--fixtures") {
      options.fixtures = resolve(argv[++index] ?? fail("--fixtures requires a path"));
    } else if (argument === "--disposition") {
      options.disposition = resolve(argv[++index] ?? fail("--disposition requires a path"));
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = validateContracts({
    manifest: JSON.parse(readFileSync(options.manifest, "utf8")),
    fixtures: JSON.parse(readFileSync(options.fixtures, "utf8")),
    disposition: JSON.parse(readFileSync(options.disposition, "utf8")),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    writeFailedTrailer("lobster-contracts", process.exitCode, (message) =>
      process.stderr.write(`${String(message)}\n`),
    );
  }
}
