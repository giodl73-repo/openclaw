import { describe, expect, it } from "vitest";
import { compareConfigLayerBound, prepareConfigLayerAuthorityValue } from "./layer-authority.js";
import { composeConfigLayers } from "./layer-composition.js";

describe("bounded configuration authority", () => {
  it("registers only the initial schema-owned tool policy paths", () => {
    expect(prepareConfigLayerAuthorityValue("tools.allow", ["read"])).toEqual({
      valid: true,
      control: "allow-set-ceiling",
      value: ["read"],
    });
    expect(prepareConfigLayerAuthorityValue("tools.deny", ["exec"])).toEqual({
      valid: true,
      control: "deny-set-floor",
      value: ["exec"],
    });
    expect(prepareConfigLayerAuthorityValue("gateway.tools.allow", ["read"])).toEqual({
      valid: true,
      control: "exact",
      value: ["read"],
    });
  });

  it("canonicalizes bounded sets deterministically", () => {
    expect(prepareConfigLayerAuthorityValue("tools.allow", ["exec", "read", "read"])).toEqual({
      valid: true,
      control: "allow-set-ceiling",
      value: ["exec", "read"],
    });
  });

  it("leaves schema-invalid values to effective validation", () => {
    expect(prepareConfigLayerAuthorityValue("tools.deny", ["exec", 1])).toEqual({
      valid: true,
      control: "exact",
      value: ["exec", 1],
    });
  });

  it("accepts an allow-set subset and rejects a superset", () => {
    expect(
      compareConfigLayerBound({
        control: "allow-set-ceiling",
        inherited: ["exec", "read"],
        candidate: ["read"],
      }),
    ).toEqual({ accepted: true, value: ["read"], tightened: true });
    expect(
      compareConfigLayerBound({
        control: "allow-set-ceiling",
        inherited: ["read"],
        candidate: ["exec", "read"],
      }),
    ).toEqual({ accepted: false, invalid: false });
  });

  it("accepts a deny-set superset and rejects a subset", () => {
    expect(
      compareConfigLayerBound({
        control: "deny-set-floor",
        inherited: ["exec"],
        candidate: ["exec", "write"],
      }),
    ).toEqual({ accepted: true, value: ["exec", "write"], tightened: true });
    expect(
      compareConfigLayerBound({
        control: "deny-set-floor",
        inherited: ["exec", "write"],
        candidate: ["exec"],
      }),
    ).toEqual({ accepted: false, invalid: false });
  });

  it("composes a three-layer allow ceiling associatively", () => {
    const layers = [
      { id: "global", config: { tools: { allow: ["read", "exec", "browser"] } } },
      { id: "tenant", config: { tools: { allow: ["read", "exec"] } } },
      { id: "operator", config: { tools: { allow: ["read"] } } },
    ];
    const direct = composeConfigLayers(layers);
    const regrouped = composeConfigLayers([
      layers[0],
      {
        id: "tenant-and-operator",
        config: { tools: { allow: ["read"] } },
      },
    ]);

    expect(direct).toMatchObject({
      valid: true,
      config: { tools: { allow: ["read"] } },
      provenance: [
        {
          path: "tools.allow",
          control: "allow-set-ceiling",
          controllingLayer: "operator",
          declaringLayers: ["global", "tenant", "operator"],
        },
      ],
    });
    expect(regrouped).toMatchObject({
      valid: true,
      config: { tools: { allow: ["read"] } },
    });
  });

  it("composes a three-layer deny floor", () => {
    expect(
      composeConfigLayers([
        { id: "global", config: { tools: { deny: ["exec"] } } },
        { id: "tenant", config: { tools: { deny: ["exec", "write"] } } },
        { id: "operator", config: { tools: { deny: ["exec", "write", "browser"] } } },
      ]),
    ).toMatchObject({
      valid: true,
      config: { tools: { deny: ["browser", "exec", "write"] } },
      provenance: [
        {
          control: "deny-set-floor",
          controllingLayer: "operator",
          declaringLayers: ["global", "tenant", "operator"],
        },
      ],
    });
  });

  it("rejects a later weakening with the current tightener", () => {
    expect(
      composeConfigLayers([
        { id: "global", config: { tools: { allow: ["read", "exec", "browser"] } } },
        { id: "tenant", config: { tools: { allow: ["read", "exec"] } } },
        { id: "operator", config: { tools: { allow: ["read", "browser"] } } },
      ]),
    ).toMatchObject({
      valid: false,
      findings: [
        {
          reason: "WouldWeakenEarlierLayer",
          layer: "operator",
          path: "tools.allow",
          controllingLayer: "tenant",
        },
      ],
    });
  });

  it("treats reordered equal sets as idempotent", () => {
    expect(
      composeConfigLayers([
        { id: "first", config: { tools: { deny: ["write", "exec"] } } },
        { id: "second", config: { tools: { deny: ["exec", "write", "exec"] } } },
      ]),
    ).toMatchObject({
      valid: true,
      config: { tools: { deny: ["exec", "write"] } },
      provenance: [{ declaringLayers: ["first", "second"] }],
    });
  });

  it("leaves unsupported bounded declaration types exact", () => {
    expect(
      composeConfigLayers([{ id: "bad", config: { tools: { allow: "read" } } }]),
    ).toMatchObject({
      valid: true,
      config: { tools: { allow: "read" } },
      provenance: [{ control: "exact" }],
    });
  });
  it.each([
    ["wildcard", "*"],
    ["group", "group:fs"],
    ["glob", "web_*"],
    ["case variant", "READ"],
    ["alias", "bash"],
    ["broad write allow", "write"],
  ])("uses exact authority for bounded paths with %s syntax", (_name, entry) => {
    expect(prepareConfigLayerAuthorityValue("tools.allow", [entry])).toEqual({
      valid: true,
      control: "exact",
      value: [entry],
    });
  });
  it("keeps special syntax valid only outside the bounded registry", () => {
    expect(prepareConfigLayerAuthorityValue("gateway.tools.allow", ["*"])).toEqual({
      valid: true,
      control: "exact",
      value: ["*"],
    });
  });
  it("treats an empty inherited allowlist as unrestricted", () => {
    expect(
      compareConfigLayerBound({
        control: "allow-set-ceiling",
        inherited: [],
        candidate: ["read"],
      }),
    ).toEqual({ accepted: true, value: ["read"], tightened: true });
  });

  it("rejects removing a non-empty allow ceiling with an empty list", () => {
    expect(
      compareConfigLayerBound({
        control: "allow-set-ceiling",
        inherited: ["read"],
        candidate: [],
      }),
    ).toEqual({ accepted: false, invalid: false });
  });
});
