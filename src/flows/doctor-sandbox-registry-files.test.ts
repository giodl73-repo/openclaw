import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const mocks = vi.hoisted(() => ({
  inspections: [
    {
      kind: "containers" as const,
      registryPath: "/tmp/openclaw/sandbox/containers.json",
      shardedDir: "/tmp/openclaw/sandbox/containers",
      exists: true,
      valid: true,
      entries: 2,
    },
  ],
  inspectLegacySandboxRegistryFiles: vi.fn(),
  migrateLegacySandboxRegistryFiles: vi.fn(),
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  inspectLegacySandboxRegistryFiles: mocks.inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles: mocks.migrateLegacySandboxRegistryFiles,
}));

describe("doctor sandbox registry file repair", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("migrates legacy registry files through the structured health check", async () => {
    mocks.inspections = [
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        exists: true,
        valid: true,
        entries: 2,
      },
    ];
    mocks.inspectLegacySandboxRegistryFiles.mockImplementation(async () => mocks.inspections);
    mocks.migrateLegacySandboxRegistryFiles.mockImplementation(async () => {
      mocks.inspections = [];
      return [
        {
          kind: "containers",
          registryPath: "/tmp/openclaw/sandbox/containers.json",
          shardedDir: "/tmp/openclaw/sandbox/containers",
          status: "migrated",
          entries: 2,
        },
      ];
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/sandbox/registry-files",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg: {},
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/sandbox/registry-files",
        message: expect.stringContaining("Legacy sandbox registry file detected"),
        path: "/tmp/openclaw/sandbox/containers.json",
      }),
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg: {},
        },
        findings ?? [],
      ),
    ).resolves.toMatchObject({
      changes: [
        "- Migrated containers registry from /tmp/openclaw/sandbox/containers.json into 2 shards.",
      ],
      warnings: [],
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg: {},
        },
        { findings },
      ),
    ).resolves.toEqual([]);
  });
});
