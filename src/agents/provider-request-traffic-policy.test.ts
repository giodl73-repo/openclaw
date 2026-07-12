import { afterEach, describe, expect, it } from "vitest";
import {
  clearCurrentProviderRequestTrafficPolicyV1,
  evaluateCurrentProviderRequestTrafficPolicyV1,
  getCurrentProviderRequestTrafficPolicyV1,
  registerProviderRequestTrafficPolicyV1,
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
  it("publishes one immutable ready generation and disposes only its own snapshot", () => {
    const disposeOld = registerProviderRequestTrafficPolicyV1(registration());
    const first = getCurrentProviderRequestTrafficPolicyV1();
    expect(first).toMatchObject({
      id: "lobster/enterprise-egress",
      generation: "policy-7",
      readiness: "ready",
      provenance: { source: "lobster-managed-policy", revision: "rev-4" },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.rules[0]?.match.providers)).toBe(true);

    registerProviderRequestTrafficPolicyV1(registration({ generation: "policy-8" }));
    disposeOld();
    expect(getCurrentProviderRequestTrafficPolicyV1()?.generation).toBe("policy-8");
  });

  it("rejects an unrelated policy instead of silently replacing it", () => {
    registerProviderRequestTrafficPolicyV1(registration());
    expect(() =>
      registerProviderRequestTrafficPolicyV1(
        registration({
          id: "other/enterprise-egress",
        }),
      ),
    ).toThrow("already registered");
    expect(getCurrentProviderRequestTrafficPolicyV1()?.id).toBe("lobster/enterprise-egress");
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

    registerProviderRequestTrafficPolicyV1(
      registration({
        rules: [
          {
            ...registration().rules[0]!,
            outcome: {
              ...registration().rules[0]!.outcome,
              action: "allow",
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
});
