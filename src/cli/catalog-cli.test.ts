import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerCatalogCli } from "./catalog-cli.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  });
  registerCatalogCli(program);
  return program;
}

async function captureStdout(run: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("catalog cli", () => {
  it("prints catalog list JSON", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "list", "--json"]);
    });

    const parsed = JSON.parse(output) as { surfaceCount: number; surfaces: Array<{ id: string }> };
    expect(parsed.surfaceCount).toBe(5);
    expect(parsed.surfaces.map((surface) => surface.id)).toContain("gateway");
  });

  it("prints catalog list Markdown by default", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "list"]);
    });

    expect(output).toContain("# CLI Catalog Overlay List");
    expect(output).toContain("`gateway`");
  });
});
