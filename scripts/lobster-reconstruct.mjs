#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
    input: options.input,
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
      .sort()
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
    repository: ROOT,
    target: "",
    result: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      options.manifest = resolve(argv[++index] ?? fail("--manifest requires a path"));
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
      continue;
    }
    if (entry.kind !== "cherry-pick") {
      fail(`${label}.kind must be cherry-pick or noop when admitted`);
    }
    requireSha(entry.sourceSha, `${label}.sourceSha`);
    if (!PATCH_ID_PATTERN.test(entry.patchId ?? "")) {
      fail(`${label}.patchId must be a stable patch ID`);
    }
  }
  return manifest;
}

export function patchIdForCommit(repository, sourceSha) {
  const patch = git(repository, ["show", "--pretty=format:", "--binary", sourceSha]);
  if (!patch) {
    fail(`Source ${sourceSha} has no patch content`);
  }
  const result = spawnSync("git", ["patch-id", "--stable"], {
    cwd: repository,
    encoding: "utf8",
    input: patch,
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `Could not compute patch ID for ${sourceSha}`);
  }
  return result.stdout.trim().split(/\s+/u)[0];
}

export function reconstruct({ repository = ROOT, manifest, target, resultPath = "" }) {
  validateManifest(manifest);
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
      const actualPatchId = patchIdForCommit(repository, entry.sourceSha);
      if (actualPatchId !== entry.patchId) {
        fail(`Patch ID mismatch for ${entry.id}: expected ${entry.patchId}, received ${actualPatchId}`);
      }
      git(target, ["cherry-pick", "-x", entry.sourceSha]);
      applied.push({
        id: entry.id,
        kind: entry.kind,
        sourceSha: entry.sourceSha,
        patchId: actualPatchId,
        appliedSha: git(target, ["rev-parse", "HEAD"]),
        tree: git(target, ["rev-parse", "HEAD^{tree}"]),
      });
    }
    const result = {
      schemaVersion: 1,
      baseCommit: manifest.base.commit,
      baseTree: manifest.base.tree,
      manifestDigest: digest(manifest),
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
  const result = reconstruct({
    repository: options.repository,
    manifest,
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
