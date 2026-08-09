export type FleetTargetedRepairFailure = {
  code: string;
  cell?: string;
};

export type FleetTargetedRepairResult = {
  fixtureId: "lobster.ops.fleet-targeted-repair.v1";
  status: "accepted" | "rejected";
  authority: "none";
  owner: "openclaw-typescript-fleet";
  before: "partial" | "converged";
  after: "converged" | "blocked";
  eligibleCells: string[];
  mutationCounts: Record<string, number>;
  projectionMutationAttempted: boolean;
  productionCoordinatorProven: false;
  containmentProven: false;
  failure: FleetTargetedRepairFailure | null;
  failures: FleetTargetedRepairFailure[];
};

export function validateFleetTargetedRepair(
  input: unknown,
  owner: unknown,
): FleetTargetedRepairResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.ops.fleet-targeted-repair.v1";
  owner: "openclaw-typescript-fleet";
  cases: Array<{ id: string; result: FleetTargetedRepairResult }>;
};
