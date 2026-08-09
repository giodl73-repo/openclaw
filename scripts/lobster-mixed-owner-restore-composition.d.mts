export type MixedOwnerRestoreFailure = {
  code: string;
  owner?: string;
  actualSchemaVersion?: number;
  supportedSchemaVersion?: number;
};

export type MixedOwnerRestoreResult = {
  fixtureId: "lobster.kcc.mixed-owner-restore-composition.v1";
  status: "accepted" | "rejected";
  authority: "none";
  owner: "openclaw-typescript-sqlite-snapshot";
  readiness: "ready-for-owner-native-restore" | "blocked";
  publicationAttempted: boolean;
  crossOwnerAtomicPublicationProven: false;
  failure: MixedOwnerRestoreFailure | null;
  failures: MixedOwnerRestoreFailure[];
};

export function validateMixedOwnerRestoreComposition(
  input: unknown,
  owner: unknown,
): MixedOwnerRestoreResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.kcc.mixed-owner-restore-composition.v1";
  owner: "openclaw-typescript-sqlite-snapshot";
  cases: Array<{ id: string; result: MixedOwnerRestoreResult }>;
};
