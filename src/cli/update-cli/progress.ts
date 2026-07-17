// Update command presentation helpers: spinner lifecycle, failure hints, and result summaries.
import { spinner } from "@clack/prompts";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import type {
  UpdateRunResult,
  UpdateStepAdvisory,
  UpdateStepInfo,
  UpdateStepProgress,
} from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { CliMessageKey } from "../i18n/locales/en.js";
import { createCliLocalization, type CliLocalization } from "../i18n/runtime.js";
import type { UpdateCommandOptions } from "./shared.js";

const STEP_LABEL_KEYS: Record<string, CliMessageKey> = {
  "clean check": "cli.update.progress.cleanCheck",
  "upstream check": "cli.update.progress.upstreamCheck",
  "git fetch": "cli.update.progress.gitFetch",
  "git rebase": "cli.update.progress.gitRebase",
  "git rev-parse @{upstream}": "cli.update.progress.resolveUpstream",
  "git rev-list": "cli.update.progress.enumerateCommits",
  "git clone": "cli.update.progress.gitClone",
  "preflight worktree": "cli.update.progress.preflightWorktree",
  "preflight cleanup": "cli.update.progress.preflightCleanup",
  "deps install": "cli.update.progress.depsInstall",
  build: "cli.update.progress.build",
  "ui:build": "cli.update.progress.uiBuild",
  "ui:build (post-doctor repair)": "cli.update.progress.uiRestore",
  "ui assets verify": "cli.update.progress.uiVerify",
  "openclaw doctor entry": "cli.update.progress.doctorEntry",
  "openclaw doctor": "cli.update.progress.doctor",
  "git rev-parse HEAD (after)": "cli.update.progress.verify",
  "global update": "cli.update.progress.globalUpdate",
  "global update (omit optional)": "cli.update.progress.globalUpdateOmitOptional",
  "global install stage": "cli.update.progress.globalInstallStage",
  "global install verify": "cli.update.progress.globalInstallVerify",
  "global install swap": "cli.update.progress.globalInstallSwap",
  "global install": "cli.update.progress.globalInstall",
};

function getStepLabel(step: Pick<UpdateStepInfo, "name">, localization: CliLocalization): string {
  const key = STEP_LABEL_KEYS[step.name];
  return key ? localization.t(key) : step.name;
}

function isAdvisoryStep(step: { advisory?: UpdateStepAdvisory }): boolean {
  return step.advisory !== undefined;
}

/** Convert updater failure reasons and stderr tails into operator-facing recovery hints. */
function inferUpdateFailureHints(result: UpdateRunResult, localization: CliLocalization): string[] {
  if (result.status !== "error") {
    return [];
  }
  if (result.reason === "pnpm-corepack-missing") {
    return [
      localization.t("cli.update.recovery.corepackMissing"),
      localization.t("cli.update.recovery.installPnpmOrCorepack"),
    ];
  }
  if (result.reason === "pnpm-corepack-enable-failed") {
    return [
      localization.t("cli.update.recovery.corepackEnableFailed"),
      localization.t("cli.update.recovery.enableCorepackOrInstallPnpm"),
    ];
  }
  if (result.reason === "pnpm-npm-bootstrap-failed") {
    return [
      localization.t("cli.update.recovery.pnpmBootstrapFailed"),
      localization.t("cli.update.recovery.installPnpm"),
    ];
  }
  if (result.reason === "preferred-manager-unavailable") {
    return [
      localization.t("cli.update.recovery.managerUnavailable"),
      localization.t("cli.update.recovery.installManager"),
    ];
  }
  if (result.mode !== "npm") {
    return [];
  }
  const failedStep = [...result.steps].toReversed().find((step) => step.exitCode !== 0);
  if (!failedStep) {
    return [];
  }

  const stderr = normalizeLowercaseStringOrEmpty(failedStep.stderrTail);
  const hints: string[] = [];
  const isGlobalPackageInstallStep =
    failedStep.name.startsWith("global update") || failedStep.name.startsWith("global install");

  if (isGlobalPackageInstallStep && stderr.includes("eacces")) {
    hints.push(localization.t("cli.update.recovery.permission"));
    hints.push(localization.t("cli.update.recovery.stopGateway"));
    hints.push(localization.t("cli.update.recovery.permissionExample"));
    hints.push(localization.t("cli.update.recovery.systemInstallOutline"));
  }

  if (
    failedStep.name.startsWith("global update") &&
    (stderr.includes("node-gyp") || stderr.includes("prebuild"))
  ) {
    hints.push(localization.t("cli.update.recovery.optionalDependency"));
    hints.push(localization.t("cli.update.recovery.optionalDependencyCommand"));
  }

  return hints;
}

/** Runner-facing progress callbacks plus terminal spinner cleanup. */
type ProgressController = {
  progress: UpdateStepProgress;
  stop: () => void;
};

/** Create a progress adapter for the updater runner without coupling runner code to terminal UI. */
export function createUpdateProgress(
  enabled: boolean,
  localization: CliLocalization = createCliLocalization(),
): ProgressController {
  if (!enabled) {
    return {
      progress: {},
      stop: () => {},
    };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;

  const progress: UpdateStepProgress = {
    onStepStart: (step) => {
      currentSpinner = spinner();
      currentSpinner.start(theme.accent(getStepLabel(step, localization)));
    },
    onStepComplete: (step) => {
      if (!currentSpinner) {
        return;
      }

      const label = getStepLabel(step, localization);
      const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
      const icon = formatStepStatus(step);

      currentSpinner.stop(`${icon} ${label} ${duration}`);
      currentSpinner = null;

      if (isAdvisoryStep(step) && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(-10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.warn(line)}`);
          }
        }
      } else if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(-10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.error(line)}`);
          }
        }
      }
    },
  };

  return {
    progress,
    stop: () => {
      if (currentSpinner) {
        currentSpinner.stop();
        currentSpinner = null;
      }
    },
  };
}

function formatStepStatus(step: {
  exitCode: number | null;
  advisory?: UpdateStepAdvisory;
}): string {
  if (isAdvisoryStep(step)) {
    return theme.warn("!");
  }
  if (step.exitCode === 0) {
    return theme.success("\u2713");
  }
  if (step.exitCode === null) {
    return theme.warn("?");
  }
  return theme.error("\u2717");
}

type PrintResultOptions = UpdateCommandOptions & {
  hideSteps?: boolean;
};

/** Render a completed updater run as JSON or terminal output. */
export function printResult(
  result: UpdateRunResult,
  opts: PrintResultOptions,
  localization: CliLocalization = createCliLocalization(),
): void {
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }

  const statusColor =
    result.status === "ok" ? theme.success : result.status === "skipped" ? theme.warn : theme.error;

  defaultRuntime.log("");
  defaultRuntime.log(
    `${theme.heading(localization.t("cli.update.result.heading"))} ${statusColor(
      result.status.toUpperCase(),
    )}`,
  );
  if (result.root) {
    defaultRuntime.log(
      `  ${localization.t("cli.update.result.root")}: ${theme.muted(result.root)}`,
    );
  }
  if (result.reason) {
    defaultRuntime.log(
      `  ${localization.t("cli.update.result.reason")}: ${theme.muted(result.reason)}`,
    );
  }

  if (result.before?.version || result.before?.sha) {
    const before = result.before.version ?? result.before.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  ${localization.t("cli.update.result.before")}: ${theme.muted(before)}`);
  }
  if (result.after?.version || result.after?.sha) {
    const after = result.after.version ?? result.after.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  ${localization.t("cli.update.result.after")}: ${theme.muted(after)}`);
  }

  if (!opts.hideSteps && result.steps.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(localization.t("cli.update.result.steps")));
    for (const step of result.steps) {
      const status = formatStepStatus(step);
      const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
      defaultRuntime.log(`  ${status} ${step.name} ${duration}`);

      if (isAdvisoryStep(step) && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.warn(line)}`);
          }
        }
      } else if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.error(line)}`);
          }
        }
      }
    }
  }

  const hints = inferUpdateFailureHints(result, localization);
  if (hints.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(localization.t("cli.update.result.recoveryHints")));
    for (const hint of hints) {
      defaultRuntime.log(`  - ${theme.warn(hint)}`);
    }
  }

  defaultRuntime.log("");
  defaultRuntime.log(
    `${localization.t("cli.update.result.totalTime")}: ${theme.muted(
      formatDurationPrecise(result.durationMs),
    )}`,
  );
}
