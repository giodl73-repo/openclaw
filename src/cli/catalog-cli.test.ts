import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import type { PluginCliDescriptorEntry } from "../plugins/cli-registry-loader.js";
import { registerCatalogCli } from "./catalog-cli.js";

const loadPluginCliDescriptorEntriesMock = vi.hoisted(() =>
  vi.fn<() => Promise<PluginCliDescriptorEntry[]>>(async () => []),
);

vi.mock("../plugins/cli-registry-loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/cli-registry-loader.js")>();
  return {
    ...original,
    loadPluginCliDescriptorEntries: loadPluginCliDescriptorEntriesMock,
  };
});

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
  afterEach(() => {
    loadPluginCliDescriptorEntriesMock.mockReset();
    loadPluginCliDescriptorEntriesMock.mockResolvedValue([]);
  });

  it("prints catalog list JSON", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "list", "--json"]);
    });

    const parsed = JSON.parse(output) as {
      counts: {
        commandDescriptors: number;
        routedOperations: number;
        runtimeCommands: number;
        pluginCommands: number;
      };
      cli: { runtimeCommandScope: string };
      agentToolSurfaces: Array<{ id: string }>;
    };
    expect(parsed.counts.commandDescriptors).toBe(58);
    expect(parsed.counts.routedOperations).toBe(14);
    expect(parsed.counts.runtimeCommands).toBeGreaterThan(0);
    expect(parsed.cli.runtimeCommandScope).toBe("current-invocation-registered-tree");
    expect(parsed.counts.pluginCommands).toBe(0);
    expect(parsed.agentToolSurfaces.map((surface) => surface.id)).toContain("gateway");
  });

  it("prints catalog list Markdown by default", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "list"]);
    });

    expect(output).toContain("# CLI Catalog Overlay List");
    expect(output).toContain("`gateway-status`");
    expect(output).toContain("`gateway`");
    expect(output).toContain("## Runtime registered commands");
  });

  it("routes plugin descriptor loading logs away from JSON stdout", async () => {
    const forceStderrSnapshots: boolean[] = [];
    loadPluginCliDescriptorEntriesMock.mockImplementationOnce(async () => {
      forceStderrSnapshots.push(loggingState.forceConsoleToStderr);
      return [
        {
          pluginId: "example-plugin",
          parentPath: [],
          descriptors: [
            { name: "example", description: "Example plugin command", hasSubcommands: false },
          ],
        },
      ];
    });

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "catalog",
        "list",
        "--json",
        "--plugin-descriptors",
      ]);
    });

    expect(forceStderrSnapshots).toEqual([true]);
    expect(JSON.parse(output).counts.pluginCommands).toBe(1);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("prints catalog audit, test matrix, and summary JSON", async () => {
    const audit = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "audit", "--json"]);
    });
    const matrix = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "test-matrix", "--json"]);
    });
    const summary = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "catalog", "summary", "--json"]);
    });

    expect(JSON.parse(audit).counts.commandRoutes).toBe(94);
    expect(JSON.parse(matrix).counts.routedOperations).toBe(14);
    expect(JSON.parse(summary).counts.coverageGaps).toBeGreaterThan(0);
  });
});
