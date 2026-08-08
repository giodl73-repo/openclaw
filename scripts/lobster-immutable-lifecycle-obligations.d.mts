export type ImmutableLifecycleObligationFailure = {
  code: string;
  sequence?: number;
  childId?: string;
};

export type ImmutableLifecycleObligationsResult = {
  fixtureId: "lobster.dgr.immutable-lifecycle-obligations.v1";
  status: "accepted" | "rejected";
  failures: ImmutableLifecycleObligationFailure[];
  reconciliation: {
    requiredChildCount: number;
    settledChildCount: number;
    blockedBeforeEffect: number;
    effectCount: number;
    unresolvedAcknowledgements: number;
    status: "complete" | "partial";
    assuranceComplete: boolean;
  };
};

export function validateImmutableLifecycleObligations(
  input: unknown,
): ImmutableLifecycleObligationsResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.dgr.immutable-lifecycle-obligations.v1";
  cases: Array<{ id: string; result: ImmutableLifecycleObligationsResult }>;
};
