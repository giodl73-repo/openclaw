import { describe, expect, it } from "vitest";
import { buildCliCatalogOverlayPromptSection } from "./catalog-overlay-prompt.js";

describe("buildCliCatalogOverlayPromptSection", () => {
  it("describes the catalog overlay as a metadata-first layer", () => {
    const section = buildCliCatalogOverlayPromptSection().join("\n");

    expect(section).toContain("## CLI Catalog Overlay");
    expect(section).toContain(
      "Use the CLI catalog overlay as metadata over existing OpenClaw command surfaces.",
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
});
