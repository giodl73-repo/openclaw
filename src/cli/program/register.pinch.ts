import type { Command } from "commander";

/**
 * `openclaw pinch` — operator-facing access to the lint framework.
 *
 * Pass-through dispatcher: this file owns the integration seam (Commander
 * registration, help text, name reservation) and delegates actual
 * subcommand handling to the substrate's CLI runner at
 * `@openclaw/oc-lint/cli`. Subcommands the substrate exposes:
 *
 *   openclaw pinch run [--cwd <dir>] [--severity-min <level>]    — run all rules over the workspace
 *   openclaw pinch lint <file...>                                — lint specific files
 *   openclaw pinch list-rules [--pack <name>]                    — enumerate registered rules
 *
 * The substrate's CLI handles `--skip` / `--only` / `--severity` overrides,
 * `--json` / `--human` output mode, pipe-guard, and sentinel scrub. Same
 * minimal-dispatcher pattern as `register.path.ts` — one source of truth
 * for subcommand logic in the substrate package.
 */
export function registerPinchCommand(program: Command) {
  program
    .command("pinch")
    .description(
      "OpenClaw lint framework — run plugin-contributed rules over workspace artifacts (md / jsonc / jsonl / yaml). Run `openclaw pinch help` for subcommands.",
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async () => {
      const idx = process.argv.indexOf("pinch");
      const pinchArgs = idx >= 0 ? process.argv.slice(idx + 1) : [];
      const { runCli } = await import("@openclaw/oc-lint/cli");
      const code = await runCli(pinchArgs);
      process.exit(code);
    });
}
