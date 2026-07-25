// Durable Skill Memory query command registration.
import type { Command } from "commander";
import { skillMemoryCommand, type SkillMemoryCommandOptions } from "../../commands/skill-memory.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the local memory get/list/count surface. */
export function registerSkillMemoryCommand(program: Command): void {
  program
    .command("skill-memory")
    .description("Recall completed work remembered by trusted tools")
    .option("--id <memory-id>", "Get one full memory by id")
    .option("--count", "Count matching memories", false)
    .option("--type <type>", "Filter by exact remembered fact type")
    .option("--subject-type <type>", "Filter by exact subject type")
    .option("--subject-id <id>", "Filter by exact subject id")
    .option("--agent <ids>", "Filter by comma-separated agent ids")
    .option("--session <key>", "Filter by exact session key")
    .option("--run <id>", "Filter by exact run id")
    .option("--limit <count>", "Maximum memories (1-500)")
    .option("--cursor <sequence>", "Continue a previous newest-first list")
    .option("--json", "Output full JSON memories", false)
    .action(async (opts: SkillMemoryCommandOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await skillMemoryCommand(opts, defaultRuntime);
      });
    });
}
