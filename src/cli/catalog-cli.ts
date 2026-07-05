import type { Command } from "commander";
import { buildCatalogList, renderCatalogListMarkdown } from "../cli-catalog-overlay/list.js";
import { collectRuntimeCommandTree } from "../cli-catalog-overlay/runtime-commands.js";

export function registerCatalogCli(program: Command): void {
  const catalog = program.command("catalog").description("List OpenClaw catalog metadata");

  catalog
    .command("list")
    .description("List AI-routable command and tool surfaces")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .action((opts: { json?: boolean; markdown?: boolean }, command: Command) => {
      if (opts.json && opts.markdown) {
        command.error("error: --json and --markdown cannot be combined");
        return;
      }
      const runtimeCommands = collectRuntimeCommandTree(program);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(buildCatalogList({ runtimeCommands }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${renderCatalogListMarkdown({ runtimeCommands })}\n`);
    });
}
