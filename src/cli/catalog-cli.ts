import type { Command } from "commander";
import { buildCatalogAudit, renderCatalogAuditMarkdown } from "../cli-catalog-overlay/audit.js";
import { buildCatalogList, renderCatalogListMarkdown } from "../cli-catalog-overlay/list.js";
import {
  buildCatalogOperatorSummary,
  renderCatalogOperatorSummaryMarkdown,
} from "../cli-catalog-overlay/operator-summary.js";
import { buildPluginCatalogCommands } from "../cli-catalog-overlay/plugin-commands.js";
import { collectRuntimeCommandTree } from "../cli-catalog-overlay/runtime-commands.js";
import {
  buildCatalogTestMatrix,
  renderCatalogTestMatrixMarkdown,
} from "../cli-catalog-overlay/test-matrix.js";
import { loadPluginCliDescriptorEntries } from "../plugins/cli-registry-loader.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export function registerCatalogCli(program: Command): void {
  const catalog = program.command("catalog").description("List OpenClaw catalog metadata");

  catalog
    .command("list")
    .description("List AI-routable command and tool surfaces")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .option("--plugin-descriptors", "Include plugin CLI descriptor metadata", false)
    .action(
      async (
        opts: { json?: boolean; markdown?: boolean; pluginDescriptors?: boolean },
        command: Command,
      ) => {
        if (opts.json && opts.markdown) {
          command.error("error: --json and --markdown cannot be combined");
          return;
        }
        const runtimeCommands = collectRuntimeCommandTree(program);
        const pluginDescriptorEntries = opts.pluginDescriptors
          ? await withConsoleLogsRoutedToStderrForJson(
              opts.json ? ["--json"] : [],
              async () => await loadPluginCliDescriptorEntries({}),
            )
          : [];
        const pluginCommands = buildPluginCatalogCommands(pluginDescriptorEntries);
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(buildCatalogList({ runtimeCommands, pluginCommands }), null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(`${renderCatalogListMarkdown({ runtimeCommands, pluginCommands })}\n`);
      },
    );

  catalog
    .command("audit")
    .description("Group catalog surfaces and routes for read-only audit review")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .action((opts: { json?: boolean; markdown?: boolean }, command: Command) => {
      if (opts.json && opts.markdown) {
        command.error("error: --json and --markdown cannot be combined");
        return;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(buildCatalogAudit(), null, 2)}
`);
        return;
      }
      process.stdout.write(`${renderCatalogAuditMarkdown()}
`);
    });

  catalog
    .command("test-matrix")
    .description("List routed-operation smoke-test candidates and coverage gaps")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .action((opts: { json?: boolean; markdown?: boolean }, command: Command) => {
      if (opts.json && opts.markdown) {
        command.error("error: --json and --markdown cannot be combined");
        return;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(buildCatalogTestMatrix(), null, 2)}
`);
        return;
      }
      process.stdout.write(`${renderCatalogTestMatrixMarkdown()}
`);
    });

  catalog
    .command("summary")
    .description("Summarize catalog inventory for operator and admin review")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .action((opts: { json?: boolean; markdown?: boolean }, command: Command) => {
      if (opts.json && opts.markdown) {
        command.error("error: --json and --markdown cannot be combined");
        return;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(buildCatalogOperatorSummary(), null, 2)}
`);
        return;
      }
      process.stdout.write(`${renderCatalogOperatorSummaryMarkdown()}
`);
    });

  applyParentDefaultHelpAction(catalog);
}
