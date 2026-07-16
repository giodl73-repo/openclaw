// Durable typed outcome receipt query command registration.
import type { Command } from "commander";
import { receiptsCommand, type ReceiptsCommandOptions } from "../../commands/receipts.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the local receipt get/list/count surface. */
export function registerReceiptsCommand(program: Command): void {
  program
    .command("receipts")
    .description("Find and count durable typed outcomes recorded by trusted tools")
    .option("--id <receipt-id>", "Get one full receipt by id")
    .option("--count", "Count matching receipts", false)
    .option("--type <type>", "Filter by exact outcome type")
    .option("--subject-type <type>", "Filter by exact subject type")
    .option("--subject-id <id>", "Filter by exact subject id")
    .option("--agent <ids>", "Filter by comma-separated agent ids")
    .option("--session <key>", "Filter by exact session key")
    .option("--run <id>", "Filter by exact run id")
    .option("--limit <count>", "Maximum receipts (1-500)")
    .option("--cursor <sequence>", "Continue a previous newest-first list")
    .option("--json", "Output full JSON receipts", false)
    .action(async (opts: ReceiptsCommandOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await receiptsCommand(opts, defaultRuntime);
      });
    });
}
