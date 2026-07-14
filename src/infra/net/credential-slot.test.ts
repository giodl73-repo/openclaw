import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  CredentialSlotError,
  type CredentialSlotDefinitionV1,
  type CredentialSlotResolverV1,
  prepareCredentialSlotBindingsV1,
} from "./credential-slot.js";
import {
  NETWORK_GUARD_PROFILE_VERSION,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";
import { createLocalOneHopFetchDispatcher } from "./one-hop-fetch-dispatcher.js";

const SLOT_ID = "lobster/capi-token";
const RESOLVER_ID = "local/capi-token";
const ORIGIN = "https://api.example.com";

function createDefinition(
  overrides: Partial<CredentialSlotDefinitionV1> = {},
): CredentialSlotDefinitionV1 {
  return {
    version: CREDENTIAL_SLOT_VERSION,
    slotId: SLOT_ID,
    placement: "header",
    headerName: "Authorization",
    allowedOrigins: [ORIGIN],
    required: true,
    resolverId: RESOLVER_ID,
    ...overrides,
  };
}

function createResolver(
  resolve: CredentialSlotResolverV1["resolve"] = vi.fn(async () => ({
    value: "Bearer protected-value",
  })),
  overrides: Partial<CredentialSlotResolverV1> = {},
): CredentialSlotResolverV1 {
  return {
    version: CREDENTIAL_SLOT_RESOLVER_VERSION,
    resolverId: RESOLVER_ID,
    slotId: SLOT_ID,
    placement: "header",
    headerName: "authorization",
    allowedOrigins: [ORIGIN],
    resolve,
    ...overrides,
  };
}

function createNetworkGuard(url = `${ORIGIN}/v1`): NetworkGuardProfileV1 {
  const parsed = new URL(url);
  return {
    version: NETWORK_GUARD_PROFILE_VERSION,
    target: {
      protocol: "https:",
      origin: parsed.origin,
      hostname: parsed.hostname,
      port: 443,
    },
    route: { mode: "direct", resolution: "caller", tls: "required" },
    addressPolicy: {
      mode: "public-only",
      trustedHostnames: [],
      hostnameAllowlist: [],
      allowedPrivateCidrs: [],
      allowRfc2544BenchmarkRange: false,
      allowIpv6UniqueLocalRange: false,
      dnsRebinding: { policy: "reject", enforcement: "not-enforced" },
    },
  };
}

describe("credential slot bindings", () => {
  it("validates readiness without acquiring a credential", () => {
    const resolve = vi.fn(async () => ({ value: "Bearer protected-value" }));
    const bindings = prepareCredentialSlotBindingsV1({
      definitions: [createDefinition()],
      resolvers: [createResolver(resolve)],
    });

    expect(bindings.readiness()).toEqual([
      {
        slotId: SLOT_ID,
        resolverId: RESOLVER_ID,
        version: CREDENTIAL_SLOT_VERSION,
        resolverVersion: CREDENTIAL_SLOT_RESOLVER_VERSION,
        placement: "header",
        headerName: "authorization",
        allowedOrigins: [ORIGIN],
        required: true,
      },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("injects a declared credential only for the exact request origin", async () => {
    const resolve = vi.fn(async () => ({ value: "Bearer protected-value" }));
    const bindings = prepareCredentialSlotBindingsV1({
      definitions: [createDefinition()],
      resolvers: [createResolver(resolve)],
    });
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const dispatcher = createLocalOneHopFetchDispatcher(fetchImpl, {
      credentialSlots: bindings,
    });
    const init = { redirect: "manual" as const, headers: { Accept: "application/json" } };

    await dispatcher.dispatch({
      url: `${ORIGIN}/v1`,
      init,
      networkGuard: createNetworkGuard(),
      credentialSlotRefs: [SLOT_ID],
    });

    const sentInit = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(sentInit?.headers).get("authorization")).toBe("Bearer protected-value");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      slotId: SLOT_ID,
      origin: ORIGIN,
      signal: undefined,
    });
  });

  it("rejects cross-origin use before invoking the resolver or fetch", async () => {
    const resolve = vi.fn(async () => ({ value: "Bearer protected-value" }));
    const bindings = prepareCredentialSlotBindingsV1({
      definitions: [createDefinition()],
      resolvers: [createResolver(resolve)],
    });
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const dispatcher = createLocalOneHopFetchDispatcher(fetchImpl, {
      credentialSlots: bindings,
    });
    const url = "https://other.example.com/v1";

    await expect(
      dispatcher.dispatch({
        url,
        init: { redirect: "manual" },
        networkGuard: createNetworkGuard(url),
        credentialSlotRefs: [SLOT_ID],
      }),
    ).rejects.toMatchObject({ code: "origin-denied", slotId: SLOT_ID });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails preparation for missing or incompatible resolvers", () => {
    expect(() =>
      prepareCredentialSlotBindingsV1({
        definitions: [createDefinition()],
        resolvers: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "missing-resolver", slotId: SLOT_ID }));

    expect(() =>
      prepareCredentialSlotBindingsV1({
        definitions: [createDefinition()],
        resolvers: [createResolver(undefined, { headerName: "x-api-key" })],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-resolver", slotId: SLOT_ID }));
  });

  it("rejects duplicate slot and resolver registrations", () => {
    expect(() =>
      prepareCredentialSlotBindingsV1({
        definitions: [createDefinition()],
        resolvers: [createResolver(), createResolver()],
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-resolver" }));

    expect(() =>
      prepareCredentialSlotBindingsV1({
        definitions: [createDefinition(), createDefinition()],
        resolvers: [createResolver()],
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-slot" }));
  });

  it("rejects ambiguous header ownership during preparation", () => {
    expect(() =>
      prepareCredentialSlotBindingsV1({
        definitions: [
          createDefinition(),
          createDefinition({
            slotId: "lobster/alternate-token",
            resolverId: "local/alternate-token",
          }),
        ],
        resolvers: [
          createResolver(),
          createResolver(undefined, {
            slotId: "lobster/alternate-token",
            resolverId: "local/alternate-token",
          }),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "ambiguous-header" }));
  });

  it("validates every reference before acquiring any credential", async () => {
    const resolve = vi.fn(async () => ({ value: "Bearer protected-value" }));
    const bindings = prepareCredentialSlotBindingsV1({
      definitions: [createDefinition()],
      resolvers: [createResolver(resolve)],
    });

    await expect(
      bindings.apply({
        slotRefs: [SLOT_ID, SLOT_ID],
        url: `${ORIGIN}/v1`,
        init: {},
      }),
    ).rejects.toMatchObject({ code: "duplicate-reference", slotId: SLOT_ID });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects expired credentials without exposing their value", async () => {
    const protectedValue = "Bearer must-not-leak";
    const bindings = prepareCredentialSlotBindingsV1({
      definitions: [createDefinition()],
      resolvers: [
        createResolver(async () => ({
          value: protectedValue,
          expiresAtMs: 999,
        })),
      ],
    });

    let error: unknown;
    try {
      await bindings.apply({
        slotRefs: [SLOT_ID],
        url: `${ORIGIN}/v1`,
        init: {},
        now: () => 1_000,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CredentialSlotError);
    expect(error).toMatchObject({ code: "credential-expired", slotId: SLOT_ID });
    expect(String(error)).not.toContain(protectedValue);
    expect(JSON.stringify(error)).not.toContain(protectedValue);
  });

  it("never overwrites a caller-provided protected header", async () => {
    const resolve = vi.fn(async () => ({ value: "Bearer protected-value" }));
    const bindings = prepareCredentialSlotBindingsV1({
      definitions: [createDefinition()],
      resolvers: [createResolver(resolve)],
    });

    await expect(
      bindings.apply({
        slotRefs: [SLOT_ID],
        url: `${ORIGIN}/v1`,
        init: { headers: { Authorization: "Bearer existing" } },
      }),
    ).rejects.toMatchObject({ code: "header-conflict", slotId: SLOT_ID });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects slot references when no prepared binding is installed", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const dispatcher = createLocalOneHopFetchDispatcher(fetchImpl);

    await expect(
      dispatcher.dispatch({
        url: `${ORIGIN}/v1`,
        init: { redirect: "manual" },
        networkGuard: createNetworkGuard(),
        credentialSlotRefs: [SLOT_ID],
      }),
    ).rejects.toThrow(/without a prepared resolver binding/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
