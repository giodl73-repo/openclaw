export interface ContractSummary {
  schemaVersion: 1;
  phase: string;
  authority: "definition-only";
  admissionReady: false;
  contractCount: number;
  sharedResultCount: number;
  relationshipReferenceCount: number;
  fixtureCount: number;
  ledgerEntryCount: number;
  contractSetDigest: string;
}

export function validateContracts(input: {
  manifest: unknown;
  fixtures: unknown;
  disposition: unknown;
}): ContractSummary;

export function run(argv?: string[]): void;
