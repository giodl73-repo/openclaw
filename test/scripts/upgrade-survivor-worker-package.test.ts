import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellBaselinePackage,
  readWorkerCellPackageIdentity,
  resolveWorkerCellBaselinePackage,
} from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function packageFixture(version = "2026.9.4", commit = "a".repeat(40)) {
  const root = path.join(tempDirs.make("worker-package-identity-"), "package");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n");
  fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ version, commit }));
  fs.writeFileSync(path.join(root, "dist/entry.mjs"), "export const answer = 1;\n");
  fs.symlinkSync("entry.mjs", path.join(root, "dist/alias.mjs"));
  return root;
}

describe("worker survivor installed payload identity", () => {
  it.each(["changed", "extra", "missing", "symlink"])(
    "rejects a %s dist entry even when package version and build commit agree",
    (mutation) => {
      const root = packageFixture();
      const expected = readWorkerCellPackageIdentity(root);
      if (mutation === "changed") {
        fs.writeFileSync(path.join(root, "dist/entry.mjs"), "export const answer = 2;\n");
      } else if (mutation === "extra") {
        fs.writeFileSync(path.join(root, "dist/stale.mjs"), "export {};\n");
      } else if (mutation === "missing") {
        fs.unlinkSync(path.join(root, "dist/entry.mjs"));
      } else {
        fs.unlinkSync(path.join(root, "dist/alias.mjs"));
        fs.symlinkSync("build-info.json", path.join(root, "dist/alias.mjs"));
      }
      expect(() =>
        assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), expected),
      ).toThrow("Installed application payload differs");
    },
  );

  it("compares application bytes while npm reifies its installed dependency tree", () => {
    const root = packageFixture();
    const expected = readWorkerCellPackageIdentity(root);
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), "{}");
    expect(() =>
      assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), expected),
    ).not.toThrow();
  });
});

describe("worker survivor published baseline selection", () => {
  it("pins stable 9.9 only for legacy operator state", () => {
    expect(resolveWorkerCellBaselinePackage("legacy-operator-state", "2026.9.9")).toEqual({
      version: "2026.9.9",
      commit: "bcfc88812a35243893585dbeca87ca41b48272ca",
      url: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.9.tgz",
      integrity:
        "sha512-3sB6ejq5smBozfBhVEDfK48wFpbkx+0f6PJ19qZjC3ab3RoFrYO58CnE2mAsbUy8sXdxdBtjQ3vkAqcW9BZXAw==",
    });
    for (const scenario of [undefined, "projects-doctor", "cron-owner-doctor"]) {
      expect(resolveWorkerCellBaselinePackage(scenario, "2026.9.9").version).toBe("2026.9.4");
    }
  });

  it("preserves the 9.4 pin and scenario-scoped 9.7 exception", () => {
    expect(resolveWorkerCellBaselinePackage("legacy-operator-state", "2026.9.4")).toEqual({
      version: "2026.9.4",
      commit: "3a9d69db306cd7f081e06254cb89c4bcc14a7107",
      url: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.4.tgz",
      integrity:
        "sha512-lTQpEEe1Xm3u2PCHaPEr+vP8paGk1vLdHuzdItsNToaLI6hAqRVvgJYg+GxukJhETJp4tPy/S1Gftl4KuB8n7A==",
    });
    expect(resolveWorkerCellBaselinePackage("cron-owner-doctor", "2026.9.7")).toEqual({
      version: "2026.9.7",
      url: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.7.tgz",
      integrity:
        "sha512-/8N2LnfTFQPvnZizi8qKSFfnLQaPvSG3Cb4xo1YV7b4JhYiUc43ZNRpXJ01bWghLK0Ezk3HVeo/DGHcIRQwRWA==",
    });
    expect(resolveWorkerCellBaselinePackage("legacy-operator-state", "2026.9.7").version).toBe(
      "2026.9.4",
    );
  });
});

function baselineFixture() {
  const version = "2026.9.9";
  const commit = "bcfc88812a35243893585dbeca87ca41b48272ca";
  const packageRoot = packageFixture(version, commit);
  const root = path.dirname(packageRoot);
  const runtimeRoot = path.join(root, "runtime");
  const tarball = path.join(root, "pre-acquired.tgz");
  fs.mkdirSync(runtimeRoot);
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  // Synthetic integrity belongs only to this helper fixture. The CLI keeps the published pin.
  const published = {
    ...resolveWorkerCellBaselinePackage("legacy-operator-state", version),
    integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`,
  };
  return { packageRoot, runtimeRoot, tarball, published };
}

describe.skipIf(process.platform === "win32")("worker survivor offline baseline identity", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected baseline fetch"));
  });
  afterEach(() => {
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("verifies a pre-acquired archive and installed payload without fetching or copying it", async () => {
    const fixture = baselineFixture();
    const bytes = fs.readFileSync(fixture.tarball);
    const expected = readWorkerCellPackageIdentity(fixture.packageRoot);
    const actual = await readWorkerCellBaselinePackage(fixture);
    expect(actual).toEqual({
      ...expected,
      integrity: fixture.published.integrity,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(fs.readFileSync(fixture.tarball)).toEqual(bytes);
    expect(fs.readdirSync(fixture.runtimeRoot)).toEqual([]);
  });

  it.each(["corrupt", "missing", "empty-path", "version", "commit", "payload"] as const)(
    "rejects %s without network fallback",
    async (change) => {
      const fixture = baselineFixture();
      let error: string;
      if (change === "corrupt") {
        fs.writeFileSync(fixture.tarball, "not a tar archive");
        // A missing extraction root proves integrity is checked before creating scratch state.
        fs.rmdirSync(fixture.runtimeRoot);
        error = "Published baseline archive integrity mismatch";
      } else if (change === "missing" || change === "empty-path") {
        if (change === "missing") {
          fs.unlinkSync(fixture.tarball);
        } else {
          fixture.tarball = "";
        }
        error = "ENOENT";
      } else if (change === "version") {
        fixture.published.version = "2026.9.4";
        error = "Published baseline version mismatch";
      } else if (change === "commit") {
        fixture.published.commit = "b".repeat(40);
        error = "Published baseline commit mismatch";
      } else {
        fs.writeFileSync(path.join(fixture.packageRoot, "dist/entry.mjs"), "export {};\n");
        error = "Installed application payload differs";
      }
      await expect(readWorkerCellBaselinePackage(fixture)).rejects.toThrow(error);
      if (change !== "corrupt") {
        expect(fs.readdirSync(fixture.runtimeRoot)).toEqual([]);
      }
    },
  );

  it("rejects a malformed archive even when its checksum matches", async () => {
    const fixture = baselineFixture();
    const bytes = Buffer.from("not a tar archive");
    fs.writeFileSync(fixture.tarball, bytes);
    fixture.published.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await expect(readWorkerCellBaselinePackage(fixture)).rejects.toThrow("Command failed: tar");
    expect(fs.readdirSync(fixture.runtimeRoot)).toEqual([]);
  });

  it.each(["synthetic", "missing"])(
    "rejects a %s archive at the baseline CLI boundary",
    (change) => {
      const fixture = baselineFixture();
      if (change === "missing") {
        fs.unlinkSync(fixture.tarball);
      }
      const artifacts = path.join(path.dirname(fixture.packageRoot), "artifacts");
      fs.mkdirSync(artifacts);
      const result = spawnSync(
        resolveTestNodeExecPath(),
        [
          "--input-type=module",
          "--eval",
          `import { pathToFileURL } from "node:url";
globalThis.fetch = () => { throw new Error("Unexpected baseline fetch"); };
await import(pathToFileURL(process.argv[1]).href);`,
          path.resolve("scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs"),
          "baseline",
          fixture.packageRoot,
          fixture.tarball,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
            OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: fixture.runtimeRoot,
            OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        change === "missing" ? "ENOENT" : "Published baseline archive integrity mismatch",
      );
      expect(result.stderr).not.toContain("Unexpected baseline fetch");
      expect(fs.readdirSync(artifacts)).toEqual([]);
      expect(fs.readdirSync(fixture.runtimeRoot)).toEqual([]);
    },
  );
});
