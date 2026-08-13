import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  readRuntimeSelectionReceipt,
  RuntimeCanarySelectionError,
} from "./lobster-runtime-canary-selection.mjs";

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

export async function resumeRuntimeSelection(receiptPath, expectedSelectionGeneration) {
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
    return {
      processId: process.pid,
      reloadedSelectionGeneration: receipt.selection.selectionGeneration,
      runtimeId: receipt.selection.runtimeId,
      receiptSha256: receipt.sha256,
      dispatchCounts,
      ...(receipt.selection.runtimeId === "rust-canary"
        ? {
            artifactSha256: result.artifactSha256,
            connectionGeneration: result.receipt.connectionGeneration,
            pairingGeneration: result.receipt.pairingGeneration,
          }
        : {}),
      effectAuthority: "none",
      productionRuntimeAuthorityProven: false,
      authority: "none",
    };
  } catch (error) {
    if (!(error instanceof RuntimeCanarySelectionError)) {
      throw error;
    }
    return {
      processId: process.pid,
      code: error.code,
      rejectedBeforeDispatch: true,
      fallbackRuntimeSelected: false,
      dispatchCounts,
      effectAuthority: "none",
      productionRuntimeAuthorityProven: false,
      authority: "none",
    };
  }
}

export function runRuntimeSelectionResumeProcess(
  scriptPath,
  receiptPath,
  expectedSelectionGeneration,
) {
  const result = spawnSync(
    process.execPath,
    [resolve(scriptPath), "--resume", receiptPath, expectedSelectionGeneration],
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
