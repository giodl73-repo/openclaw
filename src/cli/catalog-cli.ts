import type { Command } from "commander";
import { buildCatalogList, renderCatalogListMarkdown } from "../cli-catalog-overlay/list.js";
import { buildPluginCatalogCommands } from "../cli-catalog-overlay/plugin-commands.js";
import { collectRuntimeCommandTree } from "../cli-catalog-overlay/runtime-commands.js";
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

  applyParentDefaultHelpAction(catalog);
}
