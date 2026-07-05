import { describe, expect, it } from "vitest";
import { buildCliCatalogConsumerContract } from "./consumer-contract.js";

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
    expect(contract.repoInternalBuilderModules).toContain(
      "src/cli-catalog-overlay/consumer-contract.js",
    );
    expect(contract.jsonOutputs.map((output) => output.id)).toEqual([
      "list",
      "audit",
      "test-matrix",
      "summary",
    ]);
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
});
