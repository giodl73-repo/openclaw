import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFailedTrailer } from "./lib/failed-trailer.mjs";
import {
  readRuntimeSelectionReceipt,
  selectRuntimeCanary,
  writeRuntimeSelectionReceipt,
} from "./lib/lobster-runtime-canary-selection.mjs";
import {
  resumeRuntimeSelection,
  runRuntimeSelectionResumeProcess,
} from "./lib/lobster-runtime-selection-proof.mjs";

const TOOL = "lobster:rust-gateway-activation-rollback";
const SCRIPT = "scripts/lobster-rust-gateway-activation-rollback.mjs";
const FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-activation-rollback-fixture.json"), "utf8"),
);
const SINGLE_AUTHORITY_FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-single-authority-fixture.json"), "utf8"),
);

class RuntimeSelectionTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeSelectionTransitionError";
    this.code = code;
  }
}

function fail(message) {
  throw new Error(message);
}

function selectionInput(selectionGeneration, runtimeId) {
  const input = structuredClone(SINGLE_AUTHORITY_FIXTURE.accepted.input);
  input.selectionGeneration = selectionGeneration;
  for (const candidate of input.candidates) {
    candidate.selectionGeneration = selectionGeneration;
    candidate.selectedDeploymentUnits =
      candidate.runtimeId === runtimeId ? [input.deploymentUnitId] : [];
  }
  return input;
}

function readActivationReceipt(path) {
  const receipt = readRuntimeSelectionReceipt(path);
  if (
    typeof receipt.transition !== "object" ||
    receipt.transition === null ||
    receipt.transition.kind !== "activate" ||
    JSON.stringify(receipt.transition.toSelection) !== JSON.stringify(receipt.selection)
  ) {
    throw new RuntimeSelectionTransitionError(
      "ACTIVATION_RECEIPT_INVALID",
      "runtime selection receipt is not bound to a valid activation transition",
    );
  }
  return receipt;
}

function withSelectionWriteLock(selectionPath, callback) {
  const lockPath = `${selectionPath}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new RuntimeSelectionTransitionError(
        "SELECTION_WRITE_LOCKED",
        "another runtime selection writer owns the deployment unit",
      );
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

function buildTransition(kind, generation, fromReceipt, toSelection) {
  return {
    kind,
    transitionGeneration: generation,
    deploymentUnitId: fromReceipt.selection.deploymentUnitId,
    fromSelectionGeneration: fromReceipt.selection.selectionGeneration,
    fromRuntimeId: fromReceipt.selection.runtimeId,
    fromSelectionReceiptSha256: fromReceipt.sha256,
    toSelection,
    sideEffectsAllowed: false,
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  };
}

function rollbackSelection(selectionPath, activationPath, expectedCurrentSha256) {
  const dispatchCounts = { typescript: 0, rust: 0 };
  try {
    return withSelectionWriteLock(selectionPath, () => {
      const activation = readActivationReceipt(activationPath);
      const current = readRuntimeSelectionReceipt(selectionPath);
      if (activation.sha256 !== expectedCurrentSha256 || current.sha256 !== expectedCurrentSha256) {
        throw new RuntimeSelectionTransitionError(
          "STALE_CURRENT_SELECTION",
          "rollback request does not match the current activated selection",
        );
      }
      const rollbackSelectionValue = selectRuntimeCanary(
        selectionInput(
          FIXTURE.rollback.accepted.selectionGeneration,
          FIXTURE.rollback.accepted.runtimeId,
        ),
      );
      const rollbackTransition = {
        kind: "rollback",
        transitionGeneration: FIXTURE.rollback.accepted.transitionGeneration,
        deploymentUnitId: current.selection.deploymentUnitId,
        fromSelectionGeneration: current.selection.selectionGeneration,
        fromRuntimeId: current.selection.runtimeId,
        fromSelectionReceiptSha256: current.sha256,
        toSelection: rollbackSelectionValue,
        sideEffectsAllowed: false,
        effectAuthority: "none",
        productionRuntimeAuthorityProven: false,
        authority: "none",
      };
      const rollbackSelectionReceipt = writeRuntimeSelectionReceipt(
        selectionPath,
        rollbackSelectionValue,
        rollbackTransition,
      );
      return {
        processId: process.pid,
        selectionGeneration: rollbackSelectionValue.selectionGeneration,
        runtimeId: rollbackSelectionValue.runtimeId,
        selectionReceiptSha256: rollbackSelectionReceipt.sha256,
        transitionReceiptSha256: rollbackSelectionReceipt.sha256,
        explicitRollback: true,
        transitionEmbeddedInSelectionReceipt: true,
        selectionWriteSerialized: true,
        dispatchCounts,
        effectAuthority: "none",
        productionRuntimeAuthorityProven: false,
        authority: "none",
      };
    });
  } catch (error) {
    if (!(error instanceof RuntimeSelectionTransitionError)) {
      throw error;
    }
    return {
      processId: process.pid,
      code: error.code,
      rejectedBeforeMutation: true,
      rejectedBeforeDispatch: true,
      dispatchCounts,
      effectAuthority: "none",
      productionRuntimeAuthorityProven: false,
      authority: "none",
    };
  }
}

function runRollbackProcess(selectionPath, activationPath, expectedCurrentSha256) {
  const result = spawnSync(
    process.execPath,
    [resolve(SCRIPT), "--rollback", selectionPath, activationPath, expectedCurrentSha256],
    { encoding: "utf8", env: process.env },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? `selection rollback exited ${result.status ?? 1}`);
  }
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "{}");
}

async function resumeActivatedSelection(selectionPath, expectedSelectionGeneration) {
  readActivationReceipt(selectionPath);
  return {
    ...(await resumeRuntimeSelection(selectionPath, expectedSelectionGeneration)),
    activationReceiptValidated: true,
  };
}

function runActivatedProcess(selectionPath, expectedSelectionGeneration) {
  const result = spawnSync(
    process.execPath,
    [resolve(SCRIPT), "--resume-activated", selectionPath, expectedSelectionGeneration],
    { encoding: "utf8", env: process.env },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? `activated selection resume exited ${result.status ?? 1}`);
  }
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "{}");
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "--resume") {
  console.log(JSON.stringify(await resumeRuntimeSelection(args[0], args[1])));
} else if (mode === "--resume-activated") {
  console.log(JSON.stringify(await resumeActivatedSelection(args[0], args[1])));
} else if (mode === "--rollback") {
  console.log(JSON.stringify(rollbackSelection(args[0], args[1], args[2])));
} else {
  const workspace = mkdtempSync(join(tmpdir(), "openclaw-rust-activation-rollback-"));
  try {
    const selectionPath = join(workspace, "selection-receipt.json");
    const staleSelectionPath = join(workspace, "stale-selection-receipt.json");
    const baselineSelection = selectRuntimeCanary(
      selectionInput(FIXTURE.baseline.selectionGeneration, FIXTURE.baseline.runtimeId),
    );
    const baselineReceipt = writeRuntimeSelectionReceipt(selectionPath, baselineSelection);
    const rustSelection = selectRuntimeCanary(
      selectionInput(
        FIXTURE.activation.expected.selectionGeneration,
        FIXTURE.activation.expected.runtimeId,
      ),
    );
    const activationTransition = buildTransition(
      "activate",
      FIXTURE.activation.expected.transitionGeneration,
      baselineReceipt,
      rustSelection,
    );
    const rustReceipt = writeRuntimeSelectionReceipt(
      selectionPath,
      rustSelection,
      activationTransition,
    );
    const activated = runActivatedProcess(
      selectionPath,
      FIXTURE.activation.expected.selectionGeneration,
    );

    const newerSelection = selectRuntimeCanary(
      selectionInput(
        FIXTURE.rollback.rejected.currentSelectionGeneration,
        FIXTURE.activation.expected.runtimeId,
      ),
    );
    const newerReceipt = writeRuntimeSelectionReceipt(staleSelectionPath, newerSelection);
    const staleRollback = runRollbackProcess(staleSelectionPath, selectionPath, rustReceipt.sha256);
    const currentAfterRejection = readRuntimeSelectionReceipt(
      staleSelectionPath,
      FIXTURE.rollback.rejected.currentSelectionGeneration,
    );
    const rollbackWriter = runRollbackProcess(selectionPath, selectionPath, rustReceipt.sha256);
    const rolledBack = runRuntimeSelectionResumeProcess(
      SCRIPT,
      selectionPath,
      FIXTURE.rollback.accepted.selectionGeneration,
    );
    const processIds = [
      process.pid,
      activated.processId,
      staleRollback.processId,
      rollbackWriter.processId,
      rolledBack.processId,
    ];
    const evidence = {
      schemaVersion: 1,
      fixtureId: FIXTURE.fixtureId,
      writerProcessId: process.pid,
      activationReceiptSha256: rustReceipt.sha256,
      activated,
      staleRollback,
      rollbackWriter,
      rolledBack,
      freshProcessesProven: new Set(processIds).size === processIds.length,
      activationProven:
        activated.activationReceiptValidated &&
        activated.runtimeId === FIXTURE.activation.expected.runtimeId &&
        activated.dispatchCounts.typescript === 0 &&
        activated.dispatchCounts.rust === 1,
      staleRollbackRefused:
        staleRollback.code === FIXTURE.rollback.rejected.code &&
        staleRollback.rejectedBeforeMutation &&
        staleRollback.dispatchCounts.typescript === 0 &&
        staleRollback.dispatchCounts.rust === 0 &&
        currentAfterRejection.sha256 === newerReceipt.sha256,
      rollbackProven:
        rollbackWriter.explicitRollback &&
        rollbackWriter.selectionWriteSerialized &&
        rollbackWriter.transitionEmbeddedInSelectionReceipt &&
        rolledBack.runtimeId === FIXTURE.rollback.accepted.runtimeId &&
        rolledBack.dispatchCounts.typescript === 1 &&
        rolledBack.dispatchCounts.rust === 0,
      effectAuthority: "none",
      productionRuntimeAuthorityProven: false,
      authority: "none",
    };
    if (
      !evidence.freshProcessesProven ||
      !evidence.activationProven ||
      !evidence.staleRollbackRefused ||
      !evidence.rollbackProven
    ) {
      fail(`activation rollback evidence mismatch: ${JSON.stringify(evidence)}`);
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
