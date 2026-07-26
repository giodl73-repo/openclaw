import { afterEach, describe, expect, it } from "vitest";
import canonicalPolicyFixture from "./fixtures/provider-request-traffic-policy-v1.json" with { type: "json" };
import {
  clearCurrentProviderRequestTrafficPolicyV1,
  evaluateCurrentProviderRequestTrafficPolicyV1,
  getCurrentProviderRequestTrafficPolicyV1,
  registerProviderRequestTrafficPolicyV1,
  type ProviderRequestTrafficPolicyDecisionV1,
  type ProviderRequestTrafficPolicyFactsV1,
  type ProviderRequestTrafficPolicyRegistrationV1,
} from "./provider-request-traffic-policy.js";

function registration(
  overrides: Partial<ProviderRequestTrafficPolicyRegistrationV1> = {},
): ProviderRequestTrafficPolicyRegistrationV1 {
  return {
    version: "provider-request-traffic-policy/v1",
    id: "lobster/enterprise-egress",
    generation: "policy-7",
    required: true,
    provenance: {
      source: "lobster-managed-policy",
      revision: "rev-4",
    },
    routeProfiles: [
      {
        id: "lobster/managed",
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "https://proxy.example.test",
        },
        dispatchBindingId: "lobster/egress",
      },
    ],
    rules: [
      {
        id: "capi",
        match: {
          providers: ["microsoft-capi"],
          capabilities: ["llm"],
          transports: ["stream"],
          endpointClasses: ["custom"],
        },
        outcome: {
          action: "allow",
          routeProfileId: "lobster/managed",
          allowedOrigins: ["https://capi.example.test"],
          allowPrivateNetwork: false,
          maximumTimeoutMs: 20_000,
        },
      },
    ],
    ...overrides,
  };
}

function facts() {
  return {
    provider: "microsoft-capi",
    capability: "llm" as const,
    transport: "stream" as const,
    endpointClass: "custom" as const,
    url: "https://capi.example.test/v1/messages",
    allowPrivateNetwork: true,
    timeoutMs: 60_000,
  };
}

afterEach(() => {
  clearCurrentProviderRequestTrafficPolicyV1();
});

describe("provider request traffic policy", () => {
  it("evaluates the canonical language-neutral fixtures", () => {
    const fixture = canonicalPolicyFixture as {
      version: string;
      registration: ProviderRequestTrafficPolicyRegistrationV1;
      cases: Array<{
        id: string;
        facts: ProviderRequestTrafficPolicyFactsV1;
        expected: ProviderRequestTrafficPolicyDecisionV1;
      }>;
    };
    expect(fixture.version).toBe("provider-request-traffic-policy-fixtures/v1");
    registerProviderRequestTrafficPolicyV1(fixture.registration);
    for (const entry of fixture.cases) {
      expect(evaluateCurrentProviderRequestTrafficPolicyV1(entry.facts), entry.id).toEqual(
        entry.expected,
      );
    }
  });

  it("denies explicitly and fails closed when a required policy has no match", () => {
    registerProviderRequestTrafficPolicyV1(
      registration({
        rules: [
          {
            id: "deny-capi",
            match: { providers: ["microsoft-capi"] },
            outcome: { action: "deny", reason: "DestinationSuspended" },
          },
        ],
      }),
    );
    expect(evaluateCurrentProviderRequestTrafficPolicyV1(facts())).toMatchObject({
      action: "deny",
      reason: "DestinationSuspended",
    });

    clearCurrentProviderRequestTrafficPolicyV1();
    registerProviderRequestTrafficPolicyV1(registration());
    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        provider: "openai",
      }),
    ).toMatchObject({
      action: "deny",
      reason: "RequiredPolicyNoMatch",
    });
  });

  it("narrows origin, private-network, timeout, and selects one explicit route", () => {
    registerProviderRequestTrafficPolicyV1(registration());
    expect(evaluateCurrentProviderRequestTrafficPolicyV1(facts())).toEqual({
      action: "allow",
      policyId: "lobster/enterprise-egress",
      policyGeneration: "policy-7",
      routeProfileId: "lobster/managed",
      dispatchBindingId: "lobster/egress",
      allowPrivateNetwork: false,
      timeoutMs: 20_000,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "https://proxy.example.test/",
      },
    });
    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        url: "https://other.example.test/v1/messages",
      }),
    ).toMatchObject({
      action: "deny",
      reason: "DestinationOutsidePolicy",
    });
  });

  it("denies conflicting route selections and configured proxy replacement", () => {
    const conflictingRule = {
      id: "second-route",
      match: { providers: ["microsoft-capi"] },
      outcome: {
        action: "allow" as const,
        routeProfileId: "lobster/direct",
        allowedOrigins: ["https://capi.example.test"],
        allowPrivateNetwork: false,
      },
    };
    registerProviderRequestTrafficPolicyV1(
      registration({
        routeProfiles: [
          ...registration().routeProfiles,
          {
            id: "lobster/direct",
            dispatcherPolicy: { mode: "direct" },
          },
        ],
        rules: [...registration().rules, conflictingRule],
      }),
    );
    expect(evaluateCurrentProviderRequestTrafficPolicyV1(facts())).toMatchObject({
      action: "deny",
      reason: "ConflictingRouteProfiles",
    });

    clearCurrentProviderRequestTrafficPolicyV1();
    registerProviderRequestTrafficPolicyV1(registration());
    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "https://operator-proxy.example.test",
        },
      }),
    ).toMatchObject({
      action: "deny",
      reason: "ConfiguredRouteConflict",
    });

    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        dispatcherPolicy: {
          mode: "direct",
          connect: { ca: "operator-trust-anchor" },
        },
      }),
    ).toMatchObject({
      action: "deny",
      reason: "ConfiguredRouteConflict",
    });
  });

  it("rejects insecure TLS and never widens private-network authority", () => {
    expect(() =>
      registerProviderRequestTrafficPolicyV1(
        registration({
          routeProfiles: [
            {
              id: "lobster/managed",
              dispatcherPolicy: {
                mode: "direct",
                connect: { rejectUnauthorized: false },
              },
            },
          ],
        }),
      ),
    ).toThrow("cannot disable TLS verification");

    const baseOutcome = registration().rules[0]!.outcome;
    if (baseOutcome.action !== "allow") {
      throw new Error("Expected the test policy to allow provider traffic");
    }
    registerProviderRequestTrafficPolicyV1(
      registration({
        rules: [
          {
            ...registration().rules[0]!,
            outcome: {
              ...baseOutcome,
              allowPrivateNetwork: true,
            },
          },
        ],
      }),
    );
    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        allowPrivateNetwork: false,
      }),
    ).toMatchObject({
      action: "allow",
      allowPrivateNetwork: false,
    });
  });

  it("detaches nested TLS values and rejects opaque mutable trust material", () => {
    const ca = ["trust-anchor-a"];
    const proxyTls = {
      ca,
      nested: { servername: "proxy.example.test" },
    };
    registerProviderRequestTrafficPolicyV1(
      registration({
        routeProfiles: [
          {
            id: "lobster/managed",
            dispatcherPolicy: {
              mode: "explicit-proxy",
              proxyUrl: "https://proxy.example.test",
              proxyTls,
            },
          },
        ],
      }),
    );

    ca[0] = "mutated-trust-anchor";
    proxyTls.nested.servername = "mutated.example.test";
    expect(evaluateCurrentProviderRequestTrafficPolicyV1(facts())).toMatchObject({
      action: "allow",
      dispatcherPolicy: {
        proxyTls: {
          ca: ["trust-anchor-a"],
          nested: { servername: "proxy.example.test" },
        },
      },
    });

    clearCurrentProviderRequestTrafficPolicyV1();
    expect(() =>
      registerProviderRequestTrafficPolicyV1(
        registration({
          routeProfiles: [
            {
              id: "lobster/managed",
              dispatcherPolicy: {
                mode: "direct",
                connect: { ca: Buffer.from("opaque-trust-anchor") },
              },
            },
          ],
        }),
      ),
    ).toThrow("TLS value is unsupported");
  });

  it("accepts structurally equal nested TLS values", () => {
    const proxyTls = {
      ca: ["trust-anchor-a"],
      nested: { servername: "proxy.example.test" },
    };
    registerProviderRequestTrafficPolicyV1(
      registration({
        routeProfiles: [
          {
            id: "lobster/managed",
            dispatcherPolicy: {
              mode: "explicit-proxy",
              proxyUrl: "https://proxy.example.test",
              proxyTls,
            },
          },
        ],
      }),
    );

    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "https://proxy.example.test",
          proxyTls: {
            ca: ["trust-anchor-a"],
            nested: { servername: "proxy.example.test" },
          },
        },
      }),
    ).toMatchObject({ action: "allow" });
  });

  it("intersects prepared and selected hostname pins", () => {
    registerProviderRequestTrafficPolicyV1(
      registration({
        routeProfiles: [
          {
            id: "lobster/managed",
            dispatcherPolicy: {
              mode: "direct",
              pinnedHostname: {
                hostname: "capi.example.test",
                addresses: ["192.0.2.20", "192.0.2.30"],
              },
            },
          },
        ],
      }),
    );
    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        dispatcherPolicy: {
          mode: "direct",
          pinnedHostname: {
            hostname: "capi.example.test",
            addresses: ["192.0.2.10", "192.0.2.20"],
          },
        },
      }),
    ).toMatchObject({
      action: "allow",
      dispatcherPolicy: {
        mode: "direct",
        pinnedHostname: {
          hostname: "capi.example.test",
          addresses: ["192.0.2.20"],
        },
      },
    });

    expect(
      evaluateCurrentProviderRequestTrafficPolicyV1({
        ...facts(),
        dispatcherPolicy: {
          mode: "direct",
          pinnedHostname: {
            hostname: "capi.example.test",
            addresses: ["192.0.2.10"],
          },
        },
      }),
    ).toMatchObject({
      action: "deny",
      reason: "ConfiguredRouteConflict",
    });
  });
  it("restores only a still-active previous generation when replacement is disposed", () => {
    const disposePrevious = registerProviderRequestTrafficPolicyV1(registration());
    const disposeReplacement = registerProviderRequestTrafficPolicyV1(
      registration({ generation: "policy-8" }),
    );
    expect(getCurrentProviderRequestTrafficPolicyV1()?.generation).toBe("policy-8");

    disposeReplacement();
    expect(getCurrentProviderRequestTrafficPolicyV1()?.generation).toBe("policy-7");
    disposePrevious();
    expect(getCurrentProviderRequestTrafficPolicyV1()).toBeUndefined();

    const disposeStale = registerProviderRequestTrafficPolicyV1(registration());
    const disposeCurrent = registerProviderRequestTrafficPolicyV1(
      registration({ generation: "policy-9" }),
    );
    disposeStale();
    disposeCurrent();
    expect(getCurrentProviderRequestTrafficPolicyV1()).toBeUndefined();
  });
});
