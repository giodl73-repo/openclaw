import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const tempDirs: string[] = [];

async function createLegacyPluginManifest(): Promise<{
  cfg: OpenClawConfig;
  manifestPath: string;
}> {
  const fixturesRoot = path.join(process.cwd(), "dist", "extensions");
  await fs.mkdir(fixturesRoot, { recursive: true });
  const pluginsRoot = await fs.mkdtemp(path.join(fixturesRoot, "openclaw-legacy-plugin-manifest-"));
  tempDirs.push(pluginsRoot);
  const pluginRoot = path.join(pluginsRoot, "openai");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/test-plugin",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.ts"],
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await fs.writeFile(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf-8");
  const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        id: "openai",
        providers: ["openai"],
        speechProviders: ["openai"],
        contracts: {
          webSearchProviders: ["gemini"],
        },
        configSchema: { type: "object" },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return {
    cfg: {
      plugins: {
        load: {
          paths: [pluginsRoot],
        },
      },
    },
    manifestPath,
  };
}

describe("doctor legacy plugin manifest repair", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("rewrites legacy manifest contract keys through the structured health check", async () => {
    const { cfg, manifestPath } = await createLegacyPluginManifest();
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/legacy-plugin-manifests",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/legacy-plugin-manifests",
        message: expect.stringContaining("Legacy plugin manifest capability keys detected"),
        path: manifestPath,
      }),
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg,
        },
        findings ?? [],
      ),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("moved speechProviders to contracts.speechProviders")],
      warnings: [],
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg,
        },
        { findings },
      ),
    ).resolves.toEqual([]);

    const persisted = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      speechProviders?: string[];
      contracts?: Record<string, string[]>;
    };
    expect(persisted.speechProviders).toBeUndefined();
    expect(persisted.contracts).toEqual({
      speechProviders: ["openai"],
      webSearchProviders: ["gemini"],
    });
  });
});
