import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  readRuntimeSelectionReceipt,
  selectRuntimeCanary,
  writeRuntimeSelectionReceipt,
} from "./lib/lobster-runtime-canary-selection.mjs";
import { resumeRuntimeSelection } from "./lib/lobster-runtime-selection-proof.mjs";

const SCRIPT = "scripts/lobster-rust-gateway-canary-observation.mjs";
const FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-canary-observation-fixture.json"), "utf8"),
);
const SINGLE_AUTHORITY_FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-single-authority-fixture.json"), "utf8"),
);
const BUDGET_EXHAUSTED = "CANARY_DISPATCH_BUDGET_EXHAUSTED";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function observationPayload(receipt) {
  const { receiptSha256: _receiptSha256, ...payload } = receipt;
  return payload;
}

function writeReceipt(path, receipt) {
  const next = { ...receipt, receiptSha256: digest(observationPayload(receipt)) };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return next;
}

function readReceipt(path, selectionReceipt) {
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (
    receipt.fixtureId !== FIXTURE.fixtureId ||
    receipt.selectionGeneration !== FIXTURE.selectionGeneration ||
    receipt.selectionReceiptSha256 !== selectionReceipt.sha256 ||
    JSON.stringify(receipt.budgets) !== JSON.stringify(FIXTURE.budgets) ||
    receipt.effectAuthority !== "none" ||
    receipt.productionRuntimeAuthorityProven !== false ||
    receipt.authority !== "none" ||
    receipt.receiptSha256 !== digest(observationPayload(receipt))
  ) {
    throw new Error("CANARY_OBSERVATION_RECEIPT_INVALID");
  }
  return receipt;
}

function withWriterLock(path, callback) {
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("CANARY_OBSERVATION_WRITE_LOCKED", { cause: error });
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
  const receipt = readRuntimeSelectionReceipt(path, FIXTURE.selectionGeneration);
  if (
    receipt.selection.runtimeId !== FIXTURE.runtimeId ||
    receipt.transition?.kind !== "activate" ||
    receipt.transition.sideEffectsAllowed !== false ||
    receipt.transition.effectAuthority !== "none" ||
    receipt.transition.productionRuntimeAuthorityProven !== false ||
    receipt.transition.authority !== "none" ||
    JSON.stringify(receipt.transition.toSelection) !== JSON.stringify(receipt.selection)
  ) {
    throw new Error("ACTIVATION_RECEIPT_INVALID");
  }
  return receipt;
}

function reserveDispatch(observationPath, selectionReceipt) {
  return withWriterLock(observationPath, () => {
    const receipt = readReceipt(observationPath, selectionReceipt);
    if (
      receipt.windowStatus !== "observing" ||
      receipt.dispatches >= receipt.budgets.maxDispatches ||
      receipt.errors > receipt.budgets.maxErrors ||
      receipt.totalDurationMs > receipt.budgets.maxDurationMs
    ) {
      return { code: BUDGET_EXHAUSTED, rejectedBeforeDispatch: true };
    }
    return writeReceipt(observationPath, {
      ...receipt,
      dispatches: receipt.dispatches + 1,
      windowStatus: "dispatching",
    });
  });
}

function settleDispatch(observationPath, selectionReceipt, durationMs, failed) {
  return withWriterLock(observationPath, () => {
    const receipt = readReceipt(observationPath, selectionReceipt);
    const nextErrors = receipt.errors + (failed ? 1 : 0);
    const totalDurationMs = receipt.totalDurationMs + durationMs;
    const complete =
      receipt.dispatches >= receipt.budgets.maxDispatches ||
      nextErrors > receipt.budgets.maxErrors ||
      totalDurationMs > receipt.budgets.maxDurationMs;
    return writeReceipt(observationPath, {
      ...receipt,
      errors: nextErrors,
      totalDurationMs,
      windowStatus: complete ? "complete" : "observing",
    });
  });
}

async function dispatch(selectionPath, observationPath) {
  const selectionReceipt = readActivationReceipt(selectionPath);
  const reservation = reserveDispatch(observationPath, selectionReceipt);
  if (reservation.code === BUDGET_EXHAUSTED) {
    return {
      code: BUDGET_EXHAUSTED,
      rejectedBeforeDispatch: true,
      dispatchCounts: { typescript: 0, rust: 0 },
    };
  }
  const startedAt = performance.now();
  let proof;
  let failureMessage;
  try {
    proof = await resumeRuntimeSelection(selectionPath, FIXTURE.selectionGeneration);
    if (
      proof.runtimeId !== FIXTURE.runtimeId ||
      proof.dispatchCounts.typescript !== 0 ||
      proof.dispatchCounts.rust !== 1
    ) {
      throw new Error("CANARY_RUST_DISPATCH_INVALID");
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }
  const settled = settleDispatch(
    observationPath,
    selectionReceipt,
    Math.max(0, performance.now() - startedAt),
    failureMessage !== undefined,
  );
  if (failureMessage !== undefined) {
    throw new Error(failureMessage);
  }
  return {
    selectionGeneration: proof.reloadedSelectionGeneration,
    runtimeId: proof.runtimeId,
    artifactSha256: proof.artifactSha256,
    dispatchCounts: proof.dispatchCounts,
    observationDispatches: settled.dispatches,
    processId: process.pid,
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  };
}

function runDispatch(selectionPath, observationPath) {
  const result = spawnSync(
    process.execPath,
    [resolve(SCRIPT), "--dispatch", selectionPath, observationPath],
    { encoding: "utf8", env: process.env },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? `canary dispatch exited ${result.status ?? 1}`);
  }
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "{}");
}

function createSelection(selectionPath) {
  const baselineSelection = selectRuntimeCanary(
    selectionInput("selection-generation-1", "typescript-baseline"),
  );
  const baselineReceipt = writeRuntimeSelectionReceipt(selectionPath, baselineSelection);
  const selection = selectRuntimeCanary(
    selectionInput(FIXTURE.selectionGeneration, FIXTURE.runtimeId),
  );
  const transition = {
    kind: "activate",
    transitionGeneration: FIXTURE.transitionGeneration,
    deploymentUnitId: selection.deploymentUnitId,
    fromSelectionGeneration: baselineSelection.selectionGeneration,
    fromRuntimeId: baselineSelection.runtimeId,
    fromSelectionReceiptSha256: baselineReceipt.sha256,
    toSelection: selection,
    sideEffectsAllowed: false,
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  };
  return writeRuntimeSelectionReceipt(selectionPath, selection, transition);
}

function initializeObservation(path, selectionReceipt) {
  return writeReceipt(path, {
    schemaVersion: 1,
    fixtureId: FIXTURE.fixtureId,
    selectionGeneration: FIXTURE.selectionGeneration,
    selectionReceiptSha256: selectionReceipt.sha256,
    budgets: FIXTURE.budgets,
    startedAt: new Date().toISOString(),
    dispatches: 0,
    errors: 0,
    totalDurationMs: 0,
    windowStatus: "observing",
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  });
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "--dispatch") {
  console.log(JSON.stringify(await dispatch(args[0], args[1])));
} else {
  const workspace = mkdtempSync(join(tmpdir(), "openclaw-rust-canary-observation-"));
  try {
    const selectionPath = join(workspace, "selection.json");
    const observationPath = join(workspace, "observation.json");
    const selectionReceipt = createSelection(selectionPath);
    initializeObservation(observationPath, selectionReceipt);
    const acceptedRuns = Array.from({ length: FIXTURE.budgets.maxDispatches }, () =>
      runDispatch(selectionPath, observationPath),
    );
    const accepted = readReceipt(observationPath, selectionReceipt);
    const rejected = runDispatch(selectionPath, observationPath);
    const result = {
      fixtureId: FIXTURE.fixtureId,
      accepted: {
        dispatches: accepted.dispatches,
        errors: accepted.errors,
        typescriptDispatchCount: acceptedRuns.reduce(
          (sum, run) => sum + run.dispatchCounts.typescript,
          0,
        ),
        rustDispatchCount: acceptedRuns.reduce((sum, run) => sum + run.dispatchCounts.rust, 0),
        distinctProcessCount: new Set(acceptedRuns.map((run) => run.processId)).size,
        withinDurationBudget: accepted.totalDurationMs <= accepted.budgets.maxDurationMs,
        windowStatus: accepted.windowStatus,
        effectAuthority: accepted.effectAuthority,
        productionRuntimeAuthorityProven: accepted.productionRuntimeAuthorityProven,
        authority: accepted.authority,
      },
      failure: {
        code: rejected.code,
        rejectedBeforeDispatch: rejected.rejectedBeforeDispatch,
        typescriptDispatchCount: rejected.dispatchCounts.typescript,
        rustDispatchCount: rejected.dispatchCounts.rust,
      },
    };
    if (JSON.stringify(result.accepted) !== JSON.stringify(FIXTURE.expected.accepted)) {
      throw new Error("CANARY_ACCEPTED_CONTRACT_MISMATCH");
    }
    if (JSON.stringify(result.failure) !== JSON.stringify(FIXTURE.expected.failure)) {
      throw new Error("CANARY_FAILURE_CONTRACT_MISMATCH");
    }
    console.log(JSON.stringify(result));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
