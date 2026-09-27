import { describe, expect, it } from "vitest";
import { composeConfigLayers, type ConfigLayer } from "./layer-composition.js";

describe("composeConfigLayers", () => {
  it("keeps zero layers empty so later materialization owns defaults", () => {
    expect(composeConfigLayers([])).toEqual({ valid: true, config: {}, provenance: [] });
  });

  it("preserves one sparse layer without inserting defaults", () => {
    expect(composeConfigLayers([{ id: "local", config: { gateway: { port: 18789 } } }])).toEqual({
      valid: true,
      config: { gateway: { port: 18789 } },
      provenance: [
        {
          path: "gateway.port",
          control: "exact",
          controllingLayer: "local",
          declaringLayers: ["local"],
        },
      ],
    });
  });

  it("preserves unclaimed siblings across layers", () => {
    const result = composeConfigLayers([
      {
        id: "platform",
        config: { gateway: { controlUi: { allowedOrigins: ["https://work.example"] } } },
      },
      { id: "operator", config: { gateway: { controlUi: { enabled: true } } } },
    ]);

    expect(result).toMatchObject({
      valid: true,
      config: {
        gateway: {
          controlUi: {
            allowedOrigins: ["https://work.example"],
            enabled: true,
          },
        },
      },
    });
  });

  it("accepts equal exact declarations and records every declarer", () => {
    const result = composeConfigLayers([
      { id: "platform", config: { gateway: { port: 18789 } } },
      { id: "tenant", config: { gateway: { port: 18789 } } },
    ]);

    expect(result).toMatchObject({
      valid: true,
      provenance: [
        {
          path: "gateway.port",
          controllingLayer: "platform",
          declaringLayers: ["platform", "tenant"],
        },
      ],
    });
  });

  it("rejects a different exact value from a later layer", () => {
    expect(
      composeConfigLayers([
        { id: "platform", config: { gateway: { port: 18789 } } },
        { id: "operator", config: { gateway: { port: 19000 } } },
      ]),
    ).toEqual({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "operator",
          path: "gateway.port",
          controllingLayer: "platform",
          controllingValue: 18789,
          conflictingValue: 19000,
        },
      ],
    });
  });

  it("lets a middle layer establish authority over a final layer", () => {
    const result = composeConfigLayers([
      { id: "platform", config: { gateway: { port: 18789 } } },
      { id: "tenant", config: { logging: { level: "info" } } },
      { id: "operator", config: { logging: { level: "debug" } } },
    ]);

    expect(result).toMatchObject({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "operator",
          path: "logging.level",
          controllingLayer: "tenant",
        },
      ],
    });
  });

  it("rejects a later object below an earlier atomic path", () => {
    const result = composeConfigLayers([
      { id: "first", config: { agents: { defaults: { model: "openai/gpt-5.5" } } } },
      {
        id: "second",
        config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
      },
    ]);

    expect(result).toMatchObject({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "second",
          path: "agents.defaults.model",
          controllingLayer: "first",
        },
      ],
    });
  });

  it("rejects a later atomic value above earlier object descendants", () => {
    const result = composeConfigLayers([
      {
        id: "first",
        config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
      },
      { id: "second", config: { agents: { defaults: { model: "openai/gpt-5.5" } } } },
    ]);

    expect(result).toMatchObject({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "second",
          path: "agents.defaults.model",
          controllingLayer: "first",
        },
      ],
    });
  });

  it("promotes the next declarer when an earlier layer is removed", () => {
    const layers: ConfigLayer[] = [
      { id: "platform", config: { gateway: { port: 18789 } } },
      { id: "tenant", config: { gateway: { port: 18789 } } },
    ];

    const result = composeConfigLayers(layers.slice(1));
    expect(result).toMatchObject({
      valid: true,
      provenance: [{ controllingLayer: "tenant", declaringLayers: ["tenant"] }],
    });
  });

  it("treats arrays and null as atomic exact values", () => {
    const result = composeConfigLayers([
      { id: "first", config: { tools: { alsoAllow: ["read"] }, value: null } },
      { id: "second", config: { tools: { alsoAllow: ["read", "exec"] }, value: null } },
    ]);

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "ControlledByEarlierLayer", path: "tools.alsoAllow" }],
    });
  });

  it("returns a structured rejection for a non-cloneable document", () => {
    expect(composeConfigLayers([{ id: "bad", config: { value: () => undefined } }])).toEqual({
      valid: false,
      findings: [{ reason: "InvalidLayerDocument", layer: "bad" }],
    });
  });

  it("does not let a rejected layer establish authority for later layers", () => {
    const result = composeConfigLayers([
      { id: "first", config: { controlled: "first" } },
      { id: "rejected", config: { controlled: "rejected", available: "rejected" } },
      { id: "third", config: { available: "third" } },
    ]);

    expect(result).toEqual({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "rejected",
          path: "controlled",
          controllingLayer: "first",
          controllingValue: "first",
          conflictingValue: "rejected",
        },
      ],
    });
  });

  it.each([
    {
      name: "empty ids",
      layers: [{ id: "", config: {} }],
      reason: "EmptyLayerId",
    },
    {
      name: "duplicate ids",
      layers: [
        { id: "same", config: {} },
        { id: "same", config: {} },
      ],
      reason: "DuplicateLayerId",
    },
    {
      name: "non-object documents",
      layers: [{ id: "bad", config: [] }],
      reason: "InvalidLayerDocument",
    },
  ])("rejects $name", ({ layers, reason }) => {
    expect(composeConfigLayers(layers)).toMatchObject({
      valid: false,
      findings: [{ reason }],
    });
  });
});
