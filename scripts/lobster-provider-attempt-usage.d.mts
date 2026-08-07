export type ProviderAttemptUsageFailure = {
  code: string;
  candidateAttemptId?: string;
  modelCallId?: string;
};

export type ProviderAttemptUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  total: number;
};

export type ProviderAttemptUsageEvidenceResult = {
  fixtureId: "lobster.mpu.provider-attempt-usage.v1";
  status: "accepted" | "rejected";
  failures: ProviderAttemptUsageFailure[];
  reconciliation: {
    candidateCount: number;
    modelCallCount: number;
    runUsage: ProviderAttemptUsage;
  };
};

export function validateProviderAttemptUsageEvidence(
  input: unknown,
): ProviderAttemptUsageEvidenceResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.mpu.provider-attempt-usage.v1";
  cases: Array<{ id: string; result: ProviderAttemptUsageEvidenceResult }>;
};
