export type HostingProfileEvidenceFailure = {
  code: string;
  type?: string;
};

export type HostingProfileEvidenceResult = {
  fixtureId: "lobster.exa.hosting-profile-conformance.v1";
  status: "accepted" | "rejected";
  conformant: boolean;
  ready: boolean;
  failures: HostingProfileEvidenceFailure[];
};

export function validateHostingProfileEvidence(input: unknown): HostingProfileEvidenceResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.exa.hosting-profile-conformance.v1";
  cases: Array<{ id: string; result: HostingProfileEvidenceResult }>;
};
