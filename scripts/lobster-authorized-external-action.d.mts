export type AuthorizedExternalActionFailure = {
  code: string;
  operationId?: string;
};

export type AuthorizedExternalActionResult = {
  fixtureId: "lobster.exa.authorized-external-action.v1";
  status: "accepted" | "rejected";
  failures: AuthorizedExternalActionFailure[];
  reconciliation: {
    expectedOperationCount: number;
    reportedOperationCount: number;
    counts: {
      completed: number;
      blocked: number;
      replayed: number;
      unknownEffects: number;
      uniqueEffects: number;
    };
    status: "complete" | "partial";
    assuranceComplete: boolean;
  };
};

export function validateAuthorizedExternalAction(input: unknown): AuthorizedExternalActionResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.exa.authorized-external-action.v1";
  cases: Array<{ id: string; result: AuthorizedExternalActionResult }>;
};
