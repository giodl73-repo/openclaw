export type CliCatalogRisk = "low" | "medium" | "high";
export type CliCatalogEffectMode = "read" | "mutating" | "mixed";
export type CliCatalogVisibility = "docs" | "prompt" | "audit" | "operator" | "policy";
export type CliCatalogExposureTier = "public" | "internal";

export type CommandEffectProfile = {
  readonly effectMode: CliCatalogEffectMode;
  readonly confirmationRequired?: boolean;
  readonly risk?: CliCatalogRisk;
  readonly commandHints?: readonly string[];
};

export type CatalogExposure = {
  readonly tier?: CliCatalogExposureTier;
};
