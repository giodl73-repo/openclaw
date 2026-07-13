import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { resetManagedConfigIOForTest } from "../../config/layer-io.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  setManagedConfigWritesBlocked,
} from "../../config/nix-mode-write-guard.js";
import { loadGatewayStartupConfigSnapshot } from "../../gateway/server-startup-config.js";
import {
  createManagedGatewayConfigController,
  parseManagedGatewayConfigLayers,
  resetManagedGatewayConfigForTest,
} from "./managed-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setManagedConfigWritesBlocked(false);
  resetManagedGatewayConfigForTest();
  resetManagedConfigIOForTest();
  resetConfigRuntimeState();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("managed Gateway configuration", () => {
  it("preserves generic declaration order as a read-only startup chain", () => {
    const descriptors = parseManagedGatewayConfigLayers({
      configLayer: ["first=/etc/openclaw/global.json", "second=~/operator.json"],
    });

    expect(descriptors?.map(({ id, access }) => ({ id, access }))).toEqual([
      { id: "first", access: "read-only" },
      { id: "second", access: "read-only" },
    ]);
    expect(descriptors?.map(({ source }) => source.identity)).toEqual([
      "managed-config:first",
      "managed-config:second",
    ]);
  });

  it("rejects ambiguous layer declarations", () => {
    expect(() =>
      parseManagedGatewayConfigLayers({
        configLayer: ["same=/one.json", "same=/two.json"],
      }),
    ).toThrow("duplicate managed configuration layer id");
  });

  it("boots the Gateway startup loader from a composed three-file snapshot", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-gateway-"));
    temporaryDirectories.push(directory);
    const globalPath = path.join(directory, "scout-global.json");
    const tenantPath = path.join(directory, "tenant-network.json");
    const operatorPath = path.join(directory, "operator.json");
    await fs.writeFile(globalPath, JSON.stringify({ gateway: { mode: "local" } }));
    await fs.writeFile(
      tenantPath,
      JSON.stringify({
        gateway: { controlUi: { allowedOrigins: ["https://tenant.example"] } },
      }),
    );
    await fs.writeFile(operatorPath, JSON.stringify({ gateway: { port: 18789 } }));

    const controller = createManagedGatewayConfigController({
      opts: {
        configLayer: [
          `scout-global=${globalPath}`,
          `tenant-network=${tenantPath}`,
          `operator=${operatorPath}`,
        ],
      },
      configIO: {
        configPath: operatorPath,
        homedir: () => directory,
        env: {},
        lowerPrecedenceEnv: {},
        observe: false,
      },
    });
    expect(() => assertConfigWriteAllowedInCurrentMode({ configPath: operatorPath })).toThrow(
      "read-only managed configuration startup mode",
    );
    await expect(controller?.previewSourceConfig()).resolves.toMatchObject({ valid: true });
    const activation = await controller?.activate();
    expect(activation?.valid).toBe(true);
    if (!activation?.valid) {
      throw new Error("expected managed configuration activation to succeed");
    }

    const startup = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: true,
      log: { info: vi.fn(), warn: vi.fn() },
      initialSnapshotRead: activation.startupConfigSnapshotRead,
    });
    expect(startup.snapshot.config.gateway).toMatchObject({
      mode: "local",
      port: 18789,
      controlUi: { allowedOrigins: ["https://tenant.example"] },
    });
  });
});
