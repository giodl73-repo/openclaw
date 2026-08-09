#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PATCH_ID_PATTERN = /^[0-9a-f]{40}$/u;
const ADMITTED_STATES = new Set(["build-only", "evidence-only", "release-eligible", "active"]);
const INVENTORY_STATES = new Set([
  "source-only",
  ...ADMITTED_STATES,
  "superseded",
  "rejected-not-applied",
]);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function fail(message) {
  throw new Error(message);
}

function git(cwd, args, options = {}) {
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.capture === false ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function parseArgs(argv) {
  const options = {
    manifest: resolve(ROOT, ".lobster/queue.json"),
    disposition: resolve(ROOT, ".lobster/disposition.json"),
    repository: ROOT,
    target: "",
    result: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      options.manifest = resolve(argv[++index] ?? fail("--manifest requires a path"));
    } else if (arg === "--disposition") {
      options.disposition = resolve(argv[++index] ?? fail("--disposition requires a path"));
    } else if (arg === "--repository") {
      options.repository = resolve(argv[++index] ?? fail("--repository requires a path"));
    } else if (arg === "--target") {
      options.target = resolve(argv[++index] ?? fail("--target requires a path"));
    } else if (arg === "--result") {
      options.result = resolve(argv[++index] ?? fail("--result requires a path"));
    } else if (arg !== "--") {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!options.target) {
    fail("--target is required");
  }
  return options;
}

function requireSha(value, label) {
  if (!SHA_PATTERN.test(value ?? "")) {
    fail(`${label} must be a full lowercase commit SHA`);
  }
}

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    fail("Queue manifest must use schemaVersion 1");
  }
  requireSha(manifest.base?.commit, "base.commit");
  requireSha(manifest.base?.tree, "base.tree");
  if (!Array.isArray(manifest.entries)) {
    fail("entries must be an array");
  }
  const seen = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `entries[${index}]`;
    if (!entry?.id || seen.has(entry.id)) {
      fail(`${label}.id must be unique and non-empty`);
    }
    seen.add(entry.id);
    if (!INVENTORY_STATES.has(entry.state)) {
      fail(`${label}.state is unsupported`);
    }
    if (!Array.isArray(entry.dependsOn)) {
      fail(`${label}.dependsOn must be an array`);
    }
    for (const dependency of entry.dependsOn) {
      if (!seen.has(dependency)) {
        fail(`${label} dependency ${dependency} must appear earlier in the queue`);
      }
    }
    if (!ADMITTED_STATES.has(entry.state)) {
      continue;
    }
    if (entry.kind === "noop") {
      if (entry.resolutions !== undefined) {
        fail(`${label}.resolutions is only supported for cherry-pick-range entries`);
      }
      continue;
    }
    if (entry.kind !== "cherry-pick" && entry.kind !== "cherry-pick-range") {
      fail(`${label}.kind must be cherry-pick, cherry-pick-range, or noop when admitted`);
    }
    requireSha(entry.sourceSha, `${label}.sourceSha`);
    if (!PATCH_ID_PATTERN.test(entry.patchId ?? "")) {
      fail(`${label}.patchId must be a stable patch ID`);
    }
    if (entry.kind === "cherry-pick-range") {
      requireSha(entry.sourceBaseSha, `${label}.sourceBaseSha`);
      if (!Number.isInteger(entry.sourceCommitCount) || entry.sourceCommitCount < 1) {
        fail(`${label}.sourceCommitCount must be a positive integer`);
      }
      if (entry.resolutions !== undefined && !Array.isArray(entry.resolutions)) {
        fail(`${label}.resolutions must be an array`);
      }
      const resolvedSources = new Set();
      for (const [resolutionIndex, resolution] of (entry.resolutions ?? []).entries()) {
        const resolutionLabel = `${label}.resolutions[${resolutionIndex}]`;
        requireSha(resolution.sourceSha, `${resolutionLabel}.sourceSha`);
        requireSha(resolution.carriedSha, `${resolutionLabel}.carriedSha`);
        requireSha(resolution.prefixTree, `${resolutionLabel}.prefixTree`);
        if (resolution.sourceSha === resolution.carriedSha) {
          fail(`${resolutionLabel}.carriedSha must differ from sourceSha`);
        }
        if (!PATCH_ID_PATTERN.test(resolution.patchId ?? "")) {
          fail(`${resolutionLabel}.patchId must be a stable patch ID`);
        }
        if (!resolution.dispositionId || typeof resolution.dispositionId !== "string") {
          fail(`${resolutionLabel}.dispositionId must be non-empty`);
        }
        if (resolution.classification !== "B3") {
          fail(`${resolutionLabel}.classification must be B3`);
        }
        if (resolvedSources.has(resolution.sourceSha)) {
          fail(`${resolutionLabel}.sourceSha must be unique within the range`);
        }
        resolvedSources.add(resolution.sourceSha);
      }
    } else if (entry.resolutions !== undefined) {
      fail(`${label}.resolutions is only supported for cherry-pick-range entries`);
    }
  }
  return manifest;
}

function resolutionLedgerForManifest(manifest, disposition) {
  if (!disposition || disposition.schemaVersion !== 1 || !Array.isArray(disposition.entries)) {
    fail("Disposition ledger must use schemaVersion 1 and expose an entries array");
  }
  const ledgerEntries = new Map();
  for (const entry of disposition.entries) {
    if (entry?.id) {
      ledgerEntries.set(entry.id, entry);
    }
  }
  const resolutions = new Map();
  for (const queueEntry of manifest.entries) {
    for (const resolution of queueEntry.resolutions ?? []) {
      const ledgerEntry = ledgerEntries.get(resolution.dispositionId);
      if (!ledgerEntry) {
        fail(`Resolution ${resolution.dispositionId} is missing from the disposition ledger`);
      }
      if (
        ledgerEntry.classification !== "B3" ||
        ledgerEntry.status !== queueEntry.state ||
        ledgerEntry.sourceSha !== resolution.carriedSha ||
        ledgerEntry.patchId !== resolution.patchId
      ) {
        fail(`Resolution ${resolution.dispositionId} does not match its B3 disposition entry`);
      }
      requireSha(ledgerEntry.baseCommit, `disposition ${resolution.dispositionId}.baseCommit`);
      resolutions.set(resolution.dispositionId, ledgerEntry);
    }
  }
  return resolutions;
}

function patchIdForPatch(repository, patch, label) {
  if (!patch) {
    fail(`${label} has no patch content`);
  }
  const result = spawnSync("git", ["patch-id", "--stable"], {
    cwd: repository,
    encoding: "utf8",
    input: patch,
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `Could not compute patch ID for ${label}`);
  }
  return result.stdout.trim().split(/\s+/u)[0];
}

export function patchIdForCommit(repository, sourceSha) {
  return patchIdForPatch(
    repository,
    git(repository, ["show", "--pretty=format:", "--binary", sourceSha]),
    `Source ${sourceSha}`,
  );
}

export function commitsForRange(repository, sourceBaseSha, sourceSha) {
  git(repository, ["rev-parse", "--verify", `${sourceBaseSha}^{commit}`]);
  git(repository, ["rev-parse", "--verify", `${sourceSha}^{commit}`]);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceBaseSha, sourceSha], {
    cwd: repository,
    encoding: "utf8",
  });
  if (ancestry.status !== 0) {
    fail(`Source base ${sourceBaseSha} is not an ancestor of ${sourceSha}`);
  }
  const mergeCommits = git(repository, ["rev-list", "--merges", `${sourceBaseSha}..${sourceSha}`]);
  if (mergeCommits) {
    fail(`Source range ${sourceBaseSha}..${sourceSha} contains merge commits`);
  }
  const commits = git(repository, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${sourceBaseSha}..${sourceSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) {
    fail(`Source range ${sourceBaseSha}..${sourceSha} is empty`);
  }
  return commits;
}

export function patchIdForRange(repository, sourceBaseSha, sourceSha) {
  return patchIdForPatch(
    repository,
    git(repository, ["diff", "--binary", sourceBaseSha, sourceSha]),
    `Source range ${sourceBaseSha}..${sourceSha}`,
  );
}

function singleParentForCommit(repository, sourceSha) {
  const parts = git(repository, ["rev-list", "--parents", "-n", "1", sourceSha]).split(/\s+/u);
  if (parts.length !== 2) {
    fail(`Carried resolution ${sourceSha} must have exactly one parent`);
  }
  return parts[1];
}

function committerEnvironmentForCommit(repository, sourceSha) {
  const metadata = git(repository, [
    "show",
    "--no-patch",
    "--format=%cn%x00%ce%x00%cI",
    sourceSha,
  ]).split("\0");
  const [name, email, date] = metadata;
  if (!name || !email || !date || metadata.length !== 3) {
    fail(`Could not read committer metadata for ${sourceSha}`);
  }
  return {
    ...process.env,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
}

export function reconstruct({ repository = ROOT, manifest, disposition, target, resultPath = "" }) {
  validateManifest(manifest);
  const resolutionLedger = resolutionLedgerForManifest(manifest, disposition);
  if (existsSync(target)) {
    fail(`Target already exists: ${target}`);
  }
  git(repository, ["rev-parse", "--verify", `${manifest.base.commit}^{commit}`]);
  const sourceTree = git(repository, ["rev-parse", `${manifest.base.commit}^{tree}`]);
  if (sourceTree !== manifest.base.tree) {
    fail(`Pinned base tree mismatch: expected ${manifest.base.tree}, received ${sourceTree}`);
  }

  let worktreeAdded = false;
  try {
    git(repository, ["worktree", "add", "--detach", target, manifest.base.commit]);
    worktreeAdded = true;
    const applied = [];
    for (const entry of manifest.entries) {
      if (!ADMITTED_STATES.has(entry.state)) {
        continue;
      }
      const beforeTree = git(target, ["rev-parse", "HEAD^{tree}"]);
      if (entry.kind === "noop") {
        applied.push({
          id: entry.id,
          kind: entry.kind,
          sourceSha: null,
          patchId: null,
          appliedSha: null,
          tree: beforeTree,
        });
        continue;
      }
      const sourceCommits =
        entry.kind === "cherry-pick-range"
          ? commitsForRange(repository, entry.sourceBaseSha, entry.sourceSha)
          : [entry.sourceSha];
      if (entry.kind === "cherry-pick-range" && sourceCommits.length !== entry.sourceCommitCount) {
        fail(
          `Source commit count mismatch for ${entry.id}: expected ${entry.sourceCommitCount}, received ${sourceCommits.length}`,
        );
      }
      const sourceCommitSet = new Set(sourceCommits);
      const resolutions = new Map();
      for (const resolution of entry.resolutions ?? []) {
        if (!sourceCommitSet.has(resolution.sourceSha)) {
          fail(
            `Resolution ${resolution.dispositionId} targets ${resolution.sourceSha} outside ${entry.id}`,
          );
        }
        resolutions.set(resolution.sourceSha, resolution);
      }
      const actualPatchId =
        entry.kind === "cherry-pick-range"
          ? patchIdForRange(repository, entry.sourceBaseSha, entry.sourceSha)
          : patchIdForCommit(repository, entry.sourceSha);
      if (actualPatchId !== entry.patchId) {
        fail(
          `Patch ID mismatch for ${entry.id}: expected ${entry.patchId}, received ${actualPatchId}`,
        );
      }
      const commits = [];
      for (const sourceSha of sourceCommits) {
        const sourcePatchId = patchIdForCommit(repository, sourceSha);
        const resolution = resolutions.get(sourceSha);
        const beforeCommitTree = git(target, ["rev-parse", "HEAD^{tree}"]);
        let appliedSourceSha = sourceSha;
        let appliedPatchId = sourcePatchId;
        if (resolution) {
          const dispositionEntry = resolutionLedger.get(resolution.dispositionId);
          const beforeCommit = git(target, ["rev-parse", "HEAD"]);
          if (beforeCommit !== dispositionEntry.baseCommit) {
            fail(
              `Resolution base mismatch for ${resolution.dispositionId}: expected ${dispositionEntry.baseCommit}, received ${beforeCommit}`,
            );
          }
          if (beforeCommitTree !== resolution.prefixTree) {
            fail(
              `Resolution prefix mismatch for ${resolution.dispositionId}: expected ${resolution.prefixTree}, received ${beforeCommitTree}`,
            );
          }
          const carriedParent = singleParentForCommit(repository, resolution.carriedSha);
          const carriedParentTree = git(repository, ["rev-parse", `${carriedParent}^{tree}`]);
          if (carriedParentTree !== resolution.prefixTree) {
            fail(
              `Resolution parent mismatch for ${resolution.dispositionId}: expected tree ${resolution.prefixTree}, received ${carriedParentTree}`,
            );
          }
          appliedPatchId = patchIdForCommit(repository, resolution.carriedSha);
          if (appliedPatchId !== resolution.patchId) {
            fail(
              `Resolution patch ID mismatch for ${resolution.dispositionId}: expected ${resolution.patchId}, received ${appliedPatchId}`,
            );
          }
          appliedSourceSha = resolution.carriedSha;
        }
        git(target, ["cherry-pick", "-x", appliedSourceSha], {
          env: committerEnvironmentForCommit(repository, appliedSourceSha),
        });
        commits.push({
          sourceSha,
          patchId: sourcePatchId,
          appliedSourceSha,
          appliedPatchId,
          dispositionId: resolution?.dispositionId ?? null,
          classification: resolution?.classification ?? null,
          prefixTree: resolution?.prefixTree ?? beforeCommitTree,
          appliedSha: git(target, ["rev-parse", "HEAD"]),
          tree: git(target, ["rev-parse", "HEAD^{tree}"]),
        });
      }
      applied.push({
        id: entry.id,
        kind: entry.kind,
        sourceBaseSha: entry.sourceBaseSha ?? null,
        sourceSha: entry.sourceSha,
        patchId: actualPatchId,
        appliedSha: git(target, ["rev-parse", "HEAD"]),
        tree: git(target, ["rev-parse", "HEAD^{tree}"]),
        commits,
      });
    }
    const result = {
      schemaVersion: 1,
      baseCommit: manifest.base.commit,
      baseTree: manifest.base.tree,
      manifestDigest: digest(manifest),
      dispositionDigest: digest(disposition),
      applied,
      resultCommit: git(target, ["rev-parse", "HEAD"]),
      resultTree: git(target, ["rev-parse", "HEAD^{tree}"]),
    };
    result.resultDigest = digest(result);
    if (resultPath) {
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } catch (error) {
    if (worktreeAdded) {
      spawnSync("git", ["-C", target, "cherry-pick", "--abort"], { stdio: "ignore" });
      spawnSync("git", ["worktree", "remove", "--force", target], {
        cwd: repository,
        stdio: "ignore",
      });
    } else {
      rmSync(target, { recursive: true, force: true });
    }
    throw error;
  }
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  const disposition = JSON.parse(readFileSync(options.disposition, "utf8"));
  const result = reconstruct({
    repository: options.repository,
    manifest,
    disposition,
    target: options.target,
    resultPath: options.result,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
