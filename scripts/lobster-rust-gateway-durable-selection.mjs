import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const [mode, receiptPathArg, expectedGenerationArg] = process.argv.slice(2);
if (mode === "--resume") {
  console.log(JSON.stringify(await resumeRuntimeSelection(receiptPathArg, expectedGenerationArg)));
} else {
  const workspace = mkdtempSync(join(tmpdir(), "openclaw-rust-durable-selection-"));
  try {
    const selection = selectRuntimeCanary(SINGLE_AUTHORITY_FIXTURE.accepted.input);
    const receiptPath = join(workspace, "selection-receipt.json");
    const persisted = writeRuntimeSelectionReceipt(receiptPath, selection);

    const stale = runRuntimeSelectionResumeProcess(
      "scripts/lobster-rust-gateway-durable-selection.mjs",
      receiptPath,
      FIXTURE.rejected.input.expectedSelectionGeneration,
    );
    if (
      stale.code !== FIXTURE.rejected.expected.code ||
      !stale.rejectedBeforeDispatch ||
      JSON.stringify(stale.dispatchCounts) !==
        JSON.stringify(FIXTURE.rejected.expected.dispatchCounts)
    ) {
      fail(`stale selection result mismatch: ${JSON.stringify(stale)}`);
    }

    const accepted = runRuntimeSelectionResumeProcess(
      "scripts/lobster-rust-gateway-durable-selection.mjs",
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
