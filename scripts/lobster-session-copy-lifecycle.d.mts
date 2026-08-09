export type SessionCopyLifecycleFailureCode =
  | "ContractMismatch"
  | "SensitivePayloadPresent"
  | "InventoryMismatch"
  | "AuthorizationInvalid"
  | "GenerationFenceInvalid"
  | "ExportEvidenceInvalid"
  | "MutationBoundaryInvalid"
  | "SettlementInvalid"
  | "PurgeOverclaimed"
  | "FinalStateMismatch"
  | "AssuranceOverclaimed";

export type SessionCopyLifecycleResult = {
  contractVersion: 1;
  authority: "none";
  fixtureId: string;
  status: "pass" | "fail";
  exportCompleteCount: number;
  deleteCompleteCount: number;
  deletePartialCount: number;
  blockedCount: number;
  unknownCount: number;
  failures: Array<{ code: SessionCopyLifecycleFailureCode; message: string }>;
};

export function validateSessionCopyLifecycleFixture(input: unknown): SessionCopyLifecycleResult;
