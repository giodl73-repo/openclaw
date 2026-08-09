export type ProtocolNegotiationFailure = {
  code: string;
  clientMinProtocol?: number;
  clientMaxProtocol?: number;
  expectedProtocol?: number;
  minimumProbeProtocol?: number;
};

export type ProtocolNegotiationResult = {
  fixtureId: "lobster.rfn.protocol-negotiation-evolution.v1";
  status: "accepted" | "rejected";
  authority: "none";
  owner: "openclaw-typescript-gateway";
  compatibilityMode: "current" | "legacy-node" | "legacy-probe" | "none";
  emittedProtocol: number | null;
  runtimeMutationAttempted: boolean;
  releaseDuration: "undeclared";
  rustAdjacentVersionProven: false;
  failure: ProtocolNegotiationFailure | null;
  failures: ProtocolNegotiationFailure[];
};

export function validateProtocolNegotiation(
  input: unknown,
  owner: unknown,
): ProtocolNegotiationResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.rfn.protocol-negotiation-evolution.v1";
  owner: "openclaw-typescript-gateway";
  implementationEvidence: Array<{
    id: string;
    language: string;
    role: string;
    minProtocol: number;
    maxProtocol: number;
    evidence: string;
  }>;
  cases: Array<{ id: string; result: ProtocolNegotiationResult }>;
};
