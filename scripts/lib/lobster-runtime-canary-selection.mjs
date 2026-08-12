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
