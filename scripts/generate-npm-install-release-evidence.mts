#!/usr/bin/env node

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseFlagArgs, stringFlag, stringListFlag } from "./lib/arg-utils.mts";
import { resolveNpmRunner } from "./npm-runner.mts";

type UnknownRecord = Record<string, unknown>;
type PreparedTarball = {
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  tarballName: string;
  tarballSha256: string;
};
type InstallPackage = {
  dev?: boolean;
  devOptional?: boolean;
  hasInstallScript?: boolean;
  integrity?: string;
  license?: string;
  name?: string;
  optional?: boolean;
  resolved?: string;
  version?: string;
};
type InstallLock = {
  lockfileVersion?: number;
  packages?: Record<string, InstallPackage>;
};
type InventoryEntry = {
  devOptional: boolean;
  hasInstallScript: boolean;
  integrity?: string;
  license?: string;
  name: string;
  optional: boolean;
  path: string;
  resolved?: string;
  version: string;
};
type CliOptions = {
  dependencyTarballs: string[];
  help?: true;
  outputDir: string | null;
  packageName: string;
  packageVersion: string | null;
  rootTarball: string | null;
};
type NpmExecOptions = ExecFileSyncOptions & {
  windowsVerbatimArguments?: boolean;
};

const INSTALL_ARGS = [
  "install",
  "--ignore-scripts",
  "--omit=dev",
  "--no-audit",
  "--no-fund",
  "--package-lock=true",
];

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject<T extends UnknownRecord>(filePath: string): Promise<T> {
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isRecord(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return value as T;
}

async function sha256File(filePath: string) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function safeTarballName(filePath: string) {
  const name = path.basename(filePath);
  if (!name.endsWith(".tgz") || name !== path.win32.basename(name) || name.includes("\0")) {
    throw new Error(`Unsafe prepared tarball name: ${JSON.stringify(name)}.`);
  }
  return name;
}

function parseDependencyTarball(value: string) {
  const separator = value.indexOf("=");
  const packageName = value.slice(0, separator).trim();
  const sourcePath = value.slice(separator + 1).trim();
  if (separator <= 0 || !packageName || !sourcePath) {
    throw new Error(`Expected --dependency-tarball <package=path>, got ${JSON.stringify(value)}.`);
  }
  return { packageName, sourcePath };
}

function packageNameFromLockPath(lockPath: string, entry: InstallPackage) {
  if (typeof entry.name === "string" && entry.name.length > 0) {
    return entry.name;
  }
  const normalized = lockPath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const packagePath = normalized.slice(normalized.lastIndexOf(marker) + marker.length);
  const segments = packagePath.split("/");
  if (segments[0]?.startsWith("@") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? "";
}

export function normalizeInstalledInventory(lock: InstallLock) {
  if (!isRecord(lock.packages)) {
    throw new Error("Installed npm lock is missing its packages map.");
  }
  const inventory = Object.entries(lock.packages)
    .filter(([lockPath]) => lockPath !== "")
    .map(([lockPath, entry]) => {
      if (!isRecord(entry)) {
        throw new Error(`Installed npm lock entry ${lockPath} must be an object.`);
      }
      const name = packageNameFromLockPath(lockPath, entry);
      if (!name || typeof entry.version !== "string" || entry.version.length === 0) {
        throw new Error(`Installed npm lock entry ${lockPath} is missing package identity.`);
      }
      if (entry.dev === true) {
        throw new Error(`Installed npm evidence unexpectedly contains dev package ${name}.`);
      }
      const normalized: InventoryEntry = {
        path: lockPath.replaceAll("\\", "/"),
        name,
        version: entry.version,
        optional: entry.optional === true,
        devOptional: entry.devOptional === true,
        hasInstallScript: entry.hasInstallScript === true,
      };
      if (typeof entry.integrity === "string") {
        normalized.integrity = entry.integrity;
      }
      if (typeof entry.resolved === "string") {
        normalized.resolved = entry.resolved;
      }
      if (typeof entry.license === "string") {
        normalized.license = entry.license;
      }
      return normalized;
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
  if (inventory.length === 0) {
    throw new Error("Installed npm evidence contains no packages.");
  }
  return inventory;
}

export function detectLibc() {
  if (process.platform !== "linux") {
    return "not-applicable";
  }
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime
    ? `glibc-${report.header.glibcVersionRuntime}`
    : "musl-or-unknown";
}

export function createInstallProjectPackageJson(preparedTarballs: PreparedTarball[]) {
  return {
    name: "openclaw-release-install-evidence",
    version: "0.0.0",
    private: true,
    dependencies: Object.fromEntries(
      preparedTarballs.map((entry) => [entry.packageName, `file:tarballs/${entry.tarballName}`]),
    ),
  };
}

export function validatePreparedInstall({
  installedLock,
  preparedTarballs,
}: {
  installedLock: InstallLock;
  preparedTarballs: PreparedTarball[];
}) {
  if (!isRecord(installedLock.packages)) {
    throw new Error("Installed npm lock is missing its packages map.");
  }
  for (const tarball of preparedTarballs) {
    const lockPath = `node_modules/${tarball.packageName}`;
    const entry = installedLock.packages[lockPath];
    if (!isRecord(entry)) {
      throw new Error(
        `Prepared package ${tarball.packageName} is absent from the installed graph.`,
      );
    }
    if (entry.version !== tarball.packageVersion) {
      throw new Error(
        `Prepared package ${tarball.packageName} resolved ${entry.version ?? "<missing>"} instead of ${tarball.packageVersion}.`,
      );
    }
    const expectedResolved = `file:tarballs/${tarball.tarballName}`;
    if (entry.resolved !== expectedResolved) {
      throw new Error(
        `Prepared package ${tarball.packageName} resolved from ${entry.resolved ?? "<missing>"} instead of ${expectedResolved}.`,
      );
    }
  }
}

async function prepareTarballs({
  rootTarball,
  dependencyTarballs,
  packageName,
  packageVersion,
  workDir,
}: {
  rootTarball: string;
  dependencyTarballs: string[];
  packageName: string;
  packageVersion: string;
  workDir: string;
}) {
  const sourceEntries = [
    { packageName, sourcePath: rootTarball },
    ...dependencyTarballs.map(parseDependencyTarball),
  ];
  const names = sourceEntries.map((entry) => entry.packageName);
  if (new Set(names).size !== names.length) {
    throw new Error("Prepared tarball package names must be unique.");
  }
  const tarballDir = path.join(workDir, "tarballs");
  await mkdir(tarballDir, { recursive: true });
  const prepared = await Promise.all(
    sourceEntries.map(async (entry) => {
      const sourcePath = path.resolve(entry.sourcePath);
      const tarballName = safeTarballName(sourcePath);
      const preparedPath = path.join(tarballDir, tarballName);
      await copyFile(sourcePath, preparedPath);
      return {
        packageName: entry.packageName,
        packageVersion,
        sourcePath,
        tarballName,
        tarballSha256: await sha256File(preparedPath),
      };
    }),
  );
  const tarballNames = prepared.map((entry) => entry.tarballName);
  if (new Set(tarballNames).size !== tarballNames.length) {
    throw new Error("Prepared tarball file names must be unique.");
  }
  return prepared.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

async function npmVersion() {
  const runner = resolveNpmRunner({ npmArgs: ["--version"] });
  const options: NpmExecOptions = {
    encoding: "utf8",
    env: runner.env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  };
  return String(execFileSync(runner.command, runner.args, options)).trim();
}

async function runNpmInstall(workDir: string) {
  const runner = resolveNpmRunner({ npmArgs: INSTALL_ARGS });
  const options: NpmExecOptions = {
    cwd: workDir,
    env: runner.env,
    shell: runner.shell,
    stdio: "inherit",
    timeout: 15 * 60 * 1000,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  };
  execFileSync(runner.command, runner.args, options);
}

export async function generateNpmInstallReleaseEvidence({
  rootTarball,
  dependencyTarballs = [],
  outputDir,
  packageName = "openclaw",
  packageVersion,
  generatedAt = new Date().toISOString(),
}: {
  rootTarball: string;
  dependencyTarballs?: string[];
  outputDir: string;
  packageName?: string;
  packageVersion: string;
  generatedAt?: string;
}) {
  const workDir = await mkdtemp(path.join(tmpdir(), "openclaw-npm-install-evidence-"));
  try {
    const preparedTarballs = await prepareTarballs({
      rootTarball,
      dependencyTarballs,
      packageName,
      packageVersion,
      workDir,
    });
    await writeFile(
      path.join(workDir, "package.json"),
      `${JSON.stringify(createInstallProjectPackageJson(preparedTarballs), null, 2)}\n`,
      "utf8",
    );
    await runNpmInstall(workDir);

    const installLockPath = path.join(workDir, "package-lock.json");
    const installedLockPath = path.join(workDir, "node_modules", ".package-lock.json");
    await readJsonObject<InstallLock>(installLockPath);
    const installedLock = await readJsonObject<InstallLock>(installedLockPath);
    validatePreparedInstall({ installedLock, preparedTarballs });
    const inventory = normalizeInstalledInventory(installedLock);

    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    const outputInstallLock = path.join(outputDir, "package-lock.json");
    const outputInstalledLock = path.join(outputDir, "installed-package-lock.json");
    const outputInventory = path.join(outputDir, "dependencies.json");
    await copyFile(installLockPath, outputInstallLock);
    await copyFile(installedLockPath, outputInstalledLock);
    await writeFile(outputInventory, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

    const descriptor = {
      schemaVersion: 1,
      generatedAt,
      package: {
        name: packageName,
        version: packageVersion,
      },
      resolution: {
        platform: process.platform,
        arch: process.arch,
        libc: detectLibc(),
        nodeVersion: process.version,
        npmVersion: await npmVersion(),
        runnerImage: process.env.ImageOS || null,
        runnerImageVersion: process.env.ImageVersion || null,
        scriptsRun: false,
        omittedDependencyTypes: ["dev"],
        installArgs: INSTALL_ARGS,
      },
      preparedTarballs: preparedTarballs.map(
        ({ packageName: name, packageVersion: version, tarballName, tarballSha256 }) => ({
          packageName: name,
          packageVersion: version,
          tarballName,
          tarballSha256,
        }),
      ),
      packageCount: inventory.length,
      files: {
        installLock: {
          path: "package-lock.json",
          sha256: await sha256File(outputInstallLock),
        },
        installedLock: {
          path: "installed-package-lock.json",
          sha256: await sha256File(outputInstalledLock),
        },
        inventory: {
          path: "dependencies.json",
          sha256: await sha256File(outputInventory),
        },
      },
    };
    const descriptorPath = path.join(outputDir, "npm-install-evidence.json");
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    return {
      descriptor,
      descriptorPath,
      descriptorSha256: await sha256File(descriptorPath),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function usage() {
  return `Usage: node --import tsx scripts/generate-npm-install-release-evidence.mts --root-tarball <path> --package-version <version> --output-dir <dir> [options]

Options:
  --package-name <name>                Root package name (default: openclaw)
  --dependency-tarball <package=path>  Coordinated prepared tarball; repeatable
  -h, --help                           Show this help
`;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    rootTarball: null,
    dependencyTarballs: [],
    outputDir: null,
    packageName: "openclaw",
    packageVersion: null,
  };
  const helpIndex = argv.findIndex((arg) => arg === "-h" || arg === "--help");
  const parsed = parseFlagArgs(
    helpIndex === -1 ? argv : argv.slice(0, helpIndex),
    options,
    [
      stringFlag("--root-tarball", "rootTarball", {
        allowInline: false,
        rejectShortOptions: true,
        missingValueMessage: "Expected --root-tarball <path>.",
      }),
      stringListFlag("--dependency-tarball", "dependencyTarballs", {
        allowInline: false,
        rejectShortOptions: true,
        missingValueMessage: "Expected --dependency-tarball <package=path>.",
      }),
      stringFlag("--output-dir", "outputDir", {
        allowInline: false,
        rejectShortOptions: true,
        missingValueMessage: "Expected --output-dir <dir>.",
      }),
      stringFlag("--package-name", "packageName", {
        allowInline: false,
        rejectShortOptions: true,
        missingValueMessage: "Expected --package-name <name>.",
      }),
      stringFlag("--package-version", "packageVersion", {
        allowInline: false,
        rejectShortOptions: true,
        missingValueMessage: "Expected --package-version <version>.",
      }),
    ],
    {
      duplicateOptionMessage: (flag) => `${flag} was provided more than once.`,
      onUnhandledArg(arg) {
        throw new Error(`Unsupported argument: ${arg}`);
      },
    },
  );
  return helpIndex === -1 ? parsed : { ...parsed, help: true };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.rootTarball) {
    throw new Error("Expected --root-tarball <path>.");
  }
  if (!options.outputDir) {
    throw new Error("Expected --output-dir <dir>.");
  }
  if (!options.packageVersion) {
    throw new Error("Expected --package-version <version>.");
  }
  const result = await generateNpmInstallReleaseEvidence({
    rootTarball: options.rootTarball,
    dependencyTarballs: options.dependencyTarballs,
    outputDir: options.outputDir,
    packageName: options.packageName,
    packageVersion: options.packageVersion,
  });
  process.stdout.write(
    `${JSON.stringify({
      descriptorPath: result.descriptorPath,
      descriptorSha256: result.descriptorSha256,
      packageCount: result.descriptor.packageCount,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
