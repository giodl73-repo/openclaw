import { describe, expect, it } from "vitest";
import { buildCliCatalogOverlayPromptSection } from "./catalog-overlay-prompt.js";

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
      "commands=gateway status | gateway restart | gateway config.schema.lookup | gateway config.apply",
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
    expect(section).toContain("- gateway:");
    expect(section).not.toContain("skill_workshop");
    expect(section).not.toContain("sessions_spawn");
    expect(section).not.toContain("commands=process");
  });
});
