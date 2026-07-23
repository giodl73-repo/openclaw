import { describe, expect, it } from "vitest";
import {
  buildCommandSearchEntries,
  describeCommandEntry,
  searchCommandEntries,
} from "./command-search.js";
import { buildCatalogList } from "./list.js";
import type { CliCatalogRuntimeCommand } from "./runtime-commands.js";

describe("command search projection", () => {
  it("returns bounded compact hits and hydrates exact details", () => {
    const entries = buildCommandSearchEntries(buildCatalogList());
    const hits = searchCommandEntries(entries, "gateway", 3);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits[0]).not.toHaveProperty("detail");
    expect(describeCommandEntry(entries, hits[0]!.id)?.detail).toBeDefined();
  });

  it("searches nested runtime commands and aliases", () => {
    const runtimeCommand: CliCatalogRuntimeCommand = {
      commandPath: ["models", "aliases", "list"],
      parentPath: ["models", "aliases"],
      depth: 3,
      name: "list",
      aliases: ["lsmodels"],
      description: "List model aliases",
      hasSubcommands: false,
      visibleSubcommandCount: 0,
      hidden: false,
      sourceKind: "runtime",
      sourceId: "models aliases list",
      discoveryMode: "runtime-registered",
      visibility: ["audit", "operator", "policy"],
    };
    const entries = buildCommandSearchEntries(
      buildCatalogList({ runtimeCommands: [runtimeCommand] }),
    );

    expect(searchCommandEntries(entries, "lsmodels")).toContainEqual(
      expect.objectContaining({ id: "runtime:models aliases list", kind: "runtime" }),
    );
  });

  it("keeps a focused response smaller than the complete directory", () => {
    const entries = buildCommandSearchEntries(buildCatalogList());
    const directoryChars = JSON.stringify(entries).length;
    const resultChars = JSON.stringify(searchCommandEntries(entries, "gateway", 8)).length;

    expect(resultChars).toBeLessThan(directoryChars / 2);
  });
});
