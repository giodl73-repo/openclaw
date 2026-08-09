export type InertDefinitionCompatibilityFailure = {
  code: string;
  definitionId?: string;
  semantic?: string;
};

export type InertDefinitionCompatibilityResult = {
  fixtureId: "lobster.ext.inert-definition-compatibility.v1";
  status: "accepted" | "rejected";
  authority: "none";
  activationAttempted: boolean;
  mutationAttempted: boolean;
  definitions: Array<{
    definitionId: string;
    family: "claw" | "plugin" | "skill";
    revision: string;
    digest: string;
    status: "compatible" | "blocked";
    unknownOptional: string[];
    unknownRequired: string[];
  }>;
  preservedOptionalSemantics: string[];
  failures: InertDefinitionCompatibilityFailure[];
};

export function validateInertDefinitionCompatibility(
  input: unknown,
): InertDefinitionCompatibilityResult;

export function runFixture(path?: string): {
  schemaVersion: 1;
  fixtureId: "lobster.ext.inert-definition-compatibility.v1";
  cases: Array<{ id: string; result: InertDefinitionCompatibilityResult }>;
};
