import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  const [
    { resetConfigRuntimeState },
    { resetManagedConfigIOForTest },
    { setManagedConfigWritesBlocked },
    managedConfig,
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/layer-io.js"),
    import("../../config/nix-mode-write-guard.js"),
    import("./managed-config.js"),
  ]);
  managedConfig.resetManagedGatewayConfigForTest();
  setManagedConfigWritesBlocked(false);
  resetManagedConfigIOForTest();
  resetConfigRuntimeState();
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("managed Gateway bootstrap", () => {
  it("hands the exact rechecked three-layer snapshot to Gateway startup", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-bootstrap-"));
    const globalPath = path.join(temporaryDirectory, "scout-global.json");
    const tenantPath = path.join(temporaryDirectory, "tenant-network.json");
    const operatorPath = path.join(temporaryDirectory, "operator.json");
    const statePath = path.join(temporaryDirectory, "state");
    await Promise.all([
      fs.writeFile(globalPath, JSON.stringify({ gateway: { mode: "local" } })),
      fs.writeFile(
        tenantPath,
        JSON.stringify({
          gateway: { controlUi: { allowedOrigins: ["https://tenant.example"] } },
        }),
      ),
      fs.writeFile(operatorPath, JSON.stringify({ gateway: { port: 18789 } })),
    ]);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", operatorPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", statePath);

    const opts = {
      configLayer: [
        `scout-global=${globalPath}`,
        `tenant-network=${tenantPath}`,
        `operator=${operatorPath}`,
      ],
      force: false,
      reset: false,
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code): never => {
        throw new Error(`unexpected exit ${code}`);
      }),
    };
    const [{ prepareGatewayRunBootstrap, recheckGatewayRunBootstrap }, managedConfig] =
      await Promise.all([import("./pre-bootstrap.js"), import("./managed-config.js")]);

    await expect(prepareGatewayRunBootstrap({ opts, runtime })).resolves.toBe(true);
    const firstCheckpoint = await recheckGatewayRunBootstrap({ opts, runtime });
    const secondCheckpoint = await recheckGatewayRunBootstrap({ opts, runtime });
    expect(firstCheckpoint).not.toBe(true);
    expect(secondCheckpoint).not.toBe(true);
    if (typeof firstCheckpoint === "boolean" || typeof secondCheckpoint === "boolean") {
      throw new Error("expected managed checkpoints to return snapshots");
    }
    expect(firstCheckpoint.config.gateway).toMatchObject({
      mode: "local",
      port: 18789,
      controlUi: { allowedOrigins: ["https://tenant.example"] },
    });
    expect(secondCheckpoint.config.gateway).toMatchObject(firstCheckpoint.config.gateway ?? {});

    const prepared = managedConfig.takePreparedManagedGatewaySnapshotRead();
    expect(prepared?.snapshot.config.gateway).toMatchObject({
      mode: "local",
      port: 18789,
      controlUi: { allowedOrigins: ["https://tenant.example"] },
    });
    expect(managedConfig.takePreparedManagedGatewaySnapshotRead()).toBeUndefined();
  });

  it("rejects a layer replacement between preview and activation", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-bootstrap-"));
    const globalPath = path.join(temporaryDirectory, "global.json");
    const operatorPath = path.join(temporaryDirectory, "operator.json");
    await Promise.all([
      fs.writeFile(globalPath, JSON.stringify({ gateway: { mode: "local" } })),
      fs.writeFile(operatorPath, JSON.stringify({ gateway: { port: 18789 } })),
    ]);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", operatorPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(temporaryDirectory, "state"));
    const { createManagedGatewayConfigController } = await import("./managed-config.js");
    const controller = createManagedGatewayConfigController({
      opts: {
        configLayer: [`global=${globalPath}`, `operator=${operatorPath}`],
      },
    });
    await expect(controller?.previewSourceConfig()).resolves.toMatchObject({ valid: true });
    await fs.writeFile(
      globalPath,
      JSON.stringify({
        meta: { lastTouchedVersion: "9999.0.0" },
        gateway: { mode: "local" },
      }),
    );

    const activation = await controller?.activate();
    expect(activation?.valid).toBe(false);
    if (activation?.valid !== false) {
      throw new Error("expected changed managed source activation to fail");
    }
    expect(JSON.stringify(activation.findings)).toContain("changed after metadata inspection");
  });

  it("rejects future-version metadata from any managed layer", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-bootstrap-"));
    const globalPath = path.join(temporaryDirectory, "global.json");
    const operatorPath = path.join(temporaryDirectory, "operator.json");
    await Promise.all([
      fs.writeFile(
        globalPath,
        JSON.stringify({
          meta: { lastTouchedVersion: "9999.0.0" },
          gateway: { mode: "local" },
        }),
      ),
      fs.writeFile(operatorPath, JSON.stringify({ gateway: { port: 18789 } })),
    ]);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", operatorPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(temporaryDirectory, "state"));
    const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { prepareGatewayRunBootstrap } = await import("./pre-bootstrap.js");

    await expect(
      prepareGatewayRunBootstrap({
        opts: {
          configLayer: [`global=${globalPath}`, `operator=${operatorPath}`],
          force: false,
          reset: false,
        },
        runtime,
      }),
    ).resolves.toBe(false);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("9999.0.0"));
  });
});
