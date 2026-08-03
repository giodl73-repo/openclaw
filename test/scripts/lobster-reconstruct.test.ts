import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SCRIPT = resolve("scripts/lobster-reconstruct.mjs");

function git(repository: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    input,
  }).trim();
}

function createRepository(): {
  repository: string;
  baseCommit: string;
  baseTree: string;
  sourceSha: string;
  patchId: string;
} {
  const repository = tempDirs.make("lobster-reconstruct-");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Lobster Test"]);
  git(repository, ["config", "user.email", "lobster@example.test"]);
  writeFileSync(join(repository, "base.txt"), "base\n");
  git(repository, ["add", "base.txt"]);
  git(repository, ["commit", "-m", "base"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  const baseTree = git(repository, ["rev-parse", "HEAD^{tree}"]);
  writeFileSync(join(repository, "carried.txt"), "carried\n");
  git(repository, ["add", "carried.txt"]);
  git(repository, ["commit", "-m", "carried"]);
  const sourceSha = git(repository, ["rev-parse", "HEAD"]);
  const patch = git(repository, ["show", "--pretty=format:", "--binary", sourceSha]);
  const patchId = git(repository, ["patch-id", "--stable"], patch).split(/\s+/u)[0];
  if (!patchId) {
    throw new Error("git patch-id returned no patch identity");
  }
  git(repository, ["reset", "--hard", baseCommit]);
  return { repository, baseCommit, baseTree, sourceSha, patchId };
}

function manifest(baseCommit: string, baseTree: string, entries: object[] = []) {
  return {
    schemaVersion: 1,
    base: { repository: "openclaw/openclaw", commit: baseCommit, tree: baseTree },
    integration: { repository: "example/openclaw", branch: "lobster/integration" },
    entries,
  };
}

function runReconstruct({
  repository,
  manifestValue,
  target,
  resultPath = "",
}: {
  repository: string;
  manifestValue: object;
  target: string;
  resultPath?: string;
}) {
  const manifestPath = join(repository, `manifest-${Date.now()}-${Math.random()}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifestValue, null, 2)}\n`);
  const args = [SCRIPT, "--repository", repository, "--manifest", manifestPath, "--target", target];
  if (resultPath) {
    args.push("--result", resultPath);
  }
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

describe("lobster reconstruction", () => {
  it("reconstructs an empty queue at the exact pinned tree", () => {
    const { repository, baseCommit, baseTree } = createRepository();
    const target = join(tempDirs.make("lobster-empty-parent-"), "worktree");
    const result = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree),
      target,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      resultCommit: baseCommit,
      resultTree: baseTree,
      applied: [],
    });
    git(repository, ["worktree", "remove", "--force", target]);
  });

  it("applies admitted commits and ignores source-only inventory", () => {
    const { repository, baseCommit, baseTree, sourceSha, patchId } = createRepository();
    const target = join(tempDirs.make("lobster-applied-parent-"), "worktree");
    const resultPath = join(repository, "result.json");
    const result = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree, [
        {
          id: "source-only",
          state: "source-only",
          dependsOn: [],
          sourceSha,
          patchId,
          kind: "cherry-pick",
        },
        {
          id: "admitted",
          state: "evidence-only",
          dependsOn: ["source-only"],
          sourceSha,
          patchId,
          kind: "cherry-pick",
        },
      ]),
      target,
      resultPath,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.applied).toHaveLength(1);
    expect(parsed.applied[0]).toMatchObject({ id: "admitted", sourceSha, patchId });
    expect(readFileSync(join(target, "carried.txt"), "utf8").replaceAll("\r\n", "\n")).toBe(
      "carried\n",
    );
    expect(JSON.parse(readFileSync(resultPath, "utf8")).resultDigest).toBe(parsed.resultDigest);
    git(repository, ["worktree", "remove", "--force", target]);
  });

  it("proves a no-op queue entry does not change the tree", () => {
    const { repository, baseCommit, baseTree } = createRepository();
    const target = join(tempDirs.make("lobster-noop-parent-"), "worktree");
    const result = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree, [
        { id: "noop-proof", state: "evidence-only", dependsOn: [], kind: "noop" },
      ]),
      target,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      resultCommit: baseCommit,
      resultTree: baseTree,
    });
    git(repository, ["worktree", "remove", "--force", target]);
  });

  it("reconstructs admitted commits deterministically across local identities", () => {
    const { repository, baseCommit, baseTree, sourceSha, patchId } = createRepository();
    const entry = {
      id: "deterministic",
      state: "evidence-only",
      dependsOn: [],
      sourceSha,
      patchId,
      kind: "cherry-pick",
    };
    const firstTarget = join(tempDirs.make("lobster-deterministic-first-parent-"), "worktree");
    git(repository, ["config", "user.name", "First Reconstructor"]);
    git(repository, ["config", "user.email", "first@example.test"]);
    const first = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree, [entry]),
      target: firstTarget,
    });
    git(repository, ["worktree", "remove", "--force", firstTarget]);

    const secondTarget = join(tempDirs.make("lobster-deterministic-second-parent-"), "worktree");
    git(repository, ["config", "user.name", "Second Reconstructor"]);
    git(repository, ["config", "user.email", "second@example.test"]);
    const second = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree, [entry]),
      target: secondTarget,
    });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstResult = JSON.parse(first.stdout);
    const secondResult = JSON.parse(second.stdout);
    expect(secondResult.applied[0].appliedSha).toBe(firstResult.applied[0].appliedSha);
    expect(secondResult.resultCommit).toBe(firstResult.resultCommit);
    expect(secondResult.resultDigest).toBe(firstResult.resultDigest);
    git(repository, ["worktree", "remove", "--force", secondTarget]);
  });

  it("rejects dependency order and patch identity mismatches", () => {
    const { repository, baseCommit, baseTree, sourceSha } = createRepository();
    const dependencyTarget = join(tempDirs.make("lobster-dependency-parent-"), "worktree");
    const dependencyResult = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree, [
        {
          id: "child",
          state: "evidence-only",
          dependsOn: ["missing-parent"],
          sourceSha,
          patchId: "a".repeat(40),
          kind: "cherry-pick",
        },
      ]),
      target: dependencyTarget,
    });
    expect(dependencyResult.status).toBe(1);
    expect(dependencyResult.stderr).toContain("must appear earlier");

    const patchTarget = join(tempDirs.make("lobster-patch-parent-"), "worktree");
    const patchResult = runReconstruct({
      repository,
      manifestValue: manifest(baseCommit, baseTree, [
        {
          id: "bad-patch",
          state: "evidence-only",
          dependsOn: [],
          sourceSha,
          patchId: "a".repeat(40),
          kind: "cherry-pick",
        },
      ]),
      target: patchTarget,
    });
    expect(patchResult.status).toBe(1);
    expect(patchResult.stderr).toContain("Patch ID mismatch");
    expect(existsSync(patchTarget)).toBe(false);
  });
});
