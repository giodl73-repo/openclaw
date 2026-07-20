// Backup command registration for local archive creation, verification, retrieval, and materialization.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  backupActivateManagedCommand,
  managedRestoreRequestFailure,
  readManagedRestoreRequestFromStdin,
} from "../../commands/backup-activate-managed.js";
import { backupMaterializeCommand } from "../../commands/backup-materialize.js";
import { backupPlanRestoreCommand } from "../../commands/backup-plan-restore.js";
import { backupRetrieveCommand } from "../../commands/backup-retrieve.js";
import { backupVerifyCommand } from "../../commands/backup-verify.js";
import { backupCreateCommand } from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

/** Register local backup and continuity recovery subcommands. */
export function registerBackupCommand(program: Command) {
  const backup = program
    .command("backup")
    .description("Create, verify, retrieve, materialize, plan, and activate OpenClaw recovery")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`,
    );

  backup
    .command("create")
    .description("Write a backup archive for config, credentials, sessions, and workspaces")
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--verify", "Verify the archive after writing it", false)
    .option("--only-config", "Back up only the active JSON config file", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw backup create", "Create a timestamped backup in the current directory."],
          [
            "openclaw backup create --output ~/Backups",
            "Write the archive into an existing backup directory.",
          ],
          [
            "openclaw backup create --dry-run --json",
            "Preview the archive plan without writing any files.",
          ],
          [
            "openclaw backup create --verify",
            "Create the archive and immediately validate its manifest and payload layout.",
          ],
          [
            "openclaw backup create --no-include-workspace",
            "Back up state/config without agent workspace files.",
          ],
          ["openclaw backup create --only-config", "Back up only the active JSON config file."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          verify: Boolean(opts.verify),
          onlyConfig: Boolean(opts.onlyConfig),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });

  backup
    .command("verify <archive>")
    .description("Validate a backup archive and its embedded manifest")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz",
            "Check that the archive structure and manifest are intact.",
          ],
          [
            "openclaw backup verify ~/Backups/latest.tar.gz --json",
            "Emit machine-readable verification output.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupVerifyCommand(defaultRuntime, {
          archive: archive as string,
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("retrieve <archive>")
    .description("Verify and retrieve a backup into a new staging directory")
    .requiredOption("--destination <path>", "New staging directory (must not exist)")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup retrieve ./backup.tar.gz --destination ./restored",
            "Verify and extract a backup into a non-active staging directory.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupRetrieveCommand(defaultRuntime, {
          archive: archive as string,
          destination: opts.destination as string,
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("materialize <archive>")
    .description("Materialize a continuity archive into a new offline filesystem root")
    .requiredOption("--destination <path>", "New offline filesystem root (must not exist)")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup materialize ./continuity.tar.gz --destination ./offline-root",
            "Verify and materialize continuity components without activating live state.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupMaterializeCommand(defaultRuntime, {
          archive: archive as string,
          destination: opts.destination as string,
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("activate")
    .description("Execute a launcher-fenced managed continuity restore")
    .requiredOption("--managed", "Require immutable launcher-managed restore context")
    .requiredOption("--json", "Emit the typed restore result as JSON")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        let request: string;
        try {
          request = await readManagedRestoreRequestFromStdin();
        } catch (error) {
          managedRestoreRequestFailure(defaultRuntime, error, { json: true });
          return;
        }
        await backupActivateManagedCommand(defaultRuntime, request, { json: true });
      });
    });

  backup
    .command("plan-restore <archive>")
    .description("Preview exact continuity restore targets without changing them")
    .requiredOption("--materialized <path>", "Verified offline materialization root")
    .requiredOption(
      "--authorize <path...>",
      "Exact publication roots independently authorized for restore",
    )
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup plan-restore ./continuity.tar.gz --materialized ./offline-root --authorize ~/.openclaw ~/.openclaw.json",
            "Verify and preview exact restore targets without writing them.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupPlanRestoreCommand(defaultRuntime, {
          archive: archive as string,
          materialized: opts.materialized as string,
          authorize: opts.authorize as string[],
          json: Boolean(opts.json),
        });
      });
    });
}
