export type MixedOwnerCheckpointCopyFactFailure = {
  code: string;
  sequence?: number;
  attemptId?: string;
  ownerId?: string;
};

export type MixedOwnerCheckpointCopyFactsResult = {
  fixtureId: "lobster.kcc.mixed-owner-checkpoint-copy-facts.v1";
  status: "accepted" | "rejected";
  failures: MixedOwnerCheckpointCopyFactFailure[];
  reconciliation: {
    attemptCount: number;
    dirtyRefusalCount: number;
    acceptedCheckpointCount: number;
    expectedCopyOwnerCount: number;
    reportedCopyOwnerCount: number;
    counts: {
      complete: number;
      retained: number;
      externallyControlled: number;
      unknown: number;
    };
    copyStatus: "complete" | "partial";
    assuranceComplete: boolean;
  };
};

export function validateMixedOwnerCheckpointCopyFacts(
  input: unknown,
): MixedOwnerCheckpointCopyFactsResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.kcc.mixed-owner-checkpoint-copy-facts.v1";
  cases: Array<{ id: string; result: MixedOwnerCheckpointCopyFactsResult }>;
};
