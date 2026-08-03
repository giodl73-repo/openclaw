import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type SourceEntry = {
  pr: number;
  phase: string;
  draft: boolean;
  headSha: string;
  branch: string;
  disposition: string;
  authority: string;
};

type SourceLedger = {
  schemaVersion: number;
  repository: string;
  sourceOwner: string;
  baseCommit: string;
  defaultDisposition: string;
  entries: SourceEntry[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8")) as T;
}

describe("Lobster source ledger", () => {
  it("captures exactly one quarantined generation for each owned upstream PR", async () => {
    const ledger = await readJson<SourceLedger>(".lobster/sources.json");

    expect(ledger).toMatchObject({
      schemaVersion: 1,
      repository: "openclaw/openclaw",
      sourceOwner: "giodl73-repo",
      defaultDisposition: "source-only/quarantined",
    });
    expect(ledger.entries).toHaveLength(55);

    const prs = new Set<number>();
    const headShas = new Set<string>();
    for (const source of ledger.entries) {
      expect(source.pr).toBeGreaterThan(0);
      expect(source.phase).toMatch(/^C(?:[0245]|[13][abc])$/);
      expect(source.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(source.branch).not.toHaveLength(0);
      expect(source.disposition).toBe("source-only/quarantined");
      expect(source.authority).toBe("none");
      expect(prs.has(source.pr)).toBe(false);
      expect(headShas.has(source.headSha)).toBe(false);
      prs.add(source.pr);
      headShas.add(source.headSha);
    }
  });

  it("does not admit source inventory through the reconstruction queue", async () => {
    const ledger = await readJson<SourceLedger>(".lobster/sources.json");
    const queue = await readJson<{
      base: { commit: string };
      sourceInventory: string;
      entries: Array<{ sourcePr?: number; sourceSha?: string }>;
    }>(".lobster/queue.json");
    const sourcesByPr = new Map(ledger.entries.map((source) => [source.pr, source]));

    expect(queue.sourceInventory).toBe("sources.json");
    expect(queue.base.commit).toBe(ledger.baseCommit);

    for (const entry of queue.entries) {
      if (entry.sourcePr === undefined) {
        continue;
      }
      const source = sourcesByPr.get(entry.sourcePr);
      expect(source).toBeDefined();
      expect(entry.sourceSha).toBe(source?.headSha);
    }

    expect(queue.entries).toHaveLength(0);
  });
});
