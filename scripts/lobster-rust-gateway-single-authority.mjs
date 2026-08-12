import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFailedTrailer } from "./lib/failed-trailer.mjs";
import {
  dispatchSelectedRuntime,
  RuntimeCanarySelectionError,
} from "./lib/lobster-runtime-canary-selection.mjs";

const TOOL = "lobster:rust-gateway-single-authority";
const FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-single-authority-fixture.json"), "utf8"),
);

function fail(message) {
  throw new Error(message);
}

function runArtifactReadinessProof() {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/lobster-rust-gateway-artifact-readiness.mjs")],
    {
      encoding: "utf8",
      env: process.env,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? `selected Rust proof exited ${result.status ?? 1}`);
  }
  const lines = (result.stdout ?? "").trim().split(/\r?\n/u);
  const proof = JSON.parse(lines.at(-1) ?? "{}");
  if (
    proof.fixtureId !== "lobster.rfn.rust-gateway-artifact-readiness.v1" ||
    proof.receipt?.boundedProfileReadinessProven !== true ||
    proof.receipt?.authority !== "none"
  ) {
    fail("selected Rust runtime did not return the bounded artifact-readiness proof");
  }
  return proof;
}

const dispatchCounts = { typescript: 0, rust: 0 };
const dispatchers = {
  "typescript-baseline": async () => {
    dispatchCounts.typescript += 1;
    return { runtimeKind: "typescript" };
  },
  "rust-canary": async () => {
    dispatchCounts.rust += 1;
    return runArtifactReadinessProof();
  },
};

try {
  let rejected;
  try {
    await dispatchSelectedRuntime(FIXTURE.rejected.input, dispatchers);
    fail("ambiguous runtime selection unexpectedly dispatched");
  } catch (error) {
    if (!(error instanceof RuntimeCanarySelectionError)) {
      throw error;
    }
    rejected = {
      code: error.code,
      rejectedBeforeDispatch: true,
      dispatchCounts: { ...dispatchCounts },
    };
  }
  if (JSON.stringify(rejected) !== JSON.stringify(FIXTURE.rejected.expected)) {
    fail(`structured selection failure mismatch: ${JSON.stringify(rejected)}`);
  }

  const accepted = await dispatchSelectedRuntime(FIXTURE.accepted.input, dispatchers);
  const evidence = {
    schemaVersion: 1,
    fixtureId: FIXTURE.fixtureId,
    selection: accepted.selection,
    dispatchCounts,
    singleDispatchProven: dispatchCounts.rust === 1 && dispatchCounts.typescript === 0,
    selectedArtifactSha256: accepted.result.artifactSha256,
    selectedConnectionGeneration: accepted.result.receipt.connectionGeneration,
    selectedPairingGeneration: accepted.result.receipt.pairingGeneration,
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  };
  if (
    evidence.selection.runtimeId !== FIXTURE.accepted.expected.runtimeId ||
    !evidence.singleDispatchProven ||
    evidence.authority !== FIXTURE.accepted.expected.authority
  ) {
    fail(`single-authority evidence mismatch: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
  writeFailedTrailer(TOOL, 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  writeFailedTrailer(TOOL, 1);
  process.exitCode = 1;
}
