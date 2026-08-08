export type ReleaseActivationFailureCode =
  | "ContractMismatch"
  | "SensitivePayloadPresent"
  | "ReleaseIdentityInvalid"
  | "CompatibilityInvalid"
  | "MutationBoundaryInvalid"
  | "PhaseSequenceInvalid"
  | "ActivationBindingMismatch"
  | "RecoveryCertaintyInvalid"
  | "AttemptInventoryMismatch"
  | "FinalStateMismatch"
  | "AssuranceOverclaimed";

export interface ReleaseActivationFailure {
  code: ReleaseActivationFailureCode;
  message: string;
}

export interface ReleaseActivationResult {
  contractVersion: 1;
  authority: "none";
  fixtureId: string;
  status: "pass" | "fail";
  readyAttemptCount: number;
  blockedAttemptCount: number;
  unknownAttemptCount: number;
  failures: ReleaseActivationFailure[];
}

export function validateReleaseActivationFixture(input: unknown): ReleaseActivationResult;
