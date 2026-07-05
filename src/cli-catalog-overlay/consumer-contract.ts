export type CliCatalogConsumerId = "policy" | "admin" | "diagnostics" | "prompt" | "ci-report";

export type CliCatalogJsonOutputContract = {
  readonly id: string;
  readonly command: string;
  readonly stableFields: readonly string[];
  readonly snapshotFields: readonly string[];
};

export type CliCatalogConsumerContract = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "cli-catalog-overlay-consumer-contract";
  readonly readOnly: true;
  readonly consumers: readonly CliCatalogConsumerId[];
  readonly stableExternalCommands: readonly string[];
  readonly repoInternalBuilderModules: readonly string[];
  readonly jsonOutputs: readonly CliCatalogJsonOutputContract[];
  readonly nonGoals: readonly string[];
};

export function buildCliCatalogConsumerContract(): CliCatalogConsumerContract {
  return {
    schemaVersion: 1,
    generatedFrom: "cli-catalog-overlay-consumer-contract",
    readOnly: true,
    consumers: ["policy", "admin", "diagnostics", "prompt", "ci-report"],
    stableExternalCommands: [
      "openclaw catalog list --json",
      "openclaw catalog audit --json",
      "openclaw catalog test-matrix --json",
      "openclaw catalog summary --json",
    ],
    repoInternalBuilderModules: [
      "src/cli-catalog-overlay/list.js",
      "src/cli-catalog-overlay/audit.js",
      "src/cli-catalog-overlay/test-matrix.js",
      "src/cli-catalog-overlay/operator-summary.js",
      "src/cli-catalog-overlay/prompt-projection.js",
      "src/cli-catalog-overlay/consumer-contract.js",
    ],
    jsonOutputs: [
      {
        id: "list",
        command: "openclaw catalog list --json",
        stableFields: [
          "schemaVersion",
          "generatedFrom",
          "counts",
          "cli",
          "agentToolSurfaces",
          "promptProjection",
        ],
        snapshotFields: [
          "counts.*",
          "cli.descriptors",
          "cli.commandRoutes",
          "cli.runtimeCommands",
          "cli.pluginCommands",
          "cli.nodeCommands",
        ],
      },
      {
        id: "audit",
        command: "openclaw catalog audit --json",
        stableFields: [
          "schemaVersion",
          "generatedFrom",
          "counts",
          "surfaces",
          "commandRoutes",
          "nodeCommands",
        ],
        snapshotFields: [
          "counts.*",
          "surfaces.*",
          "commandRoutes.byPolicyKey",
          "commandRoutes.routesWithoutPolicyKeys",
          "nodeCommands.*",
        ],
      },
      {
        id: "test-matrix",
        command: "openclaw catalog test-matrix --json",
        stableFields: [
          "schemaVersion",
          "generatedFrom",
          "counts",
          "candidates",
          "nodeCommandCandidates",
          "coverageGaps",
        ],
        snapshotFields: ["counts.*", "candidates", "nodeCommandCandidates", "coverageGaps"],
      },
      {
        id: "summary",
        command: "openclaw catalog summary --json",
        stableFields: ["schemaVersion", "generatedFrom", "counts", "attention", "nextChecks"],
        snapshotFields: ["counts.*", "attention.*", "nextChecks"],
      },
    ],
    nonGoals: [
      "The catalog does not execute commands.",
      "The catalog does not enforce policy decisions.",
      "The catalog does not make inventory counts permanent compatibility promises.",
    ],
  };
}
