import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInstallProjectPackageJson,
  normalizeInstalledInventory,
  parseArgs,
  validatePreparedInstall,
} from "../../scripts/generate-npm-install-release-evidence.mts";
import { verifyNpmInstallReleaseEvidence } from "../../scripts/verify-npm-install-release-evidence.mjs";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("generate-npm-install-release-evidence", () => {
  it("parses coordinated prepared tarballs", () => {
    expect(
      parseArgs([
        "--root-tarball",
        "openclaw.tgz",
        "--dependency-tarball",
        "@openclaw/ai=ai.tgz",
        "--dependency-tarball",
        "@openclaw/gateway-protocol=protocol.tgz",
        "--package-version",
        "2026.8.14",
        "--output-dir",
        "evidence",
      ]),
    ).toMatchObject({
      rootTarball: "openclaw.tgz",
      dependencyTarballs: ["@openclaw/ai=ai.tgz", "@openclaw/gateway-protocol=protocol.tgz"],
      packageVersion: "2026.8.14",
      outputDir: "evidence",
    });
  });

  it("creates a stable local-tarball install project", () => {
    expect(
      createInstallProjectPackageJson([
        {
          packageName: "@openclaw/ai",
          packageVersion: "2026.8.14",
          sourcePath: "/tmp/ai.tgz",
          tarballName: "ai.tgz",
          tarballSha256: "a".repeat(64),
        },
        {
          packageName: "openclaw",
          packageVersion: "2026.8.14",
          sourcePath: "/tmp/openclaw.tgz",
          tarballName: "openclaw.tgz",
          tarballSha256: "b".repeat(64),
        },
      ]),
    ).toEqual({
      name: "openclaw-release-install-evidence",
      version: "0.0.0",
      private: true,
      dependencies: {
        "@openclaw/ai": "file:tarballs/ai.tgz",
        openclaw: "file:tarballs/openclaw.tgz",
      },
    });
  });

  it("normalizes only the installed production graph", () => {
    expect(
      normalizeInstalledInventory({
        packages: {
          "": {},
          "node_modules/openclaw": {
            version: "2026.8.14",
            resolved: "file:tarballs/openclaw.tgz",
          },
          "node_modules/openclaw/node_modules/@scope/runtime": {
            version: "1.2.3",
            integrity: "sha512-runtime",
            optional: true,
          },
        },
      }),
    ).toEqual([
      {
        path: "node_modules/openclaw",
        name: "openclaw",
        version: "2026.8.14",
        resolved: "file:tarballs/openclaw.tgz",
        optional: false,
        devOptional: false,
        hasInstallScript: false,
      },
      {
        path: "node_modules/openclaw/node_modules/@scope/runtime",
        name: "@scope/runtime",
        version: "1.2.3",
        integrity: "sha512-runtime",
        optional: true,
        devOptional: false,
        hasInstallScript: false,
      },
    ]);
    expect(() =>
      normalizeInstalledInventory({
        packages: {
          "node_modules/test-only": { name: "test-only", version: "1.0.0", dev: true },
        },
      }),
    ).toThrow("unexpectedly contains dev package");
  });

  it("rejects coordinated tarballs resolved from the registry", () => {
    expect(() =>
      validatePreparedInstall({
        installedLock: {
          packages: {
            "node_modules/@openclaw/ai": {
              version: "2026.8.14",
              resolved: "https://registry.npmjs.org/@openclaw/ai/-/ai-2026.8.14.tgz",
            },
          },
        },
        preparedTarballs: [
          {
            packageName: "@openclaw/ai",
            packageVersion: "2026.8.14",
            sourcePath: "/tmp/ai.tgz",
            tarballName: "ai.tgz",
            tarballSha256: "a".repeat(64),
          },
        ],
      }),
    ).toThrow("instead of file:tarballs/ai.tgz");
  });

  it("verifies a complete hash-addressed preflight evidence bundle", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "openclaw-npm-install-evidence-test-"));
    try {
      const artifactDir = path.join(home, "artifact");
      const evidenceDir = path.join(artifactDir, "dependency-evidence", "npm-install");
      await mkdir(evidenceDir, { recursive: true });
      const rootTarball = "root-tarball\n";
      const rootTarballSha256 = sha256(rootTarball);
      await writeFile(path.join(artifactDir, "openclaw-2026.8.14.tgz"), rootTarball, "utf8");
      const files = {
        "package-lock.json": '{"lockfileVersion":3}\n',
        "installed-package-lock.json": '{"lockfileVersion":3}\n',
        "dependencies.json": '[{"name":"openclaw","version":"2026.8.14"}]\n',
      };
      for (const [name, content] of Object.entries(files)) {
        await writeFile(path.join(evidenceDir, name), content, "utf8");
      }
      const descriptor = {
        schemaVersion: 1,
        package: { name: "openclaw", version: "2026.8.14" },
        resolution: {
          platform: "linux",
          arch: "x64",
          libc: "glibc-2.39",
          nodeVersion: "v24.16.0",
          npmVersion: "11.6.2",
          scriptsRun: false,
        },
        preparedTarballs: [
          {
            packageName: "openclaw",
            packageVersion: "2026.8.14",
            tarballName: "openclaw-2026.8.14.tgz",
            tarballSha256: rootTarballSha256,
          },
        ],
        packageCount: 1,
        files: {
          installLock: {
            path: "package-lock.json",
            sha256: sha256(files["package-lock.json"]),
          },
          installedLock: {
            path: "installed-package-lock.json",
            sha256: sha256(files["installed-package-lock.json"]),
          },
          inventory: {
            path: "dependencies.json",
            sha256: sha256(files["dependencies.json"]),
          },
        },
      };
      const descriptorContent = `${JSON.stringify(descriptor, null, 2)}\n`;
      await writeFile(
        path.join(evidenceDir, "npm-install-evidence.json"),
        descriptorContent,
        "utf8",
      );
      const dependencyManifest = '{"schemaVersion":1}\n';
      await writeFile(
        path.join(artifactDir, "dependency-evidence", "dependency-evidence-manifest.json"),
        dependencyManifest,
        "utf8",
      );
      const manifest = {
        version: 2,
        packageName: "openclaw",
        packageVersion: "2026.8.14",
        tarballName: "openclaw-2026.8.14.tgz",
        tarballSha256: rootTarballSha256,
        corePackageTarballs: [],
        dependencyEvidenceManifest: "dependency-evidence/dependency-evidence-manifest.json",
        dependencyEvidenceManifestSha256: sha256(dependencyManifest),
        npmInstallEvidence: {
          path: "dependency-evidence/npm-install/npm-install-evidence.json",
          sha256: sha256(descriptorContent),
          packageCount: 1,
        },
      };
      await writeFile(
        path.join(artifactDir, "preflight-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      await expect(verifyNpmInstallReleaseEvidence({ artifactDir })).resolves.toMatchObject({
        status: "verified",
        packageCount: 1,
        platform: "linux",
      });

      await writeFile(path.join(evidenceDir, "dependencies.json"), "[]\n", "utf8");
      await expect(verifyNpmInstallReleaseEvidence({ artifactDir })).rejects.toThrow(
        "inventory digest mismatch",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("allows legacy preflight manifests but fails version 2 without evidence", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "openclaw-npm-install-evidence-test-"));
    try {
      const artifactDir = home;
      const manifestPath = path.join(artifactDir, "preflight-manifest.json");
      await writeFile(manifestPath, '{"version":1}\n', "utf8");
      await expect(verifyNpmInstallReleaseEvidence({ artifactDir })).resolves.toEqual({
        status: "legacy",
        preflightVersion: 1,
      });
      await writeFile(manifestPath, '{"version":2}\n', "utf8");
      await expect(verifyNpmInstallReleaseEvidence({ artifactDir })).rejects.toThrow(
        "requires npmInstallEvidence",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
