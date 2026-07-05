import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalogAudit } from "./audit.js";
import { buildCatalogList } from "./list.js";
import { buildCatalogOperatorSummary } from "./operator-summary.js";
import { buildPluginCatalogCommands } from "./plugin-commands.js";
import { listCliCatalogPromptSurfaces } from "./prompt-projection.js";
import type { CliCatalogRuntimeCommand } from "./runtime-commands.js";
import { buildCatalogTestMatrix } from "./test-matrix.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type ArrayContract = {
  readonly count: number;
  readonly itemFields: readonly string[];
  readonly ids?: readonly string[];
};

const FIXTURE_DIR = path.join(process.cwd(), "test/fixtures/cli-catalog-overlay");

function sortedKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).toSorted();
}

function idValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate =
    record.id ?? record.routeId ?? record.policyKey ?? record.name ?? record.sourceId;
  return typeof candidate === "string" ? candidate : null;
}

function arrayContract(items: readonly unknown[]): ArrayContract {
  const itemFields = [...new Set(items.flatMap((item) => sortedKeys(item)))].toSorted();
  const ids = items
    .map(idValue)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  return {
    count: items.length,
    itemFields,
    ...(ids.length > 0 ? { ids } : {}),
  };
}

function readFixture(name: string): JsonValue {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as JsonValue;
}

function expectFixture(name: string, value: JsonValue): void {
  if (process.env.UPDATE_CATALOG_SCHEMA_FIXTURES === "1") {
    writeFileSync(path.join(FIXTURE_DIR, name), JSON.stringify(value, null, 2) + "\n");
  }
  expect(value).toEqual(readFixture(name));
}

const sampleRuntimeCommands: readonly CliCatalogRuntimeCommand[] = [
  {
    commandPath: ["demo", "runtime"],
    parentPath: ["demo"],
    depth: 2,
    name: "runtime",
    aliases: ["rt"],
    description: "Demo runtime command",
    hasSubcommands: false,
    visibleSubcommandCount: 0,
    hidden: false,
    sourceKind: "runtime",
    sourceId: "demo runtime",
    discoveryMode: "runtime-registered",
    visibility: ["audit", "operator", "policy"],
  },
];

const samplePluginCommands = buildPluginCatalogCommands([
  {
    pluginId: "demo-plugin",
    parentPath: ["demo"],
    descriptors: [
      {
        name: "plugin",
        description: "Demo plugin command",
        hasSubcommands: false,
      },
    ],
  },
]);

function buildCatalogListSchemaFixture(): JsonValue {
  const list = buildCatalogList({
    runtimeCommands: sampleRuntimeCommands,
    pluginCommands: samplePluginCommands,
  });
  return {
    schemaVersion: list.schemaVersion,
    generatedFrom: list.generatedFrom,
    topLevelFields: sortedKeys(list),
    counts: list.counts,
    countFields: sortedKeys(list.counts),
    cliFields: sortedKeys(list.cli),
    descriptors: arrayContract(list.cli.descriptors),
    commandRoutes: arrayContract(list.cli.commandRoutes),
    routedOperations: arrayContract(list.cli.routedOperations),
    runtimeCommandScope: list.cli.runtimeCommandScope,
    runtimeCommands: arrayContract(list.cli.runtimeCommands),
    pluginCommands: arrayContract(list.cli.pluginCommands),
    agentToolSurfaces: arrayContract(list.agentToolSurfaces),
    promptProjection: {
      fields: sortedKeys(list.promptProjection),
      routedOperationIds: list.promptProjection.routedOperationIds.toSorted(),
      agentToolSurfaceIds: list.promptProjection.agentToolSurfaceIds.toSorted(),
    },
  };
}

function buildCatalogAuditSchemaFixture(): JsonValue {
  const audit = buildCatalogAudit();
  return {
    schemaVersion: audit.schemaVersion,
    generatedFrom: audit.generatedFrom,
    topLevelFields: sortedKeys(audit),
    counts: audit.counts,
    countFields: sortedKeys(audit.counts),
    surfaceFields: sortedKeys(audit.surfaces),
    byRisk: arrayContract(audit.surfaces.byRisk),
    byEffectMode: arrayContract(audit.surfaces.byEffectMode),
    byOwner: arrayContract(audit.surfaces.byOwner),
    confirmationRequiredSurfaceIds: audit.surfaces.confirmationRequiredSurfaceIds,
    commandRouteFields: sortedKeys(audit.commandRoutes),
    byPolicyKey: arrayContract(audit.commandRoutes.byPolicyKey),
    routesWithoutPolicyKeys: audit.commandRoutes.routesWithoutPolicyKeys.map((path) =>
      path.join(" "),
    ),
  };
}

function buildCatalogTestMatrixSchemaFixture(): JsonValue {
  const matrix = buildCatalogTestMatrix({
    coverageEvidence: [
      {
        routeId: "gateway-status",
        testPath: "src/cli/catalog-cli.test.ts",
        testName: "prints catalog list Markdown by default",
      },
    ],
  });
  return {
    schemaVersion: matrix.schemaVersion,
    generatedFrom: matrix.generatedFrom,
    topLevelFields: sortedKeys(matrix),
    counts: matrix.counts,
    countFields: sortedKeys(matrix.counts),
    candidates: arrayContract(matrix.candidates),
    coverageGaps: arrayContract(matrix.coverageGaps),
    candidateRouteIds: matrix.candidates.map((candidate) => candidate.routeId).toSorted(),
  };
}

function buildCatalogSummarySchemaFixture(): JsonValue {
  const summary = buildCatalogOperatorSummary();
  return {
    schemaVersion: summary.schemaVersion,
    generatedFrom: summary.generatedFrom,
    topLevelFields: sortedKeys(summary),
    counts: summary.counts,
    countFields: sortedKeys(summary.counts),
    attentionFields: sortedKeys(summary.attention),
    attention: summary.attention,
    nextChecks: summary.nextChecks,
  };
}

function buildPromptProjectionSchemaFixture(): JsonValue {
  const surfaces = listCliCatalogPromptSurfaces({
    pluginCommands: samplePluginCommands,
    promptPluginIds: new Set(["demo-plugin"]),
  });
  return {
    count: surfaces.length,
    itemFields: arrayContract(surfaces).itemFields,
    ids: surfaces.map((surface) => surface.id).toSorted(),
    pluginSurfaceIds: surfaces
      .filter((surface) => surface.kind === "plugin-command")
      .map((surface) => surface.id)
      .toSorted(),
  };
}

describe("cli catalog schema fixtures", () => {
  it("matches the catalog list schema fixture", () => {
    expectFixture("catalog-list.schema.json", buildCatalogListSchemaFixture());
  });

  it("matches the catalog audit schema fixture", () => {
    expectFixture("catalog-audit.schema.json", buildCatalogAuditSchemaFixture());
  });

  it("matches the catalog test-matrix schema fixture", () => {
    expectFixture("catalog-test-matrix.schema.json", buildCatalogTestMatrixSchemaFixture());
  });

  it("matches the catalog summary schema fixture", () => {
    expectFixture("catalog-summary.schema.json", buildCatalogSummarySchemaFixture());
  });

  it("matches the prompt projection schema fixture", () => {
    expectFixture("catalog-prompt-projection.schema.json", buildPromptProjectionSchemaFixture());
  });
});
