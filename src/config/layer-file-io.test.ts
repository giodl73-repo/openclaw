import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { setRuntimeConfigSnapshotRefreshHandler } from "./io.js";
import {
  createLocalFileManagedConfigIO,
  parseLocalConfigLayerSource,
  resolveLocalConfigLayerSource,
  type LocalConfigLayerSource,
} from "./layer-file-io.js";
import { resetManagedConfigIOForTest } from "./layer-io.js";
import { identifyAuthorityChain } from "./layer-management.js";
import { resolveConfigLayerSources, type ConfigLayerDescriptor } from "./layer-sources.js";

beforeEach(() => {
  resetManagedConfigIOForTest();
  setRuntimeConfigSnapshotRefreshHandler(null);
});

describe("local-file managed config I/O", () => {
  it("persists the writable primary layer through existing config I/O", async () => {
    await withTempDir({ prefix: "openclaw-managed-files-" }, async (home) => {
      const managedPath = path.join(home, "managed.json");
      const operatorPath = path.join(home, "openclaw.json");
      await fs.writeFile(
        managedPath,
        JSON.stringify({
          gateway: { mode: "local" },
          meta: { lastTouchedAt: "2026-01-01T00:00:00.000Z" },
        }),
      );
      await fs.writeFile(
        operatorPath,
        JSON.stringify({
          gateway: { port: 19001 },
          logging: { level: "${LOG_LEVEL}" },
          meta: { lastTouchedAt: "2026-02-01T00:00:00.000Z" },
        }),
      );
      const descriptors: ConfigLayerDescriptor<LocalConfigLayerSource>[] = [
        {
          id: "managed",
          source: { path: managedPath, identity: "managed:global" },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "operator",
          source: { path: operatorPath, identity: "operator:primary" },
          access: "read-write",
          contractVersion: 1,
        },
      ];
      const resolved = await resolveConfigLayerSources(
        descriptors,
        resolveLocalConfigLayerSource,
        parseLocalConfigLayerSource,
      );
      if (!resolved.valid) {
        throw new Error("fixture did not resolve");
      }
      const publish = vi.fn();
      const preflight = vi.fn(({ sourceConfig }) => {
        if (sourceConfig.gateway?.mode !== "local") {
          throw new Error("composed gateway mode is missing");
        }
      });
      setRuntimeConfigSnapshotRefreshHandler({ preflight, refresh: () => true });
      const io = createLocalFileManagedConfigIO({
        descriptors,
        publish,
        configIO: {
          configPath: operatorPath,
          homedir: () => home,
          env: { HOME: home, LOG_LEVEL: "debug" },
          observe: false,
        },
      });
      const result = await io.write({
        targetLayerId: "operator",
        proposedContent: JSON.stringify({
          gateway: { port: 19002 },
          logging: { level: "debug" },
        }),
        expectedTargetDigest: resolved.layers[1].contentDigest,
        expectedAuthorityChainIdentity: identifyAuthorityChain(resolved.layers),
      });
      if (!result.valid) {
        throw new Error(JSON.stringify(result.findings));
      }
      expect(result).toMatchObject({ valid: true });
      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceConfig: expect.objectContaining({
            gateway: expect.objectContaining({ mode: "local", port: 19002 }),
          }),
        }),
      );
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceConfig: expect.not.objectContaining({ meta: expect.anything() }),
        }),
      );
      const persisted = JSON.parse(await fs.readFile(operatorPath, "utf8"));
      expect(persisted.gateway.port).toBe(19002);
      expect(persisted.meta.lastTouchedAt).toEqual(expect.any(String));
      expect(persisted.logging).toEqual({ level: "debug" });
      if (!result.valid) {
        throw new Error("write unexpectedly failed");
      }
      expect(result.candidate.layers[1].contentDigest).not.toBe(resolved.layers[1].contentDigest);
    });
  });

  it("persists a sparse layer that is valid only in the composed chain", async () => {
    await withTempDir({ prefix: "openclaw-managed-files-" }, async (home) => {
      const managedPath = path.join(home, "managed.json");
      const operatorPath = path.join(home, "openclaw.json");
      await fs.writeFile(
        managedPath,
        JSON.stringify({ gateway: { mode: "local", channelHealthCheckMinutes: 1 } }),
      );
      await fs.writeFile(
        operatorPath,
        JSON.stringify({
          gateway: { mode: "local", channelStaleEventThresholdMinutes: 3 },
          env: { PADDING: "x".repeat(600) },
        }),
      );
      const descriptors: ConfigLayerDescriptor<LocalConfigLayerSource>[] = [
        {
          id: "managed",
          source: { path: managedPath, identity: "managed:global" },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "operator",
          source: { path: operatorPath, identity: "operator:primary" },
          access: "read-write",
          contractVersion: 1,
        },
      ];
      const resolved = await resolveConfigLayerSources(
        descriptors,
        resolveLocalConfigLayerSource,
        parseLocalConfigLayerSource,
      );
      if (!resolved.valid) {
        throw new Error("fixture did not resolve");
      }
      const io = createLocalFileManagedConfigIO({
        descriptors,
        publish: vi.fn(),
        configIO: {
          configPath: operatorPath,
          homedir: () => home,
          env: { HOME: home },
          observe: false,
        },
      });

      const result = await io.write({
        targetLayerId: "operator",
        proposedContent: JSON.stringify({
          gateway: { channelStaleEventThresholdMinutes: 4 },
        }),
        expectedTargetDigest: resolved.layers[1].contentDigest,
        expectedAuthorityChainIdentity: identifyAuthorityChain(resolved.layers),
      });

      if (!result.valid) {
        throw new Error(JSON.stringify(result.findings));
      }
      expect(result).toMatchObject({ valid: true });
      const persisted = JSON.parse(await fs.readFile(operatorPath, "utf8"));
      expect(persisted.gateway).toMatchObject({ channelStaleEventThresholdMinutes: 4 });
      expect(persisted.gateway.mode).toBeUndefined();
      expect(persisted.gateway.channelHealthCheckMinutes).toBeUndefined();
      expect(persisted.env).toBeUndefined();
    });
  });

  it("resolves ordinary includes before managed activation", async () => {
    await withTempDir({ prefix: "openclaw-managed-files-" }, async (home) => {
      const gatewayPath = path.join(home, "gateway.json");
      const managedPath = path.join(home, "managed.json");
      const operatorPath = path.join(home, "openclaw.json");
      await fs.writeFile(gatewayPath, JSON.stringify({ mode: "local" }));
      await fs.writeFile(
        managedPath,
        JSON.stringify({
          env: { TENANT_ORIGIN: "https://tenant.example" },
          gateway: { $include: gatewayPath },
        }),
      );
      await fs.writeFile(
        operatorPath,
        JSON.stringify({
          gateway: {
            port: 19001,
            controlUi: { allowedOrigins: ["${TENANT_ORIGIN}"] },
          },
        }),
      );
      const descriptors: ConfigLayerDescriptor<LocalConfigLayerSource>[] = [
        {
          id: "managed",
          source: { path: managedPath, identity: "managed:included" },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "operator",
          source: { path: operatorPath, identity: "operator:primary" },
          access: "read-write",
          contractVersion: 1,
        },
      ];
      const resolved = await resolveConfigLayerSources(
        descriptors,
        resolveLocalConfigLayerSource,
        parseLocalConfigLayerSource,
      );
      if (!resolved.valid) {
        throw new Error("fixture did not resolve");
      }
      expect(resolved.layers[0].config).toMatchObject({ gateway: { mode: "local" } });
      const authorityChainIdentity = identifyAuthorityChain(resolved.layers);
      const publish = vi.fn();
      const io = createLocalFileManagedConfigIO({
        descriptors,
        publish,
        configIO: {
          configPath: operatorPath,
          homedir: () => home,
          env: { HOME: home },
          observe: false,
        },
      });
      await expect(io.activate()).resolves.toMatchObject({
        valid: true,
        candidate: {
          sourceConfig: {
            env: { TENANT_ORIGIN: "https://tenant.example" },
            gateway: {
              mode: "local",
              port: 19001,
              controlUi: { allowedOrigins: ["https://tenant.example"] },
            },
          },
        },
      });
      expect(publish).toHaveBeenCalledTimes(1);

      await fs.writeFile(gatewayPath, JSON.stringify({ mode: "local", port: 19002 }));
      await expect(
        io.write({
          targetLayerId: "operator",
          proposedContent: JSON.stringify({ gateway: { port: 19001 } }),
          expectedTargetDigest: resolved.layers[1].contentDigest,
          expectedAuthorityChainIdentity: authorityChainIdentity,
        }),
      ).resolves.toMatchObject({
        valid: false,
        findings: [{ reason: "StaleAuthorityChain" }],
      });
    });
  });

  it("rejects a non-object local layer document after include resolution", async () => {
    await withTempDir({ prefix: "openclaw-managed-files-" }, async (home) => {
      const includedPath = path.join(home, "included.json");
      const managedPath = path.join(home, "managed.json");
      await fs.writeFile(includedPath, JSON.stringify(["not", "a", "config"]));
      await fs.writeFile(managedPath, JSON.stringify({ $include: includedPath }));
      const io = createLocalFileManagedConfigIO({
        descriptors: [
          {
            id: "managed",
            source: { path: managedPath, identity: "managed:invalid" },
            access: "read-only",
            contractVersion: 1,
          },
        ],
        publish: vi.fn(),
        configIO: { homedir: () => home, env: { HOME: home }, observe: false },
      });

      await expect(io.activate()).resolves.toMatchObject({
        valid: false,
        findings: [{ reason: "LayerSourceParseFailed", layer: "managed" }],
      });
    });
  });

  it("rejects a writable source that is not the primary config", async () => {
    await withTempDir({ prefix: "openclaw-managed-files-" }, async (home) => {
      const managedPath = path.join(home, "managed.json");
      const operatorPath = path.join(home, "operator.json");
      await fs.writeFile(managedPath, JSON.stringify({ gateway: { mode: "local" } }));
      await fs.writeFile(operatorPath, JSON.stringify({ gateway: { port: 19001 } }));
      const descriptors: ConfigLayerDescriptor<LocalConfigLayerSource>[] = [
        {
          id: "managed",
          source: { path: managedPath, identity: "managed:global" },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "operator",
          source: { path: operatorPath, identity: "operator:secondary" },
          access: "read-write",
          contractVersion: 1,
        },
      ];
      const resolved = await resolveConfigLayerSources(
        descriptors,
        resolveLocalConfigLayerSource,
        parseLocalConfigLayerSource,
      );
      if (!resolved.valid) {
        throw new Error("fixture did not resolve");
      }
      const io = createLocalFileManagedConfigIO({
        descriptors,
        publish: vi.fn(),
        configIO: {
          configPath: path.join(home, "openclaw.json"),
          homedir: () => home,
          env: { HOME: home },
          observe: false,
        },
      });
      await expect(
        io.write({
          targetLayerId: "operator",
          proposedContent: JSON.stringify({ gateway: { port: 19002 } }),
          expectedTargetDigest: resolved.layers[1].contentDigest,
          expectedAuthorityChainIdentity: identifyAuthorityChain(resolved.layers),
        }),
      ).resolves.toMatchObject({ valid: false, findings: [{ reason: "LayerPersistenceFailed" }] });
    });
  });
});
