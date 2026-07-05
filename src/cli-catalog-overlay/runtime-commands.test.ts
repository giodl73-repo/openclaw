import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildCatalogList } from "./list.js";
import { collectRuntimeCommandTree } from "./runtime-commands.js";

describe("runtime command catalog", () => {
  it("enumerates the currently registered Commander tree", () => {
    const program = new Command();
    program.command("alpha").description("Alpha command").alias("a");
    program
      .command("beta")
      .description("Beta command")
      .command("child")
      .description("Nested child");
    program
      .command("secret", { hidden: true })
      .description("Hidden command")
      .command("child")
      .description("Hidden child");

    const runtimeCommands = collectRuntimeCommandTree(program);

    expect(runtimeCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandPath: ["alpha"],
          aliases: ["a"],
          discoveryMode: "runtime-registered",
          sourceKind: "runtime",
        }),
        expect.objectContaining({ commandPath: ["beta", "child"] }),
      ]),
    );
    expect(runtimeCommands.map((command) => command.commandPath)).not.toContainEqual(["secret"]);
    expect(runtimeCommands.map((command) => command.commandPath)).not.toContainEqual([
      "secret",
      "child",
    ]);
    expect(buildCatalogList({ runtimeCommands }).counts.runtimeCommands).toBe(3);
  });
});
