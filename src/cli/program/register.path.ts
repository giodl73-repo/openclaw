import type { Command } from "commander";

/**
 * `openclaw path` — operator-facing access to the OcPath substrate.
 *
 * Pass-through dispatcher: this file owns the integration seam (Commander
 * registration, help text, name reservation in the upstream command tree)
 * but delegates actual subcommand handling to the substrate package's own
 * CLI runner at `@openclaw/oc-path/cli`. Subcommands the substrate exposes:
 *
 *   openclaw path resolve <oc-path>     — print the match at the path
 *   openclaw path set <oc-path> <value> — write a leaf at the path
 *   openclaw path find <pattern>        — enumerate matches for a pattern
 *   openclaw path validate <oc-path>    — parse-only; print structure
 *   openclaw path emit <file>           — round-trip parse+emit (byte-fidelity)
 *
 * The substrate's CLI handles `--cwd`, `--file`, `--json` / `--human`,
 * pipe-guard, and sentinel scrub on output. Keeping the dispatcher
 * minimal here means subcommand drift can't open between this file and
 * the substrate; the substrate is the one source of truth.
 */
export function registerPathCommand(program: Command) {
  program
    .command("path")
    .description(
      "OcPath substrate — universal addressing for OpenClaw workspaces (resolve / set / find / validate / emit). Run `openclaw path help` for subcommands.",
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async () => {
      const idx = process.argv.indexOf("path");
      const pathArgs = idx >= 0 ? process.argv.slice(idx + 1) : [];
      const { runCli } = await import("@openclaw/oc-path/cli");
      const code = await runCli(pathArgs);
      process.exit(code);
    });
}
