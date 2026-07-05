import { describe, expect, it } from "vitest";
import { buildCatalogAudit, renderCatalogAuditMarkdown } from "./audit.js";

describe("cli catalog overlay audit", () => {
  it("builds read-only audit groupings from the catalog list", () => {
    const audit = buildCatalogAudit();

    expect(audit).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "cli-catalog-overlay-audit",
      counts: {
        agentToolSurfaces: 5,
        confirmationRequiredSurfaces: 2,
        commandRoutes: 93,
      },
    });
    expect(audit.surfaces.confirmationRequiredSurfaceIds).toEqual(["gateway", "skill_workshop"]);
    expect(audit.surfaces.byRisk.find((group) => group.id === "medium")).toMatchObject({
      count: 2,
      surfaceIds: ["gateway", "skill_workshop"],
    });
    expect(audit.surfaces.byEffectMode.find((group) => group.id === "read")).toMatchObject({
      surfaceIds: ["session_status"],
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

  it("renders Markdown for operator-facing audit output", () => {
    const markdown = renderCatalogAuditMarkdown();

    expect(markdown).toContain("# CLI Catalog Overlay Audit");
    expect(markdown).toContain("- Agent/tool surfaces: 5");
    expect(markdown).toContain("- Command routes: 93");
    expect(markdown).toContain("| Risk | `low` (3), `medium` (2) |");
    expect(markdown).toContain("| Confirmation required | `gateway`, `skill_workshop` |");
    expect(markdown).toContain("| `networkProxy` |");
  });
});
