import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCliCatalogReferenceMarkdown,
  CATALOG_REFERENCE_DOC_PATH,
  runCliCatalogDocGenerator,
} from "../../scripts/generate-cli-catalog-doc.js";

describe("generate CLI catalog docs", () => {
  it("keeps the checked-in catalog reference current", () => {
    expect(readFileSync(CATALOG_REFERENCE_DOC_PATH, "utf8")).toBe(
      buildCliCatalogReferenceMarkdown(),
    );
  });

  it("covers every catalog lens in the generated page", () => {
    const content = buildCliCatalogReferenceMarkdown();

    expect(content).toContain("`openclaw catalog list`");
    expect(content).toContain("`openclaw catalog audit`");
    expect(content).toContain("`openclaw catalog test-matrix`");
    expect(content).toContain("`openclaw catalog summary`");
    expect(content).toContain("## Prompt projection");
    expect(content).toContain("## Dynamic command inventory");
    expect(content).toContain("`openclaw catalog list --json --plugin-descriptors`");
    expect(content).toContain("test/fixtures/cli-catalog-overlay/");
  });

  it("keeps public docs stable when private QA CLI is enabled", () => {
    const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    try {
      const content = buildCliCatalogReferenceMarkdown();

      expect(content).toContain("descriptors 58");
      expect(content).not.toContain("`qa`");
    } finally {
      if (originalPrivateQaCli === undefined) {
        delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
      } else {
        process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
      }
    }
  });

  it("requires exactly one update mode", () => {
    expect(runCliCatalogDocGenerator([])).toBe(1);
    expect(runCliCatalogDocGenerator(["--write", "--check"])).toBe(1);
  });
});
