import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFailedTrailer } from "./lib/failed-trailer.mjs";
import {
  selectRuntimeCanary,
  writeRuntimeSelectionReceipt,
} from "./lib/lobster-runtime-canary-selection.mjs";
import {
  resumeRuntimeSelection,
  runRuntimeSelectionResumeProcess,
} from "./lib/lobster-runtime-selection-proof.mjs";

const TOOL = "lobster:rust-gateway-corrupt-selection-recovery";
const SCRIPT = "scripts/lobster-rust-gateway-corrupt-selection-recovery.mjs";
const FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-corrupt-selection-recovery-fixture.json"), "utf8"),
);
const SINGLE_AUTHORITY_FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-single-authority-fixture.json"), "utf8"),
);

function fail(message) {
  throw new Error(message);
}

function selectionInputForGeneration(selectionGeneration) {
  const input = structuredClone(SINGLE_AUTHORITY_FIXTURE.accepted.input);
  input.selectionGeneration = selectionGeneration;
  for (const candidate of input.candidates) {
    candidate.selectionGeneration = selectionGeneration;
  }
  return input;
}

function recoverSelection(receiptPath) {
  const selection = selectRuntimeCanary(
    selectionInputForGeneration(FIXTURE.recovery.input.selectionGeneration),
  );
  const receipt = writeRuntimeSelectionReceipt(receiptPath, selection);
  return {
    processId: process.pid,
    selectionGeneration: selection.selectionGeneration,
    runtimeId: selection.runtimeId,
    receiptSha256: receipt.sha256,
    explicitOwnerReselection: true,
    atomicRewrite: true,
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  };
}

function runRecoveryProcess(receiptPath) {
  const result = spawnSync(process.execPath, [resolve(SCRIPT), "--recover", receiptPath], {
    encoding: "utf8",
    env: process.env,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? `selection recovery exited ${result.status ?? 1}`);
  }
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "{}");
}

const [mode, receiptPathArg, expectedGenerationArg] = process.argv.slice(2);
if (mode === "--resume") {
  console.log(JSON.stringify(await resumeRuntimeSelection(receiptPathArg, expectedGenerationArg)));
} else if (mode === "--recover") {
  console.log(JSON.stringify(recoverSelection(receiptPathArg)));
} else {
  const workspace = mkdtempSync(join(tmpdir(), "openclaw-rust-corrupt-selection-"));
  try {
    const receiptPath = join(workspace, "selection-receipt.json");
    const initialSelection = selectRuntimeCanary(
      selectionInputForGeneration(FIXTURE.corrupted.input.expectedSelectionGeneration),
    );
    const initialReceipt = writeRuntimeSelectionReceipt(receiptPath, initialSelection);
    const tamperedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    tamperedReceipt.selection.runtimeId = FIXTURE.corrupted.input.tamperedRuntimeId;
    writeFileSync(receiptPath, `${JSON.stringify(tamperedReceipt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const corrupted = runRuntimeSelectionResumeProcess(
      SCRIPT,
      receiptPath,
      FIXTURE.corrupted.input.expectedSelectionGeneration,
    );
    if (
      corrupted.code !== FIXTURE.corrupted.expected.code ||
      !corrupted.rejectedBeforeDispatch ||
      corrupted.fallbackRuntimeSelected ||
      JSON.stringify(corrupted.dispatchCounts) !==
        JSON.stringify(FIXTURE.corrupted.expected.dispatchCounts)
    ) {
      fail(`corrupted selection result mismatch: ${JSON.stringify(corrupted)}`);
    }

    const recoveryWriter = runRecoveryProcess(receiptPath);
    const recovered = runRuntimeSelectionResumeProcess(
      SCRIPT,
      receiptPath,
      FIXTURE.recovery.input.selectionGeneration,
    );
    const processIds = [
      process.pid,
      corrupted.processId,
      recoveryWriter.processId,
      recovered.processId,
    ];
    const evidence = {
      schemaVersion: 1,
      fixtureId: FIXTURE.fixtureId,
      initialWriterProcessId: process.pid,
      initialReceiptSha256: initialReceipt.sha256,
      corrupted,
      recoveryWriter,
      recovered,
      freshProcessesProven: new Set(processIds).size === processIds.length,
      failClosedCorruptionProven:
        corrupted.code === "SELECTION_RECEIPT_INVALID" &&
        corrupted.dispatchCounts.typescript === 0 &&
        corrupted.dispatchCounts.rust === 0 &&
        !corrupted.fallbackRuntimeSelected,
      explicitRecoveryProven:
        recoveryWriter.explicitOwnerReselection &&
        recoveryWriter.atomicRewrite &&
        recoveryWriter.selectionGeneration === FIXTURE.recovery.expected.selectionGeneration &&
        recoveryWriter.receiptSha256 !== initialReceipt.sha256,
      recoveredSelectionProven:
        recovered.runtimeId === FIXTURE.recovery.expected.runtimeId &&
        recovered.reloadedSelectionGeneration === FIXTURE.recovery.expected.selectionGeneration &&
        recovered.dispatchCounts.typescript === 0 &&
        recovered.dispatchCounts.rust === 1,
      effectAuthority: "none",
      productionRuntimeAuthorityProven: false,
      authority: "none",
    };
    if (
      !evidence.freshProcessesProven ||
      !evidence.failClosedCorruptionProven ||
      !evidence.explicitRecoveryProven ||
      !evidence.recoveredSelectionProven
    ) {
      fail(`corrupt selection recovery evidence mismatch: ${JSON.stringify(evidence)}`);
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
