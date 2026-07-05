import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";

const sampleNodeCommands: readonly CliCatalogNodeCommand[] = [
  {
    id: "node:demo-filesystem:filesystem.read",
    command: "filesystem.read",
    title: "Read file through paired node",
    nodeId: "demo-filesystem",
    nodeName: "Demo filesystem node",
    cap: "filesystem",
    description: "Read a file through a paired node command declaration.",
    argumentHints: ["path"],
    invocationHint:
      'openclaw nodes invoke --node demo-filesystem --command filesystem.read --params {"path":"..."}',
    availability: "approved",
    approvalKind: "pairing",
    risk: "medium",
    confirmationRequired: true,
    effectMode: "read",
    effects: ["filesystem.read"],
    trustBoundary: "paired-node",
    sourceKind: "node-pairing",
    sourceId: "demo-filesystem:filesystem.read",
    discoveryMode: "paired-node-declaration",
    visibility: ["docs", "prompt", "audit", "operator", "policy"],
  },
];

describe("cli catalog overlay list", () => {
  it("builds a read-only programmatic list", () => {
    const list = buildCatalogList();

    expect(list).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay",
      counts: {
        commandDescriptors: 61,
        commandRoutes: 97,
        routedOperations: 14,
        agentToolSurfaces: 5,
        promptProjection: 19,
        nodeCommands: 0,
      },
    });
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
        effectMode: "mixed",
        effects: ["session.status", "session.model-override"],
        confirmationRequired: false,
      },
    );
  });

  it("carries supplied node/operator commands through the list contract", () => {
    const list = buildCatalogList({ nodeCommands: sampleNodeCommands });

    expect(list.counts.nodeCommands).toBe(1);
    expect(list.cli.nodeCommands[0]).toMatchObject({
      id: "node:demo-filesystem:filesystem.read",
      command: "filesystem.read",
      availability: "approved",
      approvalKind: "pairing",
      trustBoundary: "paired-node",
    });
    expect(list.promptProjection.nodeCommandIds).toEqual(["node:demo-filesystem:filesystem.read"]);
    expect(list.counts.promptProjection).toBe(20);
  });

  it("renders a Markdown list table for tools that need text output", () => {
    const markdown = renderCatalogListMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay List");
    expect(markdown).toContain("- CLI descriptors: 61");
    expect(markdown).toContain("- Command routes: 97");
    expect(markdown).toContain("- Node/operator commands: 0");
    expect(markdown).toContain("| `gateway-status` | `gateway status` |");
    expect(markdown).toContain(
      "| `gateway` | `runtime` | `medium` | `mixed` | yes | `gateway` | CLI descriptor: gateway |",
    );
  });

  it("renders node/operator command rows when supplied", () => {
    const markdown = renderCatalogListMarkdown({ nodeCommands: sampleNodeCommands });

    expect(markdown).toContain("## Node/operator commands");
    expect(markdown).toContain(
      "| `filesystem.read` | Demo filesystem node | `approved` | `pairing` |",
    );
  });

  it("keeps supplied node metadata inside its Markdown table cells", () => {
    const command = {
      ...sampleNodeCommands[0],
      command: "filesystem.`read`|raw",
      nodeName: "Build | prod\nprimary",
      invocationHint: "nodes invoke `filesystem.read` | inspect\nnext",
    };

    const markdown = renderCatalogListMarkdown({ nodeCommands: [command] });

    expect(markdown).toContain(
      "| `` filesystem.`read`\\|raw `` | Build \\| prod primary | `approved` | `pairing` |",
    );
    expect(markdown).toContain("`` nodes invoke `filesystem.read` \\| inspect next ``");
    expect(markdown).not.toContain("Build | prod\nprimary");
  });
});
