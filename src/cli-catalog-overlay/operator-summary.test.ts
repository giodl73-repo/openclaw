import { describe, expect, it } from "vitest";
import { buildCatalogAudit } from "./audit.js";
import { buildCatalogList } from "./list.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";
import {
  buildCatalogOperatorSummary,
  renderCatalogOperatorSummaryMarkdown,
} from "./operator-summary.js";
import { buildPluginCatalogCommands } from "./plugin-commands.js";

const sampleNodeCommands: readonly CliCatalogNodeCommand[] = [
  {
    id: "node:demo-filesystem:filesystem.write",
    command: "filesystem.write",
    title: "Write file through paired node",
    description: "Write a file through a paired node command declaration.",
    argumentHints: ["path", "content"],
    invocationHint: "openclaw nodes invoke --node demo-filesystem --command filesystem.write",
    availability: "pending-approval",
    approvalKind: "operator-confirmation",
    risk: "high",
    confirmationRequired: true,
    effectMode: "mutating",
    effects: ["filesystem.write"],
    trustBoundary: "paired-node",
    sourceKind: "node-pairing",
    sourceId: "demo-filesystem:filesystem.write",
    discoveryMode: "paired-node-declaration",
    visibility: ["audit", "operator"],
  },
];

describe("cli catalog operator summary", () => {
  it("combines catalog list, audit, and test-matrix counts", () => {
    const summary = buildCatalogOperatorSummary();

    expect(summary).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-operator-summary",
      counts: {
        commandDescriptors: 61,
        commandRoutes: 97,
        routedOperations: 14,
        agentToolSurfaces: 5,
        confirmationRequiredSurfaces: 3,
        routePolicyKeys: 8,
      },
    });
    expect(summary.attention.confirmationRequiredSurfaceIds).toEqual([
      "config-unset",
      "gateway",
      "skill_workshop",
    ]);
    expect(summary.attention.mediumRiskSurfaceIds).toEqual([
      "config-unset",
      "gateway",
      "skill_workshop",
    ]);
    expect(summary.attention.highRiskSurfaceIds).toEqual([]);
    expect(summary.attention.policyKeyIds).toContain("networkProxy");
  });

  it("surfaces node/operator approval attention", () => {
    const list = buildCatalogList({ nodeCommands: sampleNodeCommands });
    const audit = buildCatalogAudit(list);
    const summary = buildCatalogOperatorSummary({ list, audit });

    expect(summary.counts.nodeCommands).toBe(1);
    expect(summary.attention.nodeCommandApprovalIds).toEqual([
      "node:demo-filesystem:filesystem.write",
    ]);
    expect(summary.nextChecks).toContain(
      "Review node/operator command approval state before exposing node-scoped prompt projections.",
    );
  });

  it("surfaces high-risk plugin attention without relying on confirmation", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "deploy-plugin",
        parentPath: [],
        commands: ["deploy"],
        descriptors: [
          {
            name: "deploy",
            description: "Deploy a release",
            hasSubcommands: false,
            effectProfile: {
              effectMode: "mutating",
              risk: "high",
              confirmationRequired: false,
            },
          },
        ],
      },
    ]);
    const list = buildCatalogList({ pluginCommands });
    const summary = buildCatalogOperatorSummary({ list });

    expect(summary.attention.highRiskSurfaceIds).toEqual(["deploy-plugin:deploy"]);
    expect(summary.attention.confirmationRequiredSurfaceIds).not.toContain("deploy-plugin:deploy");
    expect(summary.nextChecks).toContain(
      "Review high-risk catalog surfaces before widening automation.",
    );
  });

  it("renders Markdown for diagnostics and operator handoffs", () => {
    const markdown = renderCatalogOperatorSummaryMarkdown();

    expect(markdown).toContain("# CLI Catalog Operator Summary");
    expect(markdown).toContain("- Command routes: 97");
    expect(markdown).toContain("- Node/operator commands: 0");
    expect(markdown).toContain(
      "- Confirmation required: `config-unset`, `gateway`, `skill_workshop`",
    );
    expect(markdown).toContain("- High risk: None");
    expect(markdown).toContain("- Route policy keys:");
  });
});
