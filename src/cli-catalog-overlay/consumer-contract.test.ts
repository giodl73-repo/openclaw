import { describe, expect, it } from "vitest";
import { buildCatalogAudit } from "./audit.js";
import { buildCliCatalogConsumerContract } from "./consumer-contract.js";
import { buildCatalogList } from "./list.js";
import { buildCatalogOperatorSummary } from "./operator-summary.js";
import { buildCatalogTestMatrix } from "./test-matrix.js";

describe("CLI catalog consumer contract", () => {
  it("documents read-only policy and admin consumer surfaces", () => {
    const contract = buildCliCatalogConsumerContract();

    expect(contract).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-consumer-contract",
      readOnly: true,
    });
    expect(contract.consumers).toEqual(["policy", "admin", "diagnostics", "prompt", "ci-report"]);
    expect(contract.stableExternalCommands).toContain("openclaw catalog list --json");
    expect(contract.advisoryReportArtifacts).toContain("catalog-report.md");
    expect(contract.repoInternalBuilderModules).toContain(
      "src/cli-catalog-overlay/consumer-contract.js",
    );
    expect(contract.jsonOutputs.map((output) => output.id)).toEqual([
      "list",
      "audit",
      "test-matrix",
      "summary",
    ]);
    expect(contract.contractNotes.join("\n")).toContain("stable external read path");
    expect(contract.contractNotes.join("\n")).toContain("not as the durable public API");
    expect(contract.nonGoals.join("\n")).toContain("does not enforce policy");
  });

  it("marks inventory fields as snapshots rather than permanent promises", () => {
    const contract = buildCliCatalogConsumerContract();

    expect(
      contract.jsonOutputs.every((output) => output.stableFields.includes("schemaVersion")),
    ).toBe(true);
    expect(contract.jsonOutputs.every((output) => output.snapshotFields.includes("counts.*"))).toBe(
      true,
    );
  });

  it("lists only top-level fields emitted by each JSON builder", () => {
    const list = buildCatalogList();
    const audit = buildCatalogAudit(list);
    const outputs = new Map<string, object>([
      ["list", list],
      ["audit", audit],
      ["test-matrix", buildCatalogTestMatrix({ list })],
      ["summary", buildCatalogOperatorSummary({ list, audit })],
    ]);

    for (const contract of buildCliCatalogConsumerContract().jsonOutputs) {
      const output = outputs.get(contract.id);
      expect(output, contract.id).toBeDefined();
      expect(contract.stableFields.every((field) => Object.hasOwn(output!, field))).toBe(true);
    }
  });
});
