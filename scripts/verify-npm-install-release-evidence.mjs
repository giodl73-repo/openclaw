#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

async function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function resolveArtifactPath(artifactDir, relativePath, label) {
  const value = requireString(relativePath, label);
  if (path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be a safe artifact-relative path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe artifact-relative path.`);
  }
  const root = path.resolve(artifactDir);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the preflight artifact.`);
  }
  return resolved;
}

function normalizeTarballSet(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const entries = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    return {
      packageName: requireString(entry.packageName, `${label}[${index}].packageName`),
      packageVersion: requireString(entry.packageVersion, `${label}[${index}].packageVersion`),
      tarballName: requireString(entry.tarballName, `${label}[${index}].tarballName`),
      tarballSha256: requireString(entry.tarballSha256, `${label}[${index}].tarballSha256`),
    };
  });
  const keys = entries.map((entry) => entry.packageName);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label} contains duplicate package names.`);
  }
  return entries.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

function expectedPreparedTarballs(preflightManifest) {
  const root = {
    packageName: requireString(preflightManifest.packageName, "preflight packageName"),
    packageVersion: requireString(preflightManifest.packageVersion, "preflight packageVersion"),
    tarballName: requireString(preflightManifest.tarballName, "preflight tarballName"),
    tarballSha256: requireString(preflightManifest.tarballSha256, "preflight tarballSha256"),
  };
  return normalizeTarballSet(
    [
      root,
      ...(Array.isArray(preflightManifest.corePackageTarballs)
        ? preflightManifest.corePackageTarballs
        : []),
    ],
    "preflight prepared tarballs",
  );
}

async function verifyReferencedFile({
  artifactDir,
  descriptorDir,
  reference,
  label,
  pathScope = "descriptor",
}) {
  if (!isRecord(reference)) {
    throw new Error(`${label} must be an object.`);
  }
  const relativePath = requireString(reference.path, `${label}.path`);
  const sha256 = requireString(reference.sha256, `${label}.sha256`);
  const root = pathScope === "artifact" ? artifactDir : descriptorDir;
  const filePath = resolveArtifactPath(root, relativePath, `${label}.path`);
  const actual = await sha256File(filePath);
  if (actual !== sha256) {
    throw new Error(`${label} digest mismatch: expected ${sha256}, got ${actual}.`);
  }
  return filePath;
}

export async function verifyNpmInstallReleaseEvidence({ artifactDir, manifestPath }) {
  const resolvedArtifactDir = path.resolve(artifactDir);
  const resolvedManifestPath = manifestPath
    ? path.resolve(manifestPath)
    : path.join(resolvedArtifactDir, "preflight-manifest.json");
  const preflightManifest = await readJson(resolvedManifestPath, "preflight manifest");
  const preflightVersion = requireInteger(preflightManifest.version, "preflight manifest version");
  const evidenceReference = preflightManifest.npmInstallEvidence;
  if (evidenceReference === undefined) {
    if (preflightVersion < 2) {
      return { status: "legacy", preflightVersion };
    }
    throw new Error("Preflight manifest version 2 requires npmInstallEvidence.");
  }
  if (!isRecord(evidenceReference)) {
    throw new Error("preflight npmInstallEvidence must be an object.");
  }

  const descriptorPath = await verifyReferencedFile({
    artifactDir: resolvedArtifactDir,
    descriptorDir: resolvedArtifactDir,
    reference: evidenceReference,
    label: "preflight npmInstallEvidence",
    pathScope: "artifact",
  });
  const descriptor = await readJson(descriptorPath, "npm install evidence descriptor");
  if (descriptor.schemaVersion !== 1) {
    throw new Error(`Unsupported npm install evidence schemaVersion: ${descriptor.schemaVersion}.`);
  }
  if (!isRecord(descriptor.package)) {
    throw new Error("npm install evidence package must be an object.");
  }
  const packageName = requireString(descriptor.package.name, "npm install evidence package.name");
  const packageVersion = requireString(
    descriptor.package.version,
    "npm install evidence package.version",
  );
  if (
    packageName !== preflightManifest.packageName ||
    packageVersion !== preflightManifest.packageVersion
  ) {
    throw new Error("npm install evidence package identity does not match the preflight package.");
  }

  if (!isRecord(descriptor.resolution)) {
    throw new Error("npm install evidence resolution must be an object.");
  }
  requireString(descriptor.resolution.platform, "npm install evidence resolution.platform");
  requireString(descriptor.resolution.arch, "npm install evidence resolution.arch");
  requireString(descriptor.resolution.libc, "npm install evidence resolution.libc");
  requireString(descriptor.resolution.nodeVersion, "npm install evidence resolution.nodeVersion");
  requireString(descriptor.resolution.npmVersion, "npm install evidence resolution.npmVersion");
  if (descriptor.resolution.scriptsRun !== false) {
    throw new Error("npm install evidence must record scriptsRun=false.");
  }

  const expectedTarballs = expectedPreparedTarballs(preflightManifest);
  const actualTarballs = normalizeTarballSet(
    descriptor.preparedTarballs,
    "npm install evidence preparedTarballs",
  );
  if (JSON.stringify(actualTarballs) !== JSON.stringify(expectedTarballs)) {
    throw new Error("npm install evidence prepared tarballs do not match the preflight manifest.");
  }
  for (const tarball of expectedTarballs) {
    if (
      tarball.tarballName !== path.basename(tarball.tarballName) ||
      tarball.tarballName !== path.win32.basename(tarball.tarballName) ||
      !tarball.tarballName.endsWith(".tgz")
    ) {
      throw new Error(`Prepared tarball name is unsafe: ${tarball.tarballName}.`);
    }
    const tarballPath = resolveArtifactPath(
      resolvedArtifactDir,
      tarball.tarballName,
      `prepared tarball ${tarball.packageName}`,
    );
    const actualSha256 = await sha256File(tarballPath);
    if (actualSha256 !== tarball.tarballSha256) {
      throw new Error(`Prepared tarball ${tarball.packageName} digest mismatch.`);
    }
  }

  const descriptorDir = path.dirname(descriptorPath);
  if (!isRecord(descriptor.files)) {
    throw new Error("npm install evidence files must be an object.");
  }
  await verifyReferencedFile({
    artifactDir: resolvedArtifactDir,
    descriptorDir,
    reference: descriptor.files.installLock,
    label: "npm install evidence installLock",
  });
  await verifyReferencedFile({
    artifactDir: resolvedArtifactDir,
    descriptorDir,
    reference: descriptor.files.installedLock,
    label: "npm install evidence installedLock",
  });
  const inventoryPath = await verifyReferencedFile({
    artifactDir: resolvedArtifactDir,
    descriptorDir,
    reference: descriptor.files.inventory,
    label: "npm install evidence inventory",
  });
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (!Array.isArray(inventory)) {
    throw new Error("npm install evidence inventory must contain a JSON array.");
  }
  const packageCount = requireInteger(descriptor.packageCount, "npm install evidence packageCount");
  if (inventory.length !== packageCount) {
    throw new Error(
      `npm install evidence package count mismatch: expected ${packageCount}, got ${inventory.length}.`,
    );
  }
  if (evidenceReference.packageCount !== packageCount) {
    throw new Error("preflight npmInstallEvidence packageCount does not match its descriptor.");
  }

  const dependencyManifestReference = preflightManifest.dependencyEvidenceManifest;
  const dependencyManifestSha256 = preflightManifest.dependencyEvidenceManifestSha256;
  if (preflightVersion >= 2) {
    const dependencyManifestPath = resolveArtifactPath(
      resolvedArtifactDir,
      dependencyManifestReference,
      "dependencyEvidenceManifest",
    );
    const actual = await sha256File(dependencyManifestPath);
    if (actual !== dependencyManifestSha256) {
      throw new Error("Dependency evidence manifest digest mismatch.");
    }
  }

  return {
    status: "verified",
    packageCount,
    platform: descriptor.resolution.platform,
    arch: descriptor.resolution.arch,
    libc: descriptor.resolution.libc,
  };
}

function usage() {
  return `Usage: node scripts/verify-npm-install-release-evidence.mjs --artifact-dir <dir> [--manifest <path>]
`;
}

function parseArgs(argv) {
  const options = { artifactDir: "", manifestPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      return { help: true };
    }
    const value = argv[index + 1];
    if ((arg === "--artifact-dir" || arg === "--manifest") && (!value || value.startsWith("-"))) {
      throw new Error(`Expected ${arg} <value>.`);
    }
    if (arg === "--artifact-dir") {
      options.artifactDir = value;
      index += 1;
    } else if (arg === "--manifest") {
      options.manifestPath = value;
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!options.artifactDir) {
    throw new Error("Expected --artifact-dir <dir>.");
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await verifyNpmInstallReleaseEvidence(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
