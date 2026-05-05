import type { Command } from "commander";

/**
 * `openclaw policy` — operator-facing access to the PolicyIR substrate.
 *
 * Pass-through dispatcher: this file owns the integration seam (Commander
 * registration, help text, name reservation) and delegates actual
 * subcommand handling to the substrate's CLI runner at
 * `@openclaw/policy/cli`. Subcommands the substrate exposes:
 *
 *   openclaw policy generate [<dir>] [--write] [--dry-run]   — generate from MD sources
 *   openclaw policy check [<dir>]                            — drift detection
 *   openclaw policy diff [<dir>] [--against <policyId>]      — show what would change
 *   openclaw policy evaluate [<dir>] --tool <id> --args <…>  — dry-run a decision
 *   openclaw policy list-generators                           — enumerate registered generators
 *
 * Same minimal-dispatcher pattern as register.path.ts / register.pinch.ts /
 * register.cage.ts. The substrate is the one source of truth for
 * subcommand logic.
 */
export function registerPolicyCommand(program: Command) {
  program
    .command("policy")
    .description(
      "OpenClaw PolicyIR substrate — generate / check / diff / evaluate policy artifacts (LKG-anchored, content-addressable). Run `openclaw policy help` for subcommands.",
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async () => {
      const idx = process.argv.indexOf("policy");
      const policyArgs = idx >= 0 ? process.argv.slice(idx + 1) : [];
      const { runCli } = await import("@openclaw/policy/cli");
      const code = await runCli(policyArgs);
      process.exit(code);
    });
}
