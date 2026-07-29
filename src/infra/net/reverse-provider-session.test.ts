import { describe, expect, it } from "vitest";
import fixtures from "../../../test/fixtures/reverse-provider-session-v1.json" with { type: "json" };
import {
  ReverseProviderSessionRegistryV1,
  REVERSE_PROVIDER_SESSION_VERSION,
} from "./reverse-provider-session.js";

const NOW_MS = 2_000_000_000_000;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    declaration: { ...fixtures.declaration },
    connectionId: "connection-1",
    verifiedPeer: { ...fixtures.verifiedPeer },
    ...overrides,
  };
}

function admit(
  registry: ReverseProviderSessionRegistryV1,
  value: unknown = candidate(),
  authority: unknown = fixtures.authority,
  nowMs: unknown = NOW_MS,
) {
  return registry.admit(value, authority, nowMs);
}

describe("ReverseProviderSessionRegistryV1", () => {
  it("uses the injected registry clock when admission omits an explicit time", () => {
    const registry = new ReverseProviderSessionRegistryV1(
      () => "incarnation-1",
      () => NOW_MS,
    );

    const result = registry.admit(candidate(), fixtures.authority);

    expect(result.ok && result.session.admittedAtMs).toBe(NOW_MS);
  });

  it("admits an exact current declaration with caller-verified peer proof", () => {
    const registry = new ReverseProviderSessionRegistryV1(() => "incarnation-1");

    const result = admit(registry);

    expect(result).toEqual({
      ok: true,
      session: {
        version: REVERSE_PROVIDER_SESSION_VERSION,
        incarnationId: "incarnation-1:1",
        connectionId: "connection-1",
        admittedAtMs: NOW_MS,
        declaration: fixtures.declaration,
        verifiedPeer: fixtures.verifiedPeer,
      },
    });
    expect(registry.getByBinding(fixtures.declaration.bindingId)).toBe(
      result.ok ? result.session : undefined,
    );
  });

  it.each([
    ["bindingId", "binding.other"],
    ["interfaceVersion", "provider-request-dispatcher/v2"],
    ["carrierVersion", "reverse-provider-dispatch/v2"],
    ["ownerGeneration", "owner-generation-8"],
    ["hostBundleGeneration", "bundle-generation-13"],
  ])("rejects stale declaration authority for %s", (field, value) => {
    const declaration = { ...fixtures.declaration, [field]: value };
    const result = admit(new ReverseProviderSessionRegistryV1(), candidate({ declaration }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe(
      field === "carrierVersion" || field === "interfaceVersion" ? "malformed" : "stale-authority",
    );
  });

  it("rejects a mismatched verified audience", () => {
    const verifiedPeer = { ...fixtures.verifiedPeer, audience: "some-other-audience" };
    expect(
      admit(new ReverseProviderSessionRegistryV1(), candidate({ verifiedPeer })),
    ).toMatchObject({
      ok: false,
      code: "stale-authority",
    });
  });

  it("rejects a verified peer that is not authorized for the binding", () => {
    const verifiedPeer = { ...fixtures.verifiedPeer, keyFingerprint: "sha256:other-peer" };
    expect(
      admit(new ReverseProviderSessionRegistryV1(), candidate({ verifiedPeer })),
    ).toMatchObject({
      ok: false,
      code: "stale-authority",
    });
  });

  it("rejects an expired peer proof, including at the expiry boundary", () => {
    const verifiedPeer = { ...fixtures.verifiedPeer, expiresAtMs: NOW_MS };
    expect(
      admit(new ReverseProviderSessionRegistryV1(), candidate({ verifiedPeer })),
    ).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it.each([
    ["unknown candidate field", { ...candidate(), extra: true }],
    [
      "missing declaration field",
      candidate({ declaration: { ...fixtures.declaration, bindingId: undefined } }),
    ],
    ["unknown peer field", candidate({ verifiedPeer: { ...fixtures.verifiedPeer, extra: true } })],
    ["invalid expiry", candidate({ verifiedPeer: { ...fixtures.verifiedPeer, expiresAtMs: 1.5 } })],
  ])("rejects malformed input: %s", (_label, value) => {
    expect(admit(new ReverseProviderSessionRegistryV1(), value)).toMatchObject({
      ok: false,
      code: "malformed",
    });
  });

  it("rejects duplicate binding and connection ownership", () => {
    const registry = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    expect(admit(registry).ok).toBe(true);

    expect(admit(registry, candidate({ connectionId: "connection-2" }))).toMatchObject({
      ok: false,
      code: "duplicate-binding",
    });
    const declaration = { ...fixtures.declaration, bindingId: "binding.weather.secondary" };
    const authority = { ...fixtures.authority, bindingId: declaration.bindingId };
    expect(admit(registry, candidate({ declaration }), authority)).toMatchObject({
      ok: false,
      code: "duplicate-connection",
    });
  });

  it("uses incarnation-safe detach so an old close cannot remove a new session", () => {
    let sequence = 0;
    const registry = new ReverseProviderSessionRegistryV1(() => `incarnation-${++sequence}`);
    const first = admit(registry);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(registry.detach("connection-1", first.session.incarnationId)).toBe(first.session);

    const second = admit(registry);
    expect(second.ok).toBe(true);
    expect(registry.detach("connection-1", first.session.incarnationId)).toBeUndefined();
    expect(registry.getByBinding(fixtures.declaration.bindingId)).toBe(
      second.ok ? second.session : undefined,
    );
  });

  it("keeps incarnations unique when an injected entropy source repeats", () => {
    const registry = new ReverseProviderSessionRegistryV1(() => "incarnation-reused");
    const first = admit(registry);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    registry.detach(first.session.connectionId, first.session.incarnationId);

    const second = admit(registry);
    expect(second.ok).toBe(true);
    expect(second.ok && second.session.incarnationId).not.toBe(first.session.incarnationId);
    expect(
      registry.detach(first.session.connectionId, first.session.incarnationId),
    ).toBeUndefined();
  });

  it("contains incarnation factory failures in the admission result", () => {
    const registry = new ReverseProviderSessionRegistryV1(() => {
      throw new Error("entropy unavailable");
    });

    expect(admit(registry)).toEqual({
      ok: false,
      code: "malformed",
      message: "incarnation id factory failed",
    });
    expect(registry.list()).toEqual([]);
  });

  it("copies and freezes admitted session evidence", () => {
    const value = candidate();
    const registry = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    const result = admit(registry, value);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    (value.declaration as Record<string, unknown>).bindingId = "mutated";
    expect(result.session.declaration.bindingId).toBe(fixtures.declaration.bindingId);
    expect(Object.isFrozen(result.session)).toBe(true);
    expect(Object.isFrozen(result.session.declaration)).toBe(true);
    expect(Object.isFrozen(result.session.verifiedPeer)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it("expires admitted sessions and clears both ownership indexes", () => {
    let sequence = 0;
    const registry = new ReverseProviderSessionRegistryV1(() => `incarnation-${++sequence}`);
    const result = admit(registry);
    expect(result.ok).toBe(true);

    expect(registry.expire(fixtures.verifiedPeer.expiresAtMs - 1)).toEqual([]);
    expect(registry.expire(fixtures.verifiedPeer.expiresAtMs)).toEqual(
      result.ok ? [result.session] : [],
    );
    expect(registry.list()).toEqual([]);
    expect(admit(registry).ok).toBe(true);
  });
});
