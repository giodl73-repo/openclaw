import type { Command } from "commander";
import { buildCatalogAudit, renderCatalogAuditMarkdown } from "../cli-catalog-overlay/audit.js";
import { buildCatalogList, renderCatalogListMarkdown } from "../cli-catalog-overlay/list.js";
import {
  buildCatalogTestMatrix,
  renderCatalogTestMatrixMarkdown,
} from "../cli-catalog-overlay/test-matrix.js";

export function registerCatalogCli(program: Command): void {
  const catalog = program.command("catalog").description("Inspect OpenClaw catalog metadata");

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
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(buildCatalogList(), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${renderCatalogListMarkdown()}\n`);
    });

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
        process.stdout.write(`${JSON.stringify(buildCatalogAudit(), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${renderCatalogAuditMarkdown()}\n`);
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
        process.stdout.write(`${JSON.stringify(buildCatalogTestMatrix(), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${renderCatalogTestMatrixMarkdown()}\n`);
    });
}
