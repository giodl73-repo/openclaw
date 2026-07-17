// `openclaw update status`: combines install metadata, configured channel, and remote update checks.
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
  type UpdateStatusText,
} from "../../commands/status.update.js";
import { readSourceConfigBestEffort } from "../../config/config.js";
import {
  normalizeUpdateChannel,
  resolveRegistryUpdateChannel,
  resolveUpdateChannelDisplay,
} from "../../infra/update-channels.js";
import { checkUpdateStatus } from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { createCliLocalization, type CliLocalization } from "../i18n/runtime.js";
import { parseTimeoutMsOrExit, resolveUpdateRoot, type UpdateStatusOptions } from "./shared.js";

function formatGitStatusLine(params: {
  branch: string | null;
  tag: string | null;
  sha: string | null;
  localization: CliLocalization;
}): string {
  const shortSha = params.sha ? params.sha.slice(0, 8) : null;
  const branch = params.branch && params.branch !== "HEAD" ? params.branch : null;
  const tag = params.tag;
  const parts = [
    branch ?? (tag ? params.localization.t("cli.updateStatus.git.detached") : "git"),
    tag ? params.localization.t("cli.updateStatus.git.tag", { tag }) : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function createUpdateStatusText(localization: CliLocalization): UpdateStatusText {
  return {
    updateLabel: localization.t("cli.updateStatus.summary.label"),
    dirty: localization.t("cli.updateStatus.summary.dirty"),
    upToDate: localization.t("cli.updateStatus.summary.upToDate"),
    behind: (count) => localization.t("cli.updateStatus.summary.behind", { count }),
    ahead: (count) => localization.t("cli.updateStatus.summary.ahead", { count }),
    diverged: (ahead, behind) =>
      localization.t("cli.updateStatus.summary.diverged", { ahead, behind }),
    fetchFailed: localization.t("cli.updateStatus.summary.fetchFailed"),
    taggedRegistryUpdate: (registryLabel, version) =>
      localization.t("cli.updateStatus.summary.taggedRegistryUpdate", {
        registryLabel,
        version,
      }),
    npmUpdate: (version) => localization.t("cli.updateStatus.summary.npmUpdate", { version }),
    aheadOfExtendedStable: (version) =>
      localization.t("cli.updateStatus.summary.aheadOfExtendedStable", { version }),
    localNewer: (registryLabel, version) =>
      localization.t("cli.updateStatus.summary.localNewer", { registryLabel, version }),
    extendedStableRequiresPackage: localization.t(
      "cli.updateStatus.summary.extendedStableRequiresPackage",
    ),
    extendedStableSelectorMissing: localization.t(
      "cli.updateStatus.summary.extendedStableSelectorMissing",
    ),
    extendedStableQueryFailed: localization.t("cli.updateStatus.summary.extendedStableQueryFailed"),
    extendedStableVerificationFailed: localization.t(
      "cli.updateStatus.summary.extendedStableVerificationFailed",
    ),
    registryUnknown: (registryLabel) =>
      localization.t("cli.updateStatus.summary.registryUnknown", { registryLabel }),
    depsOk: localization.t("cli.updateStatus.summary.depsOk"),
    depsMissing: localization.t("cli.updateStatus.summary.depsMissing"),
    depsStale: localization.t("cli.updateStatus.summary.depsStale"),
    gitBehind: (count) => localization.t("cli.updateStatus.hint.gitBehind", { count }),
    updateAvailableHint: (details, command) =>
      localization.t("cli.updateStatus.hint.available", { details, command }),
  };
}

function formatChannelLabel(params: {
  channelInfo: ReturnType<typeof resolveUpdateChannelDisplay>;
  gitTag: string | null;
  gitBranch: string | null;
  localization: CliLocalization;
}): string {
  const { channel, source } = params.channelInfo;
  if (source === "config") {
    return params.localization.t("cli.updateStatus.channel.config", { channel });
  }
  if (source === "git-tag") {
    return params.gitTag
      ? params.localization.t("cli.updateStatus.channel.gitTag", {
          channel,
          tag: params.gitTag,
        })
      : params.localization.t("cli.updateStatus.channel.tag", { channel });
  }
  if (source === "git-branch") {
    return params.gitBranch
      ? params.localization.t("cli.updateStatus.channel.gitBranch", {
          channel,
          branch: params.gitBranch,
        })
      : params.localization.t("cli.updateStatus.channel.branch", { channel });
  }
  if (source === "installed-version") {
    return params.localization.t("cli.updateStatus.channel.installedVersion", { channel });
  }
  return params.localization.t("cli.updateStatus.channel.default", { channel });
}

/** Print update status in JSON or table form for scripts and humans. */
export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const localization = createCliLocalization();
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout, localization);
  if (timeoutMs === null) {
    return;
  }

  const root = await resolveUpdateRoot();
  const config = await readSourceConfigBestEffort();
  const configChannel = normalizeUpdateChannel(config.update?.channel);

  const update = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: true,
    includeRegistry: true,
    registryChannel: resolveRegistryUpdateChannel({
      configChannel,
      currentVersion: VERSION,
    }),
  });

  const channelInfo = resolveUpdateChannelDisplay({
    configChannel,
    currentVersion: VERSION,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });
  const channelLabel = channelInfo.label;
  const humanChannelLabel = formatChannelLabel({
    channelInfo,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
    localization,
  });

  const gitLabel =
    update.installKind === "git"
      ? formatGitStatusLine({
          branch: update.git?.branch ?? null,
          tag: update.git?.tag ?? null,
          sha: update.git?.sha ?? null,
          localization,
        })
      : null;

  const updateAvailability = resolveUpdateAvailability(update);
  const text = createUpdateStatusText(localization);
  const updateLine = formatUpdateOneLiner(update, text, { includeLabel: false });

  if (opts.json) {
    defaultRuntime.writeJson({
      update,
      channel: {
        value: channelInfo.channel,
        source: channelInfo.source,
        label: channelLabel,
        config: configChannel,
      },
      availability: updateAvailability,
    });
    return;
  }

  const tableWidth = getTerminalTableWidth();
  const installLabel =
    update.installKind === "git"
      ? `git (${update.root ?? localization.t("cli.updateStatus.unknown")})`
      : update.installKind === "package"
        ? update.packageManager
        : localization.t("cli.updateStatus.unknown");

  const rows = [
    { Item: localization.t("cli.updateStatus.row.install"), Value: installLabel },
    { Item: localization.t("cli.updateStatus.row.channel"), Value: humanChannelLabel },
    ...(gitLabel ? [{ Item: localization.t("cli.updateStatus.row.git"), Value: gitLabel }] : []),
    {
      Item: localization.t("cli.updateStatus.row.update"),
      Value: updateAvailability.available
        ? theme.warn(`${localization.t("cli.updateStatus.available")} · ${updateLine}`)
        : updateLine,
    },
  ];

  defaultRuntime.log(theme.heading(localization.t("cli.updateStatus.heading")));
  defaultRuntime.log("");
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        {
          key: "Item",
          header: localization.t("cli.updateStatus.header.item"),
          minWidth: 10,
        },
        {
          key: "Value",
          header: localization.t("cli.updateStatus.header.value"),
          flex: true,
          minWidth: 24,
        },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");

  const updateHint = formatUpdateAvailableHint(update, text);
  if (updateHint) {
    defaultRuntime.log(theme.warn(updateHint));
  }
}
