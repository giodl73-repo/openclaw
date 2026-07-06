export type CliCatalogSurfaceKind = "tool" | "command" | "workflow";
export type CliCatalogDispatchMode = "direct" | "metadata-first" | "hybrid";
export type CliCatalogRisk = "low" | "medium" | "high";
export type CliCatalogSurfaceStatus = "draft" | "stable" | "deprecated";
export type CliCatalogEffectMode = "read" | "mutating" | "mixed";
export type CliCatalogVisibility = "docs" | "prompt" | "audit" | "operator" | "policy";

export type CliCatalogMetadata = {
  readonly id?: string;
  readonly title?: string;
  readonly kind?: CliCatalogSurfaceKind;
  readonly dispatchMode?: CliCatalogDispatchMode;
  readonly target?: string;
  readonly visibility?: readonly CliCatalogVisibility[];
  readonly intent?: string;
  readonly examples?: readonly string[];
  readonly aliases?: readonly string[];
  readonly owner?: string;
  readonly status?: CliCatalogSurfaceStatus;
  readonly confidence?: "low" | "medium" | "high";
  readonly risk?: CliCatalogRisk;
  readonly confirmationRequired?: boolean;
  readonly effectMode?: CliCatalogEffectMode;
  readonly effects?: readonly string[];
  readonly commandHints?: readonly string[];
};
