import { describe, expect, it } from "vitest";
import {
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
