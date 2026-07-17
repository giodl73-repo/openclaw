// Gateway service status command entrypoint: gathers status, prints it, and handles probe failures.
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { createCliLocalization } from "../i18n/runtime.js";
import { gatherDaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";
import type { DaemonStatusOptions } from "./types.js";

/** Run Gateway status diagnostics and apply --require-rpc exit behavior. */
export async function runDaemonStatus(opts: DaemonStatusOptions) {
  const localization = createCliLocalization();
  try {
    if (opts.requireRpc && !opts.probe) {
      defaultRuntime.error(localization.t("cli.gatewayStatus.requireRpcNeedsProbe"));
      defaultRuntime.exit(1);
      return;
    }
    const status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: opts.probe,
      requireRpc: opts.requireRpc,
      deep: opts.deep === true,
    });
    printDaemonStatus(status, { json: opts.json, deep: opts.deep === true });
    if (opts.requireRpc && !status.rpc?.ok) {
      defaultRuntime.exit(1);
    }
  } catch (err) {
    const rich = isRich();
    defaultRuntime.error(
      colorize(
        rich,
        theme.error,
        localization.t("cli.gatewayStatus.failed", { error: String(err) }),
      ),
    );
    defaultRuntime.exit(1);
  }
}
