import type { Command } from "commander";

/**
 * `openclaw cage` — operator-facing access to the LKG (Last-Known-Good)
 * substrate. The cage holds your good states until you need to fall back.
 *
 * Pass-through dispatcher: this file owns the integration seam (Commander
 * registration, help text, name reservation) and delegates actual
 * subcommand handling to the substrate's CLI runner at
 * `@openclaw/lkg/cli`. Subcommands the substrate exposes:
 *
 *   openclaw cage status [<dir>]                       — workspace-wide observe
 *   openclaw cage observe <file>                       — single-file observe
 *   openclaw cage promote [<dir>] [--label <name>]     — operator: "this is good"
 *   openclaw cage labels [<dir>]                       — list labeled pins
 *   openclaw cage rollback --label <name> [<dir>]      — atomic restore
 *   openclaw cage delete-label <name> [<dir>]          — escape hatch for immutable labels
 *   openclaw cage list-trackers [<dir>]                — enumerate registered trackers
 *   openclaw cage fingerprint <file>                   — sha256 over file bytes
 *
 * Same minimal-dispatcher pattern as `register.path.ts` (oc-paths) and
 * `register.pinch.ts` (lint). The substrate is the one source of truth
 * for subcommand logic.
 */
export function registerCageCommand(program: Command) {
  program
    .command("cage")
    .description(
      "OpenClaw LKG (Last-Known-Good) substrate — promote / observe / rollback workspace state, with labeled pins for upgrade recovery (closes #14526). Run `openclaw cage help` for subcommands.",
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async () => {
      const idx = process.argv.indexOf("cage");
      const cageArgs = idx >= 0 ? process.argv.slice(idx + 1) : [];
      const { runCli } = await import("@openclaw/lkg/cli");
      const code = await runCli(cageArgs);
      process.exit(code);
    });
}
