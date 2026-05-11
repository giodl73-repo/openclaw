import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluatePolicyTrustedToolCall } from "./runtime-tool-policy.js";

let workspaceDir: string;

function cfg(settings: Record<string, unknown> = {}) {
  return {
    plugins: {
      entries: {
        policy: {
          enabled: true,
          config: { enabled: true, runtimeToolPolicy: true, ...settings },
        },
      },
    },
  };
}

async function evaluate(toolName: string, settings: Record<string, unknown> = {}) {
  return evaluatePolicyTrustedToolCall(
    { toolName, params: {} },
    { toolName },
    {
      cwd: workspaceDir,
      readConfig: () => cfg(settings),
    },
  );
}

describe("policy trusted tool runtime", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-runtime-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does nothing until runtime tool policy is enabled", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { settings: { runtimeToolPolicy: true, requireRisk: true } } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy", { runtimeToolPolicy: false })).resolves.toBeUndefined();
  });

  it("blocks when the enabled runtime policy file is missing", async () => {
    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy tool runtime is enabled, but policy.jsonc is missing.",
    });
  });

  it("blocks tool calls whose required metadata is missing", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy requires risk metadata for 'deploy', but TOOLS.md does not declare it.",
    });
  });

  it("requires approval for critical or irreversible tools", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critical sensitivity:internal IRREVERSIBLE_EXTERNAL\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toMatchObject({
      requireApproval: {
        title: "Review policy-governed tool",
        severity: "critical",
      },
    });
  });

  it("allows declared low-risk tools without a runtime decision", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### inspect risk:low sensitivity:public\n",
      "utf-8",
    );

    await expect(evaluate("inspect")).resolves.toBeUndefined();
  });
});
