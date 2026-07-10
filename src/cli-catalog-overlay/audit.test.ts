import { describe, expect, it } from "vitest";
import { buildCatalogAudit, renderCatalogAuditMarkdown } from "./audit.js";
import { buildCatalogList } from "./list.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";

const sampleNodeCommands: readonly CliCatalogNodeCommand[] = [
  {
    id: "node:demo-host:mcp.status",
    command: "mcp.status",
    title: "MCP node status",
    description: "Report MCP status from a local node host command.",
    argumentHints: [],
    invocationHint: "openclaw nodes invoke --node demo-host --command mcp.status",
    availability: "pending-approval",
    approvalKind: "gateway-allowlist",
    risk: "low",
    confirmationRequired: false,
    effectMode: "read",
    effects: ["mcp.status"],
    trustBoundary: "local-node-host",
    sourceKind: "node-host-command",
    sourceId: "demo-host:mcp.status",
    discoveryMode: "node-host-registry",
    visibility: ["audit", "operator"],
  },
];

describe("cli catalog overlay audit", () => {
  it("builds read-only audit groupings from the catalog list", () => {
    const audit = buildCatalogAudit();

    expect(audit).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-audit",
      counts: {
        agentToolSurfaces: 5,
        confirmationRequiredSurfaces: 3,
        commandRoutes: 97,
      },
    });
    expect(audit.surfaces.confirmationRequiredSurfaceIds).toEqual([
      "config-unset",
      "gateway",
      "skill_workshop",
    ]);
    expect(audit.surfaces.byRisk.find((group) => group.id === "medium")).toMatchObject({
      count: 3,
      surfaceIds: ["config-unset", "gateway", "skill_workshop"],
    });
    expect(audit.surfaces.byEffectMode.find((group) => group.id === "mutating")).toMatchObject({
      surfaceIds: ["config-unset", "sessions_spawn"],
    });
    expect(audit.surfaces.byEffectMode.find((group) => group.id === "mixed")).toMatchObject({
      surfaceIds: ["gateway", "process", "session_status", "skill_workshop"],
    });
    expect(audit.surfaces.byOwner.find((group) => group.id === "agents")).toMatchObject({
      count: 4,
    });
    expect(
      audit.commandRoutes.byPolicyKey.find((group) => group.policyKey === "networkProxy"),
    ).toMatchObject({
      commandPaths: expect.arrayContaining([["catalog"], ["gateway", "status"], ["status"]]),
    });
  });

  it("groups node/operator commands by approval and trust boundary", () => {
    const audit = buildCatalogAudit(buildCatalogList({ nodeCommands: sampleNodeCommands }));

    expect(audit.counts.nodeCommands).toBe(1);
    expect(audit.counts.nodeCommandsRequiringApproval).toBe(1);
    expect(audit.nodeCommands.byApprovalKind).toContainEqual({
      id: "gateway-allowlist",
      count: 1,
      surfaceIds: ["node:demo-host:mcp.status"],
    });
    expect(audit.nodeCommands.byTrustBoundary).toContainEqual({
      id: "local-node-host",
      count: 1,
      surfaceIds: ["node:demo-host:mcp.status"],
    });
  });

  it("derives approval attention from pending and confirmation state", () => {
    const available = {
      ...sampleNodeCommands[0]!,
      id: "node:demo-host:mcp.available",
      availability: "available" as const,
      approvalKind: "none" as const,
      confirmationRequired: false,
    };
    const approvedWithConfirmation = {
      ...sampleNodeCommands[0]!,
      id: "node:demo-host:mcp.confirm",
      availability: "approved" as const,
      approvalKind: "none" as const,
      confirmationRequired: true,
    };
    const unavailable = {
      ...sampleNodeCommands[0]!,
      id: "node:demo-host:mcp.unavailable",
      availability: "unavailable" as const,
      approvalKind: "gateway-allowlist" as const,
      confirmationRequired: false,
    };
    const audit = buildCatalogAudit(
      buildCatalogList({
        nodeCommands: [sampleNodeCommands[0]!, available, approvedWithConfirmation, unavailable],
      }),
    );

    expect(audit.counts.nodeCommandsRequiringApproval).toBe(2);
    expect(audit.nodeCommands.approvalRequiredCommandIds).toEqual([
      "node:demo-host:mcp.confirm",
      "node:demo-host:mcp.status",
    ]);
  });

  it("renders Markdown for operator-facing audit output", () => {
    const markdown = renderCatalogAuditMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Audit");
    expect(markdown).toContain("- Agent/tool surfaces: 5");
    expect(markdown).toContain("- Command routes: 97");
    expect(markdown).toContain("- Node/operator commands: 0");
    expect(markdown).toContain("| Risk | `low` (16), `medium` (3) |");
    expect(markdown).toContain(
      "| Confirmation required | `config-unset`, `gateway`, `skill_workshop` |",
    );
    expect(markdown).toContain("| `networkProxy` |");
    expect(markdown).toContain("## Command routes without policy keys");
    expect(markdown).toContain("`skills install`, `skills search`, `skills update`");
  });
});
