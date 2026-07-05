import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCliCatalogSurfaces } from "./registry.js";

function expectNonEmptyString(value: string, label: string) {
  expect(value, label).toEqual(expect.any(String));
  expect(value.trim().length, label).toBeGreaterThan(0);
}

describe("CLI catalog overlay registry guards", () => {
  it("keeps every surface reviewable", () => {
    for (const surface of listCliCatalogSurfaces()) {
      expectNonEmptyString(surface.id, `${surface.id}.id`);
      expectNonEmptyString(surface.title, `${surface.id}.title`);
      expectNonEmptyString(surface.target, `${surface.id}.target`);
      expectNonEmptyString(surface.source, `${surface.id}.source`);
      expectNonEmptyString(surface.sourceKind, `${surface.id}.sourceKind`);
      expectNonEmptyString(surface.sourceId, `${surface.id}.sourceId`);
      expectNonEmptyString(surface.discoveryMode, `${surface.id}.discoveryMode`);
      expect(surface.visibility.length, `${surface.id}.visibility`).toBeGreaterThan(0);
      expectNonEmptyString(surface.intent, `${surface.id}.intent`);
      expectNonEmptyString(surface.owner, `${surface.id}.owner`);
      expect(surface.examples.length, `${surface.id}.examples`).toBeGreaterThan(0);
      expect(surface.effects.length, `${surface.id}.effects`).toBeGreaterThan(0);
      expect(surface.commandHints.length, `${surface.id}.commandHints`).toBeGreaterThan(0);
      expect(["draft", "stable", "deprecated"]).toContain(surface.status);
      expect(["low", "medium", "high"]).toContain(surface.risk);
      expect(["read", "mutating", "mixed"]).toContain(surface.effectMode);
    }
  });

  it("keeps surface ids unique", () => {
    const ids = listCliCatalogSurfaces().map((surface) => surface.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps descriptor-backed entries aligned with their CLI descriptors", () => {
    for (const surface of listCliCatalogSurfaces().filter((entry) => entry.cliDescriptor)) {
      expect(surface.source).toBe(`CLI descriptor: ${surface.cliDescriptor?.name}`);
      expect(surface.target).toBe(surface.cliDescriptor?.name);
      expect(surface.cliDescriptor?.description.trim().length).toBeGreaterThan(0);
    }
  });
  it("keeps the prompt projection lean", async () => {
    const { buildCliCatalogOverlayPromptSection } =
      await import("../agents/catalog-overlay-prompt.js");
    const section = buildCliCatalogOverlayPromptSection().join("\n");

    expect(section.length).toBeLessThan(3600);
    expect(Math.round(section.length / 4)).toBeLessThan(900);
  });

  it("keeps the prompt projection off the full catalog builder", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/cli-catalog-overlay/prompt-projection.ts"),
      "utf8",
    );

    expect(source).not.toContain('from "./list.js"');
    expect(source).not.toContain("buildCatalogList");
    expect(source).not.toContain("routed-command-definitions");
  });
});
