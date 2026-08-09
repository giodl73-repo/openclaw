import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROFILE_IDS = ["local", "container", "reverse-proxy", "node-mode"];
const PROFILE_CONDITIONS = {
  local: ["ProfileSelected"],
  container: ["ProfileSelected", "ContainerStateReady"],
  "reverse-proxy": ["ProfileSelected", "TrustedProxyReady"],
  "node-mode": [
    "ProfileSelected",
    "NodePairingReady",
    "ControlledTargetsReady",
    "CommandApprovalReady",
    "ControlChannelReady",
  ],
};
const SCENARIO_IDS = [
  "unprofiled",
  "local",
  "local-restarted",
  "container-ready",
  "container-loopback",
  "reverse-proxy-ready",
  "reverse-proxy-auth-missing",
  "node-not-ready",
  "node-unapproved",
  "node-ready",
  "workspace-ready",
  "workspace-full",
  "workspace-recovered",
];

function sameMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    JSON.stringify(actual.toSorted((a, b) => a.localeCompare(b))) ===
      JSON.stringify(expected.toSorted((a, b) => a.localeCompare(b)))
  );
}

export function validateHostingProfileEvidence(input) {
  const failures = [];
  const expected = input?.expected ?? {};
  const catalog = input?.catalog ?? {};
  const live = input?.live ?? {};
  const artifact = input?.artifact ?? {};

  if (catalog.contractVersion !== 1) {
    failures.push({ code: "CatalogContractMismatch" });
  }
  if (
    !sameMembers(
      catalog.profiles?.map((profile) => profile.id),
      PROFILE_IDS,
    )
  ) {
    failures.push({ code: "CatalogProfilesMismatch" });
  }

  if (
    live.contractVersion !== 1 ||
    live.profileContractVersion !== expected.profileContractVersion
  ) {
    failures.push({ code: "ProfileContractMismatch" });
  }
  if (live.activeProfile !== expected.profile) {
    failures.push({ code: "ActiveProfileMismatch" });
  }

  const expectedConditions = PROFILE_CONDITIONS[expected.profile] ?? [];
  for (const type of expectedConditions) {
    const matches = (live.conditions ?? []).filter((condition) => condition.type === type);
    if (matches.length !== 1) {
      failures.push({ code: "ProfileConditionMissing", type });
      continue;
    }
    if (matches[0].requirement !== "required") {
      failures.push({ code: "ProfileConditionNotRequired", type });
    }
  }

  const artifactProvenanceValid =
    artifact.contractVersion === 1 &&
    artifact.suite === "openclaw-standard-hosting-profiles" &&
    artifact.profileContractVersion === 1 &&
    artifact.package?.name === "openclaw" &&
    typeof artifact.package?.version === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(artifact.image?.id ?? "");
  if (!artifactProvenanceValid) {
    failures.push({ code: "ArtifactProvenanceInvalid" });
  }

  const scenarios = artifact.scenarios ?? [];
  if (
    !sameMembers(
      scenarios.map((scenario) => scenario.id),
      SCENARIO_IDS,
    )
  ) {
    failures.push({ code: "ArtifactScenarioSetMismatch" });
  }
  const passed = scenarios.filter((scenario) => scenario.passed === true).length;
  const summary = artifact.summary ?? {};
  if (
    summary.total !== scenarios.length ||
    summary.passed !== passed ||
    summary.failed !== scenarios.length - passed
  ) {
    failures.push({ code: "ArtifactSummaryMismatch" });
  }
  if (artifact.passed !== true || passed !== SCENARIO_IDS.length) {
    failures.push({ code: "ArtifactFailed" });
  }

  return {
    fixtureId: "lobster.exa.hosting-profile-conformance.v1",
    status: failures.length === 0 ? "accepted" : "rejected",
    conformant: live.conformant === true,
    ready: live.ready === true,
    failures,
  };
}

export function runFixture(
  path = resolve(ROOT, ".lobster/hosting-profile-conformance-fixture.json"),
) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const cases = fixture.cases.map((entry) => {
    const result = validateHostingProfileEvidence(entry.input);
    const failureCodes = result.failures.map((failure) => failure.code).toSorted();
    const expectedCodes = (entry.expected.failureCodes ?? []).toSorted();
    if (
      result.status !== entry.expected.status ||
      result.conformant !== entry.expected.conformant ||
      result.ready !== entry.expected.ready ||
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
