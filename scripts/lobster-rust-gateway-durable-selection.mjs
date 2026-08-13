import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFailedTrailer } from "./lib/failed-trailer.mjs";
import {
  readRuntimeSelectionReceipt,
  RuntimeCanarySelectionError,
  selectRuntimeCanary,
  writeRuntimeSelectionReceipt,
} from "./lib/lobster-runtime-canary-selection.mjs";

const TOOL = "lobster:rust-gateway-durable-selection";
const FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-durable-selection-fixture.json"), "utf8"),
);
const SINGLE_AUTHORITY_FIXTURE = JSON.parse(
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
    !proof.receipt?.boundedProfileReadinessProven ||
    proof.receipt?.authority !== "none"
  ) {
    fail("selected Rust runtime did not return the bounded artifact-readiness proof");
  }
  return proof;
}

async function resumeSelection(receiptPath, expectedSelectionGeneration) {
  const dispatchCounts = { typescript: 0, rust: 0 };
  try {
    const receipt = readRuntimeSelectionReceipt(receiptPath, expectedSelectionGeneration);
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
    const dispatch = dispatchers[receipt.selection.runtimeId];
    if (typeof dispatch !== "function") {
      throw new RuntimeCanarySelectionError(
        "SELECTED_RUNTIME_UNAVAILABLE",
        `selected runtime ${receipt.selection.runtimeId} has no dispatcher`,
      );
    }
    const result = await dispatch();
    console.log(
      JSON.stringify({
        processId: process.pid,
        reloadedSelectionGeneration: receipt.selection.selectionGeneration,
        runtimeId: receipt.selection.runtimeId,
        receiptSha256: receipt.sha256,
        dispatchCounts,
        artifactSha256: result.artifactSha256,
        connectionGeneration: result.receipt.connectionGeneration,
        pairingGeneration: result.receipt.pairingGeneration,
        effectAuthority: "none",
        productionRuntimeAuthorityProven: false,
        authority: "none",
      }),
    );
  } catch (error) {
    if (!(error instanceof RuntimeCanarySelectionError)) {
      throw error;
    }
    console.log(
      JSON.stringify({
        processId: process.pid,
        code: error.code,
        rejectedBeforeDispatch: true,
        dispatchCounts,
        effectAuthority: "none",
        productionRuntimeAuthorityProven: false,
        authority: "none",
      }),
    );
  }
}

function runResumeProcess(receiptPath, expectedSelectionGeneration) {
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/lobster-rust-gateway-durable-selection.mjs"),
      "--resume",
      receiptPath,
      expectedSelectionGeneration,
    ],
    {
      encoding: "utf8",
      env: process.env,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? `selection resume exited ${result.status ?? 1}`);
  }
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "{}");
}

const [mode, receiptPathArg, expectedGenerationArg] = process.argv.slice(2);
if (mode === "--resume") {
  await resumeSelection(receiptPathArg, expectedGenerationArg);
} else {
  const workspace = mkdtempSync(join(tmpdir(), "openclaw-rust-durable-selection-"));
  try {
    const selection = selectRuntimeCanary(SINGLE_AUTHORITY_FIXTURE.accepted.input);
    const receiptPath = join(workspace, "selection-receipt.json");
    const persisted = writeRuntimeSelectionReceipt(receiptPath, selection);

    const stale = runResumeProcess(receiptPath, FIXTURE.rejected.input.expectedSelectionGeneration);
    if (
      stale.code !== FIXTURE.rejected.expected.code ||
      !stale.rejectedBeforeDispatch ||
      JSON.stringify(stale.dispatchCounts) !==
        JSON.stringify(FIXTURE.rejected.expected.dispatchCounts)
    ) {
      fail(`stale selection result mismatch: ${JSON.stringify(stale)}`);
    }

    const accepted = runResumeProcess(
      receiptPath,
      FIXTURE.accepted.input.expectedSelectionGeneration,
    );
    const evidence = {
      schemaVersion: 1,
      fixtureId: FIXTURE.fixtureId,
      writerProcessId: process.pid,
      persistedReceiptSha256: persisted.sha256,
      stale,
      accepted,
      freshProcessesProven:
        stale.processId !== process.pid &&
        accepted.processId !== process.pid &&
        stale.processId !== accepted.processId,
      durableSelectionProven:
        accepted.runtimeId === FIXTURE.accepted.expected.runtimeId &&
        accepted.reloadedSelectionGeneration === FIXTURE.accepted.expected.selectionGeneration &&
        accepted.dispatchCounts.typescript === 0 &&
        accepted.dispatchCounts.rust === 1,
      effectAuthority: "none",
      productionRuntimeAuthorityProven: false,
      authority: "none",
    };
    if (!evidence.freshProcessesProven || !evidence.durableSelectionProven) {
      fail(`durable selection evidence mismatch: ${JSON.stringify(evidence)}`);
    }
    console.log(JSON.stringify(evidence));
    writeFailedTrailer(TOOL, 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    writeFailedTrailer(TOOL, 1);
    process.exitCode = 1;
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
