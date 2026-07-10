import { describe, expect, it } from "vitest";
import type { CliCatalogNodeCommand } from "../cli-catalog-overlay/node-commands.js";
import { buildCliCatalogOverlayPromptSection } from "./catalog-overlay-prompt.js";

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

describe("buildCliCatalogOverlayPromptSection", () => {
  it("describes the catalog overlay as a metadata-first layer", () => {
    const section = buildCliCatalogOverlayPromptSection().join("\n");

    expect(section).toContain("## CLI Catalog Overlay");
    expect(section).toContain(
      "Use catalog metadata to route bounded requests to existing OpenClaw commands/tools",
    );
    expect(section).toContain("### Catalog");
    expect(section).toContain("- gateway: Gateway control");
    expect(section).toContain(
      "commands=gateway restart | gateway config.schema.lookup | gateway config.apply",
    );
    expect(section).not.toContain("source=");
    expect(section).not.toContain("owner=");
    expect(section).not.toContain("status=");
    expect(section).not.toContain("confidence=");
    expect(section).not.toContain("effects=");
    expect(section).not.toContain("aliases=");
  });

  it("keeps the rendered overlay within a lean token budget", () => {
    const section = buildCliCatalogOverlayPromptSection().join("\n");
    const approxTokens = Math.round(section.length / 4);

    expect(section.length).toBeLessThan(1800);
    expect(approxTokens).toBeLessThan(450);
  });

  it("filters unavailable tool-backed surfaces when tools are scoped", () => {
    const section = buildCliCatalogOverlayPromptSection({
      availableTools: new Set(["read", "session_status"]),
    }).join("\n");

    expect(section).toContain("session_status");
    expect(section).not.toContain("- gateway:");
    expect(section).not.toContain("gateway-status->");
    expect(section).not.toContain("agents-list->");
    expect(section).not.toContain("config-unset->");
    expect(section).not.toContain("skill_workshop");
    expect(section).not.toContain("sessions_spawn");
    expect(section).not.toContain("commands=process");
  });

  it("keeps CLI-backed surfaces aligned with exec availability", () => {
    const pluginCommands = [
      {
        pluginId: "demo-plugin",
        commandPath: ["demo"],
        parentPath: [],
        depth: 1,
        name: "demo",
        descriptorName: "demo",
        description: "Demo plugin command",
        hasSubcommands: false,
        hidden: false as const,
        risk: "medium",
        confirmationRequired: true,
        effectMode: "mixed",
        commandHints: ["demo"],
        sourceKind: "plugin" as const,
        sourceId: "demo-plugin:demo",
        discoveryMode: "plugin-descriptor" as const,
        visibility: ["prompt"] as const,
      },
    ];
    const withoutExec = buildCliCatalogOverlayPromptSection({
      availableTools: new Set(["read"]),
      pluginCommands,
      promptPluginIds: new Set(["demo-plugin"]),
    }).join("\n");
    const withExec = buildCliCatalogOverlayPromptSection({
      availableTools: new Set(["exec"]),
      pluginCommands,
      promptPluginIds: new Set(["demo-plugin"]),
    }).join("\n");

    expect(withoutExec).not.toContain("gateway-status->");
    expect(withoutExec).not.toContain("demo-plugin:demo");
    expect(withExec).toContain("gateway-status->openclaw gateway status");
    expect(withExec).toContain("agents-list->openclaw agents");
    expect(withExec).toContain("config-unset->openclaw config unset");
    expect(withExec).toContain("target=openclaw demo");
    expect(withExec).not.toContain("- gateway:");
  });

  it("does not advertise host CLI routes to sandboxed exec", () => {
    const section = buildCliCatalogOverlayPromptSection({
      availableTools: new Set(["exec", "gateway"]),
      hostCliAvailable: false,
    }).join("\n");

    expect(section).not.toContain("gateway-status->");
    expect(section).not.toContain("agents-list->");
    expect(section).toContain("- gateway: Gateway control");
  });

  it("renders node command prompt lines only for node-operator scope", () => {
    const defaultSection = buildCliCatalogOverlayPromptSection({
      nodeCommands: sampleNodeCommands,
    }).join("\n");
    const nodeOperatorSection = buildCliCatalogOverlayPromptSection({
      nodeCommands: sampleNodeCommands,
      scope: "node-operator",
    }).join("\n");

    expect(defaultSection).not.toContain("node:demo-filesystem:filesystem.read");
    expect(nodeOperatorSection).toContain(
      "- node:demo-filesystem:filesystem.read: Read file through paired node target=filesystem.read r=medium c=1",
    );
    expect(nodeOperatorSection).toContain(
      "commands=openclaw nodes invoke --node demo-filesystem --command filesystem.read | path",
    );
  });
});
