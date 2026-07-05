import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLI_CATALOG_OVERLAY_DOC_PATH,
  renderCliCatalogOverlayReferenceDoc,
} from "../../scripts/generate-cli-catalog-overlay-doc.js";

describe("generate-cli-catalog-overlay-doc", () => {
  it("renders the catalog overlay reference page", () => {
    const doc = renderCliCatalogOverlayReferenceDoc();

    expect(doc).toContain("# AI Surface Catalog");
    expect(doc).toContain("metadata only");
    expect(doc).toContain("openclaw catalog list --json");
    expect(doc).toContain("| Name          | Description");
    expect(doc).toContain("| Command path          | Exact | Route ID");
    expect(doc).toContain("| Operation         | Command paths");
    expect(doc).toContain("### `gateway`: Gateway control");
    expect(doc).toContain("- CLI descriptor: `gateway`");
    expect(doc).toContain("| `gateway-status`  | `gateway status`");
    expect(doc).toContain("### `skill_workshop`: Skill Workshop proposals");
  });

  it("keeps the committed reference page current", () => {
    expect(fs.readFileSync(CLI_CATALOG_OVERLAY_DOC_PATH, "utf8")).toBe(
      renderCliCatalogOverlayReferenceDoc(),
    );
  });
});
