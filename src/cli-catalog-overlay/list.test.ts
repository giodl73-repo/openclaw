import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";

describe("cli catalog overlay list", () => {
  it("builds a read-only programmatic list", () => {
    const list = buildCatalogList();

    expect(list).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay",
      counts: {
        commandDescriptors: 58,
        commandRoutes: 94,
        routedOperations: 14,
        agentToolSurfaces: 5,
        promptProjection: 19,
      },
    });
    expect(list.cli.runtimeCommandScope).toBe("current-invocation-registered-tree");
    expect(list.cli.descriptors.find((descriptor) => descriptor.name === "gateway")).toMatchObject({
      source: "subcli",
      hasSubcommands: true,
    });
    expect(
      list.cli.routedOperations.find((operation) => operation.id === "gateway-status"),
    ).toMatchObject({ commandPaths: [["gateway", "status"]] });
    expect(list.agentToolSurfaces.find((surface) => surface.id === "gateway")).toMatchObject({
      owner: "runtime",
      risk: "medium",
      effectMode: "mixed",
      confirmationRequired: true,
      descriptor: { name: "gateway", hasSubcommands: true },
    });
    expect(list.agentToolSurfaces.find((surface) => surface.id === "session_status")).toMatchObject(
      {
        effectMode: "read",
        confirmationRequired: false,
      },
    );
  });

  it("renders a Markdown list table for tools that need text output", () => {
    const markdown = renderCatalogListMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay List");
    expect(markdown).toContain("- CLI descriptors: 58");
    expect(markdown).toContain("- Command routes: 94");
    expect(markdown).toContain("- Runtime command scope: current-invocation-registered-tree");
    expect(markdown).toContain("| `gateway-status` | `gateway status` |");
    expect(markdown).toContain(
      "| `gateway` | `runtime` | `medium` | `mixed` | yes | `gateway` | CLI descriptor: gateway |",
    );
  });
});
