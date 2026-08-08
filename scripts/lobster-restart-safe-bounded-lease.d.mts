export type RestartSafeBoundedLeaseFailure = {
  code: string;
  sequence?: number;
  leaseId?: string;
  operationId?: string;
};

export type RestartSafeBoundedLeaseEvidenceResult = {
  fixtureId: "lobster.dgr.restart-safe-bounded-lease.v1";
  status: "accepted" | "rejected";
  failures: RestartSafeBoundedLeaseFailure[];
  reconciliation: {
    capacity: number | undefined;
    capacityInUse: number;
    leaseCount: number;
    settledLeaseCount: number;
    restartCount: number;
    exhaustionCount: number;
    existingAcquisitionCount: number;
    fencedCount: number;
  };
};

export function validateRestartSafeBoundedLeaseEvidence(
  input: unknown,
): RestartSafeBoundedLeaseEvidenceResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.dgr.restart-safe-bounded-lease.v1";
  cases: Array<{ id: string; result: RestartSafeBoundedLeaseEvidenceResult }>;
};
