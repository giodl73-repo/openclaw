import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";

describe("cli catalog overlay list", () => {
  it("builds a read-only programmatic list", () => {
    const list = buildCatalogList();

    expect(list).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay",
      surfaceCount: 5,
    });
    expect(list.surfaces.find((surface) => surface.id === "gateway")).toMatchObject({
      owner: "runtime",
      risk: "medium",
      effectMode: "mixed",
      confirmationRequired: true,
      descriptor: { name: "gateway", hasSubcommands: true },
    });
    expect(list.surfaces.find((surface) => surface.id === "session_status")).toMatchObject({
      effectMode: "read",
      confirmationRequired: false,
    });
  });

  it("renders a Markdown list table for tools that need text output", () => {
    const markdown = renderCatalogListMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay List");
    expect(markdown).toContain(
      "| `gateway` | `runtime` | `medium` | `mixed` | yes | `gateway` | CLI descriptor: gateway |",
    );
  });
});
