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
  it("captures exactly one generation for each owned upstream PR", async () => {
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
    const admittedPrs = new Set([104018, 107026, 113421, 113422, 114636]);
    for (const source of ledger.entries) {
      expect(source.pr).toBeGreaterThan(0);
      expect(source.phase).toMatch(/^C(?:[0245]|[13][abc])$/);
      expect(source.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(source.branch).not.toHaveLength(0);
      expect(source.disposition).toBe(
        admittedPrs.has(source.pr) ? "evidence-only/admitted" : "source-only/quarantined",
      );
      expect(source.authority).toBe("none");
      expect(prs.has(source.pr)).toBe(false);
      expect(headShas.has(source.headSha)).toBe(false);
      prs.add(source.pr);
      headShas.add(source.headSha);
    }
  });

  it("admits only the exact classified evidence source generations through the queue", async () => {
    const ledger = await readJson<SourceLedger>(".lobster/sources.json");
    const queue = await readJson<{
      base: { commit: string };
      sourceInventory: string;
      entries: Array<{ id: string; sourceSha: string }>;
    }>(".lobster/queue.json");
    const sourcesBySha = new Map(ledger.entries.map((source) => [source.headSha, source]));

    expect(queue.sourceInventory).toBe("sources.json");
    expect(queue.base.commit).toBe(ledger.baseCommit);

    for (const entry of queue.entries) {
      const source = sourcesBySha.get(entry.sourceSha);
      expect(source).toBeDefined();
      expect(source?.disposition).toBe("evidence-only/admitted");
      expect(source?.authority).toBe("none");
    }

    expect(queue.entries).toHaveLength(5);
    expect(queue.entries.map((entry) => entry.id)).toEqual([
      "EVID-001-107026",
      "EVID-001-104018",
      "EVID-001-113421",
      "EVID-002-113422",
      "EVID-002-114636",
    ]);
  });
});
