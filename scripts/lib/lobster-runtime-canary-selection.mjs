import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export class RuntimeCanarySelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeCanarySelectionError";
    this.code = code;
  }
}

function isEligibleCandidate(candidate, input) {
  return (
    candidate.selectionGeneration === input.selectionGeneration &&
    candidate.selectedDeploymentUnits.includes(input.deploymentUnitId) &&
    candidate.profileId === input.profileId &&
    candidate.commands.includes(input.command) &&
    candidate.readiness.boundedProfileReadinessProven === true &&
    candidate.readiness.authority === "none"
  );
}

export function selectRuntimeCanary(input) {
  const eligible = input.candidates.filter((candidate) => isEligibleCandidate(candidate, input));
  if (eligible.length === 0) {
    throw new RuntimeCanarySelectionError(
      "NO_ELIGIBLE_RUNTIME",
      "no runtime is eligible for this deployment unit and selection generation",
    );
  }

  if (eligible.length !== 1) {
    throw new RuntimeCanarySelectionError(
      "AMBIGUOUS_RUNTIME_AUTHORITY",
      "more than one runtime is eligible for this deployment unit and selection generation",
    );
  }
  const selected = eligible[0];
  return {
    schemaVersion: 1,
    deploymentUnitId: input.deploymentUnitId,
    selectionGeneration: input.selectionGeneration,
    runtimeId: selected.runtimeId,
    runtimeKind: selected.runtimeKind,
    profileId: selected.profileId,
    command: input.command,
    readinessReceiptId: selected.readiness.receiptId,
    singleDispatchRequired: true,
    effectAuthority: "none",
    productionRuntimeAuthorityProven: false,
    authority: "none",
  };
}

function selectionReceiptDigest(selection) {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, selection }))
    .digest("hex");
}

export function writeRuntimeSelectionReceipt(path, selection) {
  const receipt = {
    schemaVersion: 1,
    selection,
    sha256: selectionReceiptDigest(selection),
  };
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return receipt;
}

export function readRuntimeSelectionReceipt(path, expectedSelectionGeneration) {
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.selection !== "object" ||
    receipt.selection === null ||
    receipt.sha256 !== selectionReceiptDigest(receipt.selection)
  ) {
    throw new RuntimeCanarySelectionError(
      "SELECTION_RECEIPT_INVALID",
      "runtime selection receipt failed integrity validation",
    );
  }
  if (receipt.selection.selectionGeneration !== expectedSelectionGeneration) {
    throw new RuntimeCanarySelectionError(
      "STALE_SELECTION_GENERATION",
      "runtime selection receipt does not match the expected generation",
    );
  }
  return receipt;
}

export async function dispatchSelectedRuntime(input, dispatchers) {
  const selection = selectRuntimeCanary(input);
  const dispatch = dispatchers[selection.runtimeId];
  if (typeof dispatch !== "function") {
    throw new RuntimeCanarySelectionError(
      "SELECTED_RUNTIME_UNAVAILABLE",
      `selected runtime ${selection.runtimeId} has no dispatcher`,
    );
  }
  const result = await dispatch(selection);
  return { selection, result };
}
