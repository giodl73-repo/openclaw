import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildCatalogList } from "../../src/cli-catalog-overlay/list.js";

function runList(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/cli-catalog-overlay-list.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("cli-catalog-overlay-list script", () => {
  it("prints JSON from the script entrypoint", () => {
    const result = runList([]);

    expect(result.status).toBe(0);
    const list = JSON.parse(result.stdout) as ReturnType<typeof buildCatalogList>;
    expect(list.counts.commandDescriptors).toBe(56);
    expect(list.counts.commandRoutes).toBe(92);
    expect(list.counts.routedOperations).toBe(14);
    expect(list.agentToolSurfaces.find((surface) => surface.id === "gateway")).toMatchObject({
      descriptor: { name: "gateway" },
    });
  });

  it("prints Markdown from the script entrypoint", () => {
    const result = runList(["--markdown"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# CLI Catalog Overlay List");
    expect(result.stdout).toContain("| `gateway-status` | `gateway status` |");
    expect(result.stdout).toContain(
      "| `gateway` | `runtime` | `medium` | `mixed` | yes | `gateway` | CLI descriptor: gateway |",
    );
  });
});
