export type RemoteNodeInvocationTrustFailure = {
  code: string;
  operationId?: string;
};

export type RemoteNodeInvocationTrustResult = {
  fixtureId: "lobster.rfn.remote-node-invocation-trust.v1";
  status: "accepted" | "rejected";
  failures: RemoteNodeInvocationTrustFailure[];
  reconciliation: {
    expectedOperationCount: number;
    reportedOperationCount: number;
    counts: {
      completed: number;
      blocked: number;
      cancelled: number;
      unknownEffects: number;
    };
    status: "complete" | "partial";
    assuranceComplete: boolean;
  };
};

export function validateRemoteNodeInvocationTrust(input: unknown): RemoteNodeInvocationTrustResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.rfn.remote-node-invocation-trust.v1";
  cases: Array<{ id: string; result: RemoteNodeInvocationTrustResult }>;
};
