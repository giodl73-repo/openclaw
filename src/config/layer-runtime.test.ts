import { describe, expect, it, vi } from "vitest";
import {
  activateLayeredRuntimeConfig,
  prepareLayeredRuntimeConfig,
  projectValidatedConfigOntoDeclaredShape,
} from "./layer-runtime.js";

describe("projectValidatedConfigOntoDeclaredShape", () => {
  it("drops defaults injected below an explicitly declared object", () => {
    expect(
      projectValidatedConfigOntoDeclaredShape(
        { channels: { telegram: {} } },
        { channels: { telegram: { dmPolicy: "pairing", enabled: true } } },
      ),
    ).toEqual({ channels: { telegram: {} } });
  });

  it("retains normalized values only for declared leaves", () => {
    expect(
      projectValidatedConfigOntoDeclaredShape(
        { gateway: { port: "18789" } },
        { gateway: { port: 18789, bind: "loopback" } },
      ),
    ).toEqual({ gateway: { port: 18789 } });
  });

  it("treats declared arrays and null as atomic values", () => {
    expect(
      projectValidatedConfigOntoDeclaredShape(
        { tools: { alsoAllow: ["read"] }, value: null },
        { tools: { alsoAllow: ["read"], deny: [] }, value: null },
      ),
    ).toEqual({ tools: { alsoAllow: ["read"] }, value: null });
  });
});

describe("prepareLayeredRuntimeConfig", () => {
  it("keeps the composed source sparse and materializes one runtime config", () => {
    const result = prepareLayeredRuntimeConfig([
      {
        id: "platform",
        config: {
          gateway: { controlUi: { allowedOrigins: ["https://work.example"] } },
        },
      },
      {
        id: "operator",
        config: { gateway: { controlUi: { enabled: true } } },
      },
    ]);

    expect(result).toMatchObject({
      valid: true,
      sourceConfig: {
        gateway: {
          controlUi: {
            allowedOrigins: ["https://work.example"],
            enabled: true,
          },
        },
      },
      runtimeConfig: {
        gateway: {
          controlUi: {
            allowedOrigins: ["https://work.example"],
            enabled: true,
          },
        },
      },
    });
    if (result.valid) {
      expect(Object.keys(result.sourceConfig)).toEqual(["gateway"]);
      expect(result.runtimeConfig.agents?.defaults).toBeDefined();
    }
  });

  it("resolves the effective source with the managed environment", () => {
    const result = prepareLayeredRuntimeConfig(
      [
        {
          id: "tenant",
          config: { gateway: { controlUi: { allowedOrigins: ["${TENANT_ORIGIN}"] } } },
        },
      ],
      { env: { TENANT_ORIGIN: "https://tenant.example" } },
    );

    expect(result).toMatchObject({
      valid: true,
      sourceConfig: {
        gateway: { controlUi: { allowedOrigins: ["https://tenant.example"] } },
      },
    });
  });

  it("treats alternate authored representations as distinct exact claims", () => {
    const result = prepareLayeredRuntimeConfig([
      {
        id: "first",
        config: { agents: { defaults: { sandbox: { docker: { setupCommand: ["a", "b"] } } } } },
      },
      {
        id: "second",
        config: { agents: { defaults: { sandbox: { docker: { setupCommand: "a\nb" } } } } },
      },
    ]);

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "ControlledByEarlierLayer", layer: "second" }],
    });
  });

  it("does not materialize when exact authority rejects a later layer", () => {
    expect(
      prepareLayeredRuntimeConfig([
        { id: "platform", config: { gateway: { port: 18789 } } },
        { id: "operator", config: { gateway: { port: 19000 } } },
      ]),
    ).toMatchObject({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          controllingLayer: "platform",
          layer: "operator",
        },
      ],
    });
  });

  it("reports schema failures after effective composition", () => {
    expect(
      prepareLayeredRuntimeConfig([{ id: "bad", config: { gateway: { port: "not-a-port" } } }]),
    ).toMatchObject({
      valid: false,
      findings: [{ reason: "InvalidEffectiveConfig" }],
    });
  });

  it("returns a structured rejection for non-cloneable layer values", () => {
    expect(
      prepareLayeredRuntimeConfig([{ id: "bad", config: { value: () => undefined } }]),
    ).toEqual({
      valid: false,
      findings: [
        {
          reason: "InvalidLayerConfig",
          layer: "bad",
          issues: [
            {
              path: "",
              message: "layer document must contain structured-cloneable configuration values",
            },
          ],
        },
      ],
    });
  });

  it("evaluates cross-field constraints only after sparse layers compose", () => {
    const result = prepareLayeredRuntimeConfig([
      { id: "strong", config: { gateway: { channelStaleEventThresholdMinutes: 3 } } },
      { id: "weak", config: { gateway: { channelHealthCheckMinutes: 1 } } },
    ]);

    expect(result).toMatchObject({
      valid: true,
      sourceConfig: {
        gateway: { channelStaleEventThresholdMinutes: 3, channelHealthCheckMinutes: 1 },
      },
    });
  });

  it("drops empty objects without letting validator defaults become claims", () => {
    const result = prepareLayeredRuntimeConfig([
      { id: "channel", config: { channels: { telegram: {} } } },
    ]);

    expect(result).toMatchObject({
      valid: true,
      sourceConfig: {},
      provenance: [],
    });
  });

  it("retains atomic declared values through layer preparation", () => {
    const result = prepareLayeredRuntimeConfig([
      { id: "tools", config: { tools: { alsoAllow: ["read"] } } },
    ]);

    expect(result).toMatchObject({
      valid: true,
      sourceConfig: { tools: { alsoAllow: ["read"] } },
    });
  });
});

describe("activateLayeredRuntimeConfig", () => {
  const parseJson = (content: Uint8Array) => JSON.parse(new TextDecoder().decode(content));

  it("publishes one complete candidate after every layer succeeds", async () => {
    const publish = vi.fn();
    const result = await activateLayeredRuntimeConfig({
      descriptors: [
        {
          id: "first",
          source: { gateway: { port: 18789 } },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "second",
          source: { logging: { level: "info" } },
          access: "read-write",
          contractVersion: 1,
        },
      ],
      resolveSource: async (config, { layerId }) => ({
        content: JSON.stringify(config),
        sourceIdentity: "source:" + layerId,
      }),
      parseSource: parseJson,
      publish,
    });

    expect(result).toMatchObject({
      valid: true,
      candidate: {
        sourceConfig: { gateway: { port: 18789 }, logging: { level: "info" } },
        layers: [
          { id: "first", access: "read-only", sourceIdentity: "source:first" },
          { id: "second", access: "read-write", sourceIdentity: "source:second" },
        ],
      },
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not publish when a source fails", async () => {
    const publish = vi.fn();
    const result = await activateLayeredRuntimeConfig({
      descriptors: [{ id: "bad", source: "bad", access: "read-only", contractVersion: 1 }],
      resolveSource: async () => {
        throw new Error("source unavailable");
      },
      parseSource: parseJson,
      publish,
    });

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerSourceResolutionFailed", layer: "bad" }],
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish when authority admission fails", async () => {
    const publish = vi.fn();
    const result = await activateLayeredRuntimeConfig({
      descriptors: [
        { id: "first", source: 18789, access: "read-only", contractVersion: 1 },
        { id: "second", source: 19000, access: "read-write", contractVersion: 1 },
      ],
      resolveSource: async (port, { layerId }) => ({
        content: JSON.stringify({ gateway: { port } }),
        sourceIdentity: layerId,
      }),
      parseSource: parseJson,
      publish,
    });

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "ControlledByEarlierLayer" }],
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not parse or publish a digest mismatch", async () => {
    const publish = vi.fn();
    const parseSource = vi.fn(parseJson);
    const result = await activateLayeredRuntimeConfig({
      descriptors: [
        {
          id: "tampered",
          source: "{}",
          access: "read-only",
          contractVersion: 1,
          expectedDigest: ("sha256:" + "0".repeat(64)) as `sha256:${string}`,
        },
      ],
      resolveSource: async (content) => ({ content, sourceIdentity: "tampered" }),
      parseSource,
      publish,
    });

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerSourceDigestMismatch", layer: "tampered" }],
    });
    expect(parseSource).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports publisher failure without returning an active candidate", async () => {
    const result = await activateLayeredRuntimeConfig({
      descriptors: [{ id: "only", source: {}, access: "read-only", contractVersion: 1 }],
      resolveSource: async (config) => ({
        content: JSON.stringify(config),
        sourceIdentity: "only",
      }),
      parseSource: parseJson,
      publish: async () => {
        throw new Error("snapshot rejected");
      },
    });

    expect(result).toEqual({
      valid: false,
      findings: [{ reason: "RuntimeSnapshotPublishFailed", message: "snapshot rejected" }],
    });
  });

  it("reports an advisory for a whole layer with no declarations", async () => {
    const result = await activateLayeredRuntimeConfig({
      descriptors: [
        { id: "staged", source: {}, access: "read-only", contractVersion: 1 },
        {
          id: "active",
          source: { gateway: { port: 18789 } },
          access: "read-write",
          contractVersion: 1,
        },
      ],
      resolveSource: async (config, { layerId }) => ({
        content: JSON.stringify(config),
        sourceIdentity: layerId,
      }),
      parseSource: parseJson,
      publish: () => undefined,
    });

    expect(result).toMatchObject({
      valid: true,
      candidate: {
        advisories: [{ reason: "NoDeclaredValues", layer: "staged" }],
      },
    });
  });

  it("composes Scout, tenant network, and operator sources", async () => {
    const publish = vi.fn();
    const result = await activateLayeredRuntimeConfig({
      descriptors: [
        {
          id: "scout-global",
          source: { gateway: { mode: "local" } },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "tenant-network",
          source: {
            gateway: {
              bind: "tailnet",
              controlUi: { allowedOrigins: ["https://openclaw.acme.internal"] },
            },
          },
          access: "read-only",
          contractVersion: 1,
        },
        {
          id: "operator",
          source: { gateway: { controlUi: { enabled: true } } },
          access: "read-write",
          contractVersion: 1,
        },
      ],
      resolveSource: async (config, { layerId }) => ({
        content: JSON.stringify(config),
        sourceIdentity: layerId,
      }),
      parseSource: parseJson,
      publish,
    });

    expect(result).toMatchObject({
      valid: true,
      candidate: {
        sourceConfig: {
          gateway: {
            mode: "local",
            bind: "tailnet",
            controlUi: {
              allowedOrigins: ["https://openclaw.acme.internal"],
              enabled: true,
            },
          },
        },
      },
    });
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe("effective managed source resolution", () => {
  it("returns a structured finding when effective resolution fails", () => {
    const result = prepareLayeredRuntimeConfig([
      { id: "managed", config: { $include: "./missing-managed-config.json" } },
    ]);
    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "InvalidEffectiveConfig", issues: [{ path: "" }] }],
    });
  });
});
