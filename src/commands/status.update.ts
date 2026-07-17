// Update status helpers for `openclaw status`.
// Wraps registry/git update checks and formats compact update rows/hints.

import { formatCliCommand } from "../cli/command-format.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  type UpdateCheckResult,
} from "../infra/update-check.js";
import { VERSION } from "../version.js";

/** Runs the update check using the configured update channel and current install root. */
export async function getUpdateCheckResult(params: {
  timeoutMs: number;
  fetchGit: boolean;
  includeRegistry: boolean;
  updateConfigChannel?: string | null;
}): Promise<UpdateCheckResult> {
  const configChannel = normalizeUpdateChannel(params.updateConfigChannel);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  return await checkUpdateStatus({
    root,
    timeoutMs: params.timeoutMs,
    fetchGit: params.fetchGit,
    includeRegistry: params.includeRegistry,
    registryChannel: resolveRegistryUpdateChannel({
      configChannel,
      currentVersion: VERSION,
    }),
  });
}

type UpdateAvailability = {
  available: boolean;
  hasGitUpdate: boolean;
  hasRegistryUpdate: boolean;
  latestVersion: string | null;
  gitBehind: number | null;
};

export type UpdateStatusText = {
  updateLabel: string;
  dirty: string;
  upToDate: string;
  behind: (count: number) => string;
  ahead: (count: number) => string;
  diverged: (ahead: number, behind: number) => string;
  fetchFailed: string;
  taggedRegistryUpdate: (registryLabel: string, version: string) => string;
  npmUpdate: (version: string) => string;
  aheadOfExtendedStable: (version: string) => string;
  localNewer: (registryLabel: string, version: string) => string;
  extendedStableRequiresPackage: string;
  extendedStableSelectorMissing: string;
  extendedStableQueryFailed: string;
  extendedStableVerificationFailed: string;
  registryUnknown: (registryLabel: string) => string;
  depsOk: string;
  depsMissing: string;
  depsStale: string;
  gitBehind: (count: number) => string;
  updateAvailableHint: (details: string, command: string) => string;
};

const ENGLISH_UPDATE_STATUS_TEXT: UpdateStatusText = {
  updateLabel: "Update",
  dirty: "dirty",
  upToDate: "up to date",
  behind: (count) => `behind ${count}`,
  ahead: (count) => `ahead ${count}`,
  diverged: (ahead, behind) => `diverged (ahead ${ahead}, behind ${behind})`,
  fetchFailed: "fetch failed",
  taggedRegistryUpdate: (registryLabel, version) => `${registryLabel} update ${version}`,
  npmUpdate: (version) => `npm update ${version}`,
  aheadOfExtendedStable: (version) => `ahead of extended-stable (${version})`,
  localNewer: (registryLabel, version) => `${registryLabel} ${version} (local newer)`,
  extendedStableRequiresPackage: "extended-stable requires a package install",
  extendedStableSelectorMissing: "npm extended-stable selector missing",
  extendedStableQueryFailed: "npm extended-stable query failed",
  extendedStableVerificationFailed: "npm extended-stable exact package verification failed",
  registryUnknown: (registryLabel) => `${registryLabel} unknown`,
  depsOk: "deps ok",
  depsMissing: "deps missing",
  depsStale: "deps stale",
  gitBehind: (count) => `git behind ${count}`,
  updateAvailableHint: (details, command) => `Update available (${details}). Run: ${command}`,
};

/** Determines whether git and/or registry data indicate an available update. */
export function resolveUpdateAvailability(update: UpdateCheckResult): UpdateAvailability {
  const latestVersion = update.registry?.latestVersion ?? null;
  const registryCmp = latestVersion ? compareSemverStrings(VERSION, latestVersion) : null;
  const hasRegistryUpdate = registryCmp != null && registryCmp < 0;
  const gitBehind =
    update.installKind === "git" && typeof update.git?.behind === "number"
      ? update.git.behind
      : null;
  const hasGitUpdate = gitBehind != null && gitBehind > 0;

  return {
    available: hasGitUpdate || hasRegistryUpdate,
    hasGitUpdate,
    hasRegistryUpdate,
    latestVersion: hasRegistryUpdate ? latestVersion : null,
    gitBehind,
  };
}

/** Formats the actionable update hint shown in status footers. */
export function formatUpdateAvailableHint(
  update: UpdateCheckResult,
  text: UpdateStatusText = ENGLISH_UPDATE_STATUS_TEXT,
): string | null {
  const availability = resolveUpdateAvailability(update);
  if (!availability.available) {
    return null;
  }

  const details: string[] = [];
  if (availability.hasGitUpdate && availability.gitBehind != null) {
    details.push(text.gitBehind(availability.gitBehind));
  }
  if (availability.hasRegistryUpdate && availability.latestVersion) {
    details.push(`npm ${availability.latestVersion}`);
  }
  return text.updateAvailableHint(details.join(" · "), formatCliCommand("openclaw update"));
}

/** Formats a compact one-line update summary for overview rows. */
export function formatUpdateOneLiner(
  update: UpdateCheckResult,
  text: UpdateStatusText = ENGLISH_UPDATE_STATUS_TEXT,
  options?: { includeLabel?: boolean },
): string {
  const parts: string[] = [];

  const appendRegistryUpdateSummary = () => {
    const registryLabel =
      update.registry?.tag && update.registry.tag !== "latest"
        ? `npm ${update.registry.tag}`
        : "npm latest";
    if (update.registry?.latestVersion) {
      const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
      if (cmp === 0) {
        if (update.installKind !== "git") {
          parts.push(text.upToDate);
        }
        // Git installs still show registry latest, but git ahead/behind remains the primary state.
        parts.push(`${registryLabel} ${update.registry.latestVersion}`);
      } else if (cmp != null && cmp < 0) {
        parts.push(
          update.registry.tag && update.registry.tag !== "latest"
            ? text.taggedRegistryUpdate(registryLabel, update.registry.latestVersion)
            : text.npmUpdate(update.registry.latestVersion),
        );
      } else {
        parts.push(
          update.registry.tag === "extended-stable"
            ? text.aheadOfExtendedStable(update.registry.latestVersion)
            : text.localNewer(registryLabel, update.registry.latestVersion),
        );
      }
      return;
    }
    if (update.registry?.error) {
      if (update.registry.reason === "unsupported_git_channel") {
        parts.push(text.extendedStableRequiresPackage);
        return;
      }
      if (update.registry.reason === "selector_missing") {
        parts.push(text.extendedStableSelectorMissing);
        return;
      }
      if (update.registry.reason === "selector_query_failed") {
        parts.push(text.extendedStableQueryFailed);
        return;
      }
      if (update.registry.reason === "exact_package_mismatch") {
        parts.push(text.extendedStableVerificationFailed);
        return;
      }
      parts.push(text.registryUnknown(registryLabel));
    }
  };

  if (update.installKind === "git" && update.git) {
    const branch = update.git.branch ? `git ${update.git.branch}` : "git";
    parts.push(branch);
    if (update.git.upstream) {
      parts.push(`↔ ${update.git.upstream}`);
    }
    if (update.git.dirty === true) {
      parts.push(text.dirty);
    }
    if (update.git.behind != null && update.git.ahead != null) {
      if (update.git.behind === 0 && update.git.ahead === 0) {
        parts.push(text.upToDate);
      } else if (update.git.behind > 0 && update.git.ahead === 0) {
        parts.push(text.behind(update.git.behind));
      } else if (update.git.behind === 0 && update.git.ahead > 0) {
        parts.push(text.ahead(update.git.ahead));
      } else if (update.git.behind > 0 && update.git.ahead > 0) {
        parts.push(text.diverged(update.git.ahead, update.git.behind));
      }
    }
    if (update.git.fetchOk === false) {
      parts.push(text.fetchFailed);
    }
    appendRegistryUpdateSummary();
  } else {
    parts.push(update.packageManager !== "unknown" ? update.packageManager : "pkg");
    appendRegistryUpdateSummary();
  }

  if (update.deps) {
    if (update.deps.status === "ok") {
      parts.push(text.depsOk);
    }
    if (update.deps.status === "missing") {
      parts.push(text.depsMissing);
    }
    if (update.deps.status === "stale") {
      parts.push(text.depsStale);
    }
  }
  const summary = parts.join(" · ");
  return options?.includeLabel === false ? summary : `${text.updateLabel}: ${summary}`;
}
