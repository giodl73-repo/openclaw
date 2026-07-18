// Launches and manages the local shell process used by TUI local mode.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { createSearchableSelectList } from "./components/selectors.js";
import { TUI_ENGLISH_LOCALIZATION, type TuiLocalization } from "./i18n/runtime.js";

type LocalShellDeps = {
  chatLog: {
    addSystem: (line: string) => void;
  };
  tui: {
    requestRender: () => void;
  };
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  createSelector?: (
    items: SelectItem[],
    maxVisible: number,
  ) => Component & {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  spawnCommand?: typeof spawn;
  getCwd?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  maxOutputChars?: number;
  localization?: TuiLocalization;
};

export function createLocalShellRunner(deps: LocalShellDeps) {
  const localization = deps.localization ?? TUI_ENGLISH_LOCALIZATION;
  let localExecAsked = false;
  let localExecAllowed = false;
  const createSelector =
    deps.createSelector ??
    ((items: SelectItem[], maxVisible: number) =>
      createSearchableSelectList(items, maxVisible, localization));
  const spawnCommand = deps.spawnCommand ?? spawn;
  const getCwd = deps.getCwd ?? tryProcessCwd;
  const env = deps.env ?? process.env;
  const maxChars = deps.maxOutputChars ?? 40_000;

  const ensureLocalExecAllowed = async (): Promise<boolean> => {
    if (localExecAllowed) {
      return true;
    }
    if (localExecAsked) {
      return false;
    }
    localExecAsked = true;

    return await new Promise<boolean>((resolve) => {
      deps.chatLog.addSystem(localization.t("tui.localShell.allow"));
      deps.chatLog.addSystem(localization.t("tui.localShell.warning"));
      deps.chatLog.addSystem(localization.t("tui.localShell.instructions"));
      const selector = createSelector(
        [
          { value: "no", label: localization.t("tui.localShell.no") },
          { value: "yes", label: localization.t("tui.localShell.yes") },
        ],
        2,
      );
      selector.onSelect = (item: SelectItem) => {
        deps.closeOverlay(overlayHandle);
        if (item.value === "yes") {
          localExecAllowed = true;
          deps.chatLog.addSystem(localization.t("tui.localShell.enabled"));
          resolve(true);
        } else {
          deps.chatLog.addSystem(localization.t("tui.localShell.notEnabled"));
          resolve(false);
        }
        deps.tui.requestRender();
      };
      selector.onCancel = () => {
        deps.closeOverlay(overlayHandle);
        deps.chatLog.addSystem(localization.t("tui.localShell.cancelled"));
        deps.tui.requestRender();
        resolve(false);
      };
      const overlayHandle: OverlayHandle = deps.openOverlay(selector);
      deps.tui.requestRender();
    });
  };

  const runLocalShellLine = async (line: string) => {
    const cmd = line.slice(1);
    // NOTE: A lone '!' is handled by the submit handler as a normal message.
    // Keep this guard anyway in case this is called directly.
    if (cmd === "") {
      return;
    }

    if (localExecAsked && !localExecAllowed) {
      deps.chatLog.addSystem(localization.t("tui.localShell.notEnabledForSession"));
      deps.tui.requestRender();
      return;
    }

    const allowed = await ensureLocalExecAllowed();
    if (!allowed) {
      return;
    }

    // A shell command's meaning depends on its directory; never retarget it implicitly.
    const cwd = getCwd();
    if (!cwd) {
      deps.chatLog.addSystem(localization.t("tui.localShell.cwdDeleted"));
      deps.tui.requestRender();
      return;
    }

    deps.chatLog.addSystem(`[local] $ ${cmd}`);
    deps.tui.requestRender();

    const appendWithCap = (text: string, chunk: string) => {
      const combined = text + chunk;
      return combined.length > maxChars ? sliceUtf16Safe(combined, -maxChars) : combined;
    };

    await new Promise<void>((resolve) => {
      const child = spawnCommand(cmd, {
        // Intentionally a shell: this is an operator-only local TUI feature (prefixed with `!`)
        // and is gated behind an explicit in-session approval prompt.
        shell: true,
        cwd,
        env: { ...env, OPENCLAW_SHELL: "tui-local" },
      });

      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      // Output pipes may fail independently; child close/error remains authoritative.
      const ignoreOutputStreamError = () => {};
      child.stdout.on("error", ignoreOutputStreamError);
      child.stderr.on("error", ignoreOutputStreamError);
      child.stdout.on("data", (buf) => {
        stdout = appendWithCap(stdout, stdoutDecoder.write(buf));
      });
      child.stderr.on("data", (buf) => {
        stderr = appendWithCap(stderr, stderrDecoder.write(buf));
      });

      child.on("close", (code, signal) => {
        stdout = appendWithCap(stdout, stdoutDecoder.end());
        stderr = appendWithCap(stderr, stderrDecoder.end());
        // Keep the tail (consistent with the streaming appendWithCap above) so a
        // large stdout cannot evict stderr: the failure reason (FATAL etc.) at the
        // end is what the operator needs most when output overflows the cap.
        const combined = sliceUtf16Safe(
          stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""),
          -maxChars,
        ).trimEnd();

        if (combined) {
          for (const lineLocal of combined.split("\n")) {
            deps.chatLog.addSystem(`[local] ${lineLocal}`);
          }
        }
        deps.chatLog.addSystem(
          signal
            ? localization.t("tui.localShell.exitSignal", {
                code: code ?? "?",
                signal,
              })
            : localization.t("tui.localShell.exit", { code: code ?? "?" }),
        );
        deps.tui.requestRender();
        resolve();
      });

      child.on("error", (err) => {
        deps.chatLog.addSystem(localization.t("tui.localShell.error", { error: String(err) }));
        deps.tui.requestRender();
        resolve();
      });
    });
  };

  return { runLocalShellLine };
}
