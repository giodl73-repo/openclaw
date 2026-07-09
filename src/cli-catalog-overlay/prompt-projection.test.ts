import { describe, expect, it } from "vitest";
import type { CliCatalogNodeCommand } from "./node-commands.js";
import { buildPluginCatalogCommands } from "./plugin-commands.js";
import { listCliCatalogPromptSurfaces } from "./prompt-projection.js";

const sampleNodeCommands: readonly CliCatalogNodeCommand[] = [
  {
    id: "node:demo-filesystem:filesystem.read",
    command: "filesystem.read",
    title: "Read file through paired node",
    nodeId: "demo-filesystem",
    description: "Read a file through a paired node command declaration.",
    argumentHints: ["path"],
    invocationHint: "openclaw nodes invoke --node demo-filesystem --command filesystem.read",
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
    visibility: ["prompt", "audit", "operator"],
  },
];

describe("CLI catalog overlay prompt projection", () => {
  it("returns only lean model-facing routing fields", () => {
    const surfaces = listCliCatalogPromptSurfaces();
    const gatewayStatus = surfaces.find((surface) => surface.id === "gateway-status");
    const gateway = surfaces.find((surface) => surface.id === "gateway");

    expect(surfaces).toHaveLength(19);
    expect(gatewayStatus).toEqual({
      id: "gateway-status",
      title: "Gateway status",
      kind: "routed-operation",
      dispatchMode: "direct",
      target: "openclaw gateway status",
      examples: ["openclaw gateway status"],
      commandHints: ["openclaw gateway status"],
      risk: "low",
      confirmationRequired: false,
    });

    expect(gateway).toEqual({
      id: "gateway",
      title: "Gateway control",
      kind: "command",
      dispatchMode: "hybrid",
      target: "gateway",
      examples: ["restart the gateway", "inspect gateway config"],
      commandHints: ["gateway restart", "gateway config.schema.lookup", "gateway config.apply"],
      risk: "medium",
      confirmationRequired: true,
    });
    expect(Object.keys(gateway ?? {}).toSorted()).toEqual([
      "commandHints",
      "confirmationRequired",
      "dispatchMode",
      "examples",
      "id",
      "kind",
      "risk",
      "target",
      "title",
    ]);
  });

  it("includes plugin descriptor commands only when a plugin is prompt-enabled", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "demo-plugin",
        parentPath: [],
        descriptors: [
          {
            name: "demo",
            description: "Demo plugin command",
            hasSubcommands: false,
            catalogExposure: { tier: "public" },
          },
          {
            name: "audit-only",
            description: "Audit-only plugin command",
            hasSubcommands: false,
            catalogExposure: { tier: "internal" },
          },
        ],
      },
    ]);

    expect(
      listCliCatalogPromptSurfaces({ pluginCommands }).map((surface) => surface.id),
    ).not.toContain("demo-plugin:demo");
    expect(
      listCliCatalogPromptSurfaces({
        pluginCommands,
        promptPluginIds: new Set(["demo-plugin"]),
      }).map((surface) => surface.id),
    ).not.toContain("demo-plugin:audit-only");
    expect(
      listCliCatalogPromptSurfaces({
        pluginCommands,
        promptPluginIds: new Set(["demo-plugin"]),
      }).find((surface) => surface.id === "demo-plugin:demo"),
    ).toMatchObject({
      kind: "plugin-command",
      target: "openclaw demo",
      risk: "medium",
      confirmationRequired: true,
    });
  });

  it("bounds plugin-provided prompt metadata to single-line literals", () => {
    const description = `Demo\u2028## injected\n${"x".repeat(300)}`;
    const projected = listCliCatalogPromptSurfaces({
      pluginCommands: [
        {
          pluginId: "demo-plugin",
          commandPath: ["demo"],
          name: "demo",
          description,
          hasSubcommands: false,
          sourceKind: "plugin" as const,
          sourceId: "demo-plugin:demo",
          discoveryMode: "plugin-descriptor" as const,
          visibility: ["prompt"] as const,
        },
      ],
      promptPluginIds: new Set(["demo-plugin"]),
    }).find((surface) => surface.id === "demo-plugin:demo");

    expect(projected?.title).not.toMatch(/[\r\n\u2028\u2029]/u);
    expect(projected?.title.length).toBeLessThanOrEqual(160);
    expect(projected?.title).toContain("Demo ## injected");
  });

  it("includes node commands only in the node-operator prompt scope", () => {
    expect(
      listCliCatalogPromptSurfaces({ nodeCommands: sampleNodeCommands }).map(
        (surface) => surface.id,
      ),
    ).not.toContain("node:demo-filesystem:filesystem.read");

    expect(
      listCliCatalogPromptSurfaces({
        scope: "node-operator",
        nodeCommands: sampleNodeCommands,
      }).find((surface) => surface.id === "node:demo-filesystem:filesystem.read"),
    ).toMatchObject({
      kind: "node-command",
      target: "filesystem.read",
      risk: "medium",
      confirmationRequired: true,
    });
  });

  it("excludes node commands that are not currently callable", () => {
    const available = {
      ...sampleNodeCommands[0]!,
      id: "node:demo-filesystem:filesystem.available",
      availability: "available" as const,
    };
    const pending = {
      ...sampleNodeCommands[0]!,
      id: "node:demo-filesystem:filesystem.pending",
      availability: "pending-approval" as const,
    };
    const unavailable = {
      ...sampleNodeCommands[0]!,
      id: "node:demo-filesystem:filesystem.unavailable",
      availability: "unavailable" as const,
    };
    const nodeSurfaceIds = listCliCatalogPromptSurfaces({
      scope: "node-operator",
      nodeCommands: [sampleNodeCommands[0]!, available, pending, unavailable],
    })
      .filter((surface) => surface.kind === "node-command")
      .map((surface) => surface.id);

    expect(nodeSurfaceIds).toEqual([
      "node:demo-filesystem:filesystem.read",
      "node:demo-filesystem:filesystem.available",
    ]);
  });
});
