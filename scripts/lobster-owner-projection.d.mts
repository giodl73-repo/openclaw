export type OwnerProjectionFailure = {
  owner: string;
  code: string;
  expected?: unknown;
  actual?: unknown;
};

export type OwnerProjectionResult<TProjection = Record<string, unknown>> = {
  fixtureId: "lobster.exa.owner-projection.v1";
  status: "accepted" | "rejected";
  projection: TProjection;
  failures: OwnerProjectionFailure[];
};

export function projectOwnerFacts<TFacts extends Record<string, unknown>>(input: {
  facts: TFacts;
  expected?: unknown;
}): OwnerProjectionResult<TFacts>;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: string;
  cases: [
    {
      id: string;
      result: OwnerProjectionResult<{
        configuration: { value: { readOnly: boolean } };
        readiness: { value: { ready: boolean } };
        release: { value: { channel: string } };
        telemetry: { value: { sampled: boolean } };
      }>;
    },
    { id: string; result: OwnerProjectionResult },
    ...Array<{ id: string; result: OwnerProjectionResult }>,
  ];
};
