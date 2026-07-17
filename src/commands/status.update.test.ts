// Status update tests cover update check display and availability formatting.
import { describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { VERSION } from "../version.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
  type UpdateStatusText,
} from "./status.update.js";

function buildUpdate(partial: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
    ...partial,
  };
}

function nextMajorVersion(version: string): string {
  const [majorPart] = version.split(".");
  const major = Number.parseInt(majorPart ?? "", 10);
  if (Number.isFinite(major) && major >= 0) {
    return `${major + 1}.0.0`;
  }
  return "999999.0.0";
}

const localizedText = {
  updateLabel: "更新",
  dirty: "有未提交更改",
  upToDate: "已是最新",
  behind: (count) => `落后 ${count}`,
  ahead: (count) => `领先 ${count}`,
  diverged: (ahead, behind) => `已分叉（领先 ${ahead}，落后 ${behind}）`,
  fetchFailed: "获取失败",
  taggedRegistryUpdate: (registryLabel, version) => `${registryLabel} 可更新至 ${version}`,
  npmUpdate: (version) => `npm 可更新至 ${version}`,
  aheadOfExtendedStable: (version) => `高于 extended-stable（${version}）`,
  localNewer: (registryLabel, version) => `${registryLabel} ${version}（本地版本较新）`,
  extendedStableRequiresPackage: "extended-stable 需要软件包安装方式",
  extendedStableSelectorMissing: "缺少 npm extended-stable 选择器",
  extendedStableQueryFailed: "npm extended-stable 查询失败",
  extendedStableVerificationFailed: "npm extended-stable 精确软件包验证失败",
  registryUnknown: (registryLabel) => `${registryLabel} 未知`,
  depsOk: "依赖正常",
  depsMissing: "缺少依赖",
  depsStale: "依赖已过期",
  gitBehind: (count) => `git 落后 ${count}`,
  updateAvailableHint: (details, command) => `有可用更新（${details}）。运行：${command}`,
} satisfies UpdateStatusText;

describe("resolveUpdateAvailability", () => {
  it("flags git update when behind upstream", () => {
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: null,
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 3,
        fetchOk: true,
      },
    });
    expect(resolveUpdateAvailability(update)).toEqual({
      available: true,
      hasGitUpdate: true,
      hasRegistryUpdate: false,
      latestVersion: null,
      gitBehind: 3,
    });
  });

  it("flags registry update when latest version is newer", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      installKind: "package",
      packageManager: "pnpm",
      registry: { latestVersion },
    });
    const availability = resolveUpdateAvailability(update);
    expect(availability.available).toBe(true);
    expect(availability.hasGitUpdate).toBe(false);
    expect(availability.hasRegistryUpdate).toBe(true);
    expect(availability.latestVersion).toBe(latestVersion);
  });
});

describe("formatUpdateOneLiner", () => {
  it("renders git status and registry summary without duplicating up to date", () => {
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: "abc123456789",
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: true,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
      registry: { latestVersion: VERSION },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "pnpm-lock.yaml",
        markerPath: "node_modules/.modules.yaml",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: git main · ↔ origin/main · dirty · behind 2 · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders synced git installs with a single up to date label", () => {
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: "abc123456789",
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      registry: { latestVersion: VERSION },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "pnpm-lock.yaml",
        markerPath: "node_modules/.modules.yaml",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: git main · ↔ origin/main · up to date · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders package-manager mode with explicit up-to-date state", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: VERSION },
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: "package-lock.json",
        markerPath: "node_modules",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: npm · up to date · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders beta registry tags instead of calling them npm latest", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: VERSION, tag: "beta" },
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: "package-lock.json",
        markerPath: "node_modules",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: npm · up to date · npm beta ${VERSION} · deps ok`,
    );
  });

  it("renders an installed version newer than extended-stable as ahead", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "1.0.0", tag: "extended-stable" },
    });

    expect(formatUpdateOneLiner(update)).toBe("Update: npm · ahead of extended-stable (1.0.0)");
  });

  it("renders structured extended-stable resolver failures", () => {
    const update = buildUpdate({
      installKind: "git",
      packageManager: "pnpm",
      registry: {
        latestVersion: null,
        tag: "extended-stable",
        error: "unsupported_git_channel",
        reason: "unsupported_git_channel",
      },
    });

    expect(formatUpdateOneLiner(update)).toContain("extended-stable requires a package install");
  });

  it("renders package-manager mode with registry error", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: null, error: "offline" },
      deps: {
        manager: "npm",
        status: "missing",
        lockfilePath: "package-lock.json",
        markerPath: "node_modules",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe("Update: npm · npm latest unknown · deps missing");
  });

  it("uses injected localized text without translating refs or versions", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: "abc123456789",
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: true,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
      registry: { latestVersion },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "pnpm-lock.yaml",
        markerPath: "node_modules/.modules.yaml",
      },
    });

    expect(formatUpdateOneLiner(update, localizedText)).toBe(
      `更新: git main · ↔ origin/main · 有未提交更改 · 落后 2 · npm 可更新至 ${latestVersion} · 依赖正常`,
    );
  });
});

describe("formatUpdateAvailableHint", () => {
  it("returns null when no update is available", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "pnpm",
      registry: { latestVersion: VERSION },
    });

    expect(formatUpdateAvailableHint(update)).toBeNull();
  });

  it("renders git and registry update details", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: null,
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
      registry: { latestVersion },
    });

    expect(formatUpdateAvailableHint(update)).toBe(
      `Update available (git behind 2 · npm ${latestVersion}). Run: openclaw update`,
    );
  });

  it("uses injected localized hint text while preserving the command", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: null,
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
      registry: { latestVersion },
    });

    expect(formatUpdateAvailableHint(update, localizedText)).toBe(
      `有可用更新（git 落后 2 · npm ${latestVersion}）。运行：openclaw update`,
    );
  });
});
