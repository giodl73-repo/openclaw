import { describe, expect, it } from "vitest";
import {
  prepareReverseProviderOwnerBindingV1,
  REVERSE_PROVIDER_OWNER_GENERATION_VERSION,
  type ReverseProviderOwnerPreparationInputV1,
} from "./reverse-provider-owner-preparation.js";

function input(
  overrides: Partial<ReverseProviderOwnerPreparationInputV1> = {},
): ReverseProviderOwnerPreparationInputV1 {
  return {
    bindingId: "lobster/egress",
    effectiveConfigGeneration: "effective-config/v1:sha256:config",
    trafficPolicyId: "lobster/egress-policy",
    trafficPolicyGeneration: "traffic-policy/v1:sha256:policy",
    hostBundleGeneration: "host-bundle-generation/v1:sha256:bundle",
    audience: "openclaw:test-cell",
    keyFingerprint: "sha256:peer-key",
    ...overrides,
  };
}

describe("prepareReverseProviderOwnerBindingV1", () => {
  it("derives a deterministic authority from the complete prepared binding", () => {
    const first = prepareReverseProviderOwnerBindingV1(input());
    const reordered = prepareReverseProviderOwnerBindingV1({
      keyFingerprint: input().keyFingerprint,
      audience: input().audience,
      hostBundleGeneration: input().hostBundleGeneration,
      trafficPolicyGeneration: input().trafficPolicyGeneration,
      trafficPolicyId: input().trafficPolicyId,
      effectiveConfigGeneration: input().effectiveConfigGeneration,
      bindingId: input().bindingId,
    });

    expect(first).toEqual(reordered);
    expect(first.authority.ownerGeneration).toMatch(
      new RegExp(`^${REVERSE_PROVIDER_OWNER_GENERATION_VERSION}:sha256:[a-f0-9]{64}$`, "u"),
    );
    expect(first.authority).toMatchObject({
      bindingId: "lobster/egress",
      interfaceVersion: "provider-request-dispatcher/v1",
      carrierVersion: "reverse-provider-dispatch/v1",
      hostBundleGeneration: input().hostBundleGeneration,
      audience: "openclaw:test-cell",
      keyFingerprint: "sha256:peer-key",
    });
    expect(first).toMatchObject({
      effectiveConfigGeneration: input().effectiveConfigGeneration,
      trafficPolicyId: input().trafficPolicyId,
      trafficPolicyGeneration: input().trafficPolicyGeneration,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.authority)).toBe(true);
  });

  it.each([
    "bindingId",
    "effectiveConfigGeneration",
    "trafficPolicyId",
    "trafficPolicyGeneration",
    "hostBundleGeneration",
    "audience",
    "keyFingerprint",
  ] as const)("advances the owner generation when %s changes", (field) => {
    const current = prepareReverseProviderOwnerBindingV1(input());
    const changed = prepareReverseProviderOwnerBindingV1(
      input({ [field]: `${input()[field]}-next` }),
    );

    expect(changed.authority.ownerGeneration).not.toBe(current.authority.ownerGeneration);
  });

  it("rejects incomplete, ambiguous, and widened preparation inputs", () => {
    expect(() => prepareReverseProviderOwnerBindingV1({ ...input(), audience: "" })).toThrow(
      /audience/u,
    );
    expect(() =>
      prepareReverseProviderOwnerBindingV1({ ...input(), bindingId: " lobster/egress" }),
    ).toThrow(/bindingId/u);
    expect(() =>
      prepareReverseProviderOwnerBindingV1({ ...input(), extra: true } as never),
    ).toThrow(/unknown field extra/u);
    const missing = { ...input() } as Record<string, unknown>;
    delete missing.trafficPolicyGeneration;
    expect(() => prepareReverseProviderOwnerBindingV1(missing as never)).toThrow(
      /missing field trafficPolicyGeneration/u,
    );
  });
});
