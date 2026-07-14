import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableHostIntegrationContributionV1,
  HostIntegrationBundleManifestV1,
} from "../../hosting/host-integration-bundle.js";
import { prepareHostIntegrationBundleSnapshotV1 } from "../../hosting/host-integration-bundle.js";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  prepareCredentialSlotBindingsV1,
} from "../../infra/net/credential-slot.js";
import { createLocalOneHopFetchDispatcher } from "../../infra/net/one-hop-fetch-dispatcher.js";
import {
  clearCurrentProviderRequestTrafficPolicyV1,
  getCurrentProviderRequestTrafficPolicyV1,
  registerProviderRequestTrafficPolicyV1,
  type ProviderRequestTrafficPolicyRegistrationV1,
} from "../provider-request-traffic-policy.js";
import {
  CAPI_HOSTED_BINDING_VERSION,
  CapiHostedBindingError,
  prepareCapiHostedBindingV1,
  type CapiHostedBindingImplementationsV1,
  type CapiHostedBindingSelectionV1,
} from "./capi-hosted-binding.js";
import type { CapiModelAdapterConfigV1, CapiModelRequestContextV1 } from "./capi.js";

type BundleFixture = {
  manifest: HostIntegrationBundleManifestV1;
  availableContributions: AvailableHostIntegrationContributionV1[];
};

type CapiFixture = {
  request: {
    config: CapiModelAdapterConfigV1;
    context: CapiModelRequestContextV1;
    method: string;
    body: string;
  };
  expected: {
    url: string;
  };
  sse: {
    input: string;
    expected: string;
  };
};

const bundleFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/host-integration-bundle-v1.json", import.meta.url),
    "utf8",
  ),
) as BundleFixture;
const capiFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/capi-model-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as CapiFixture;

function policyRegistration(
  dispatchBindingId = "lobster/egress",
): ProviderRequestTrafficPolicyRegistrationV1 {
  return {
    version: "provider-request-traffic-policy/v1",
    id: "lobster/enterprise-egress",
    generation: "policy-7",
    required: true,
    provenance: {
      source: "test",
      revision: "revision-1",
    },
    routeProfiles: [
      {
        id: "lobster/managed",
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "https://proxy.example.test",
        },
        dispatchBindingId,
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
          allowedOrigins: ["https://capi.example.com"],
          allowPrivateNetwork: false,
          maximumTimeoutMs: 20_000,
        },
      },
    ],
  };
}

function selection(
  overrides: Partial<CapiHostedBindingSelectionV1> = {},
): CapiHostedBindingSelectionV1 {
  return {
    version: CAPI_HOSTED_BINDING_VERSION,
    providerId: "microsoft-capi",
    configGeneration: "config-4",
    ownerGeneration: "capi-owner-9",
    configSource: {
      source: "openclaw.json",
      path: "models.providers.capi",
    },
    adapter: {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: "lobster/capi",
      version: "capi-model-provider-adapter/v1",
    },
    credentialSlot: {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "lobster/capi-token",
      version: "credential-slot-resolver/v1",
    },
    trafficPolicy: {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
    },
    dispatcher: {
      owner: "provider-request",
      kind: "provider-request-dispatcher",
      id: "lobster/egress",
      version: "provider-request-dispatcher/v1",
    },
    ...overrides,
  };
}

function prepareImplementations(params: {
  mode: "local" | "hosted";
  dispatch: CapiHostedBindingImplementationsV1["dispatcher"]["dispatcher"];
  dispatchBindingId?: string;
}): CapiHostedBindingImplementationsV1 {
  registerProviderRequestTrafficPolicyV1(policyRegistration(params.dispatchBindingId));
  const policy = getCurrentProviderRequestTrafficPolicyV1();
  if (!policy) {
    throw new Error("policy registration failed");
  }
  const credentials = prepareCredentialSlotBindingsV1({
    definitions: [
      {
        version: CREDENTIAL_SLOT_VERSION,
        slotId: "lobster/capi-token",
        placement: "header",
        headerName: "authorization",
        allowedOrigins: ["https://capi.example.com"],
        required: true,
        resolverId: "test/capi-token",
      },
    ],
    resolvers: [
      {
        version: CREDENTIAL_SLOT_RESOLVER_VERSION,
        resolverId: "test/capi-token",
        slotId: "lobster/capi-token",
        placement: "header",
        headerName: "authorization",
        allowedOrigins: ["https://capi.example.com"],
        resolve: async () => ({ value: "Bearer test-token" }),
      },
    ],
  });
  return {
    credentialSlot: {
      id: "lobster/capi-token",
      version: "credential-slot-resolver/v1",
      bindings: credentials,
    },
    trafficPolicy: {
      id: "lobster/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      snapshot: policy,
    },
    dispatcher: {
      id: "lobster/egress",
      version: "provider-request-dispatcher/v1",
      routeProfileId: "lobster/managed",
      mode: params.mode,
      dispatcher: params.dispatch,
    },
  };
}

function bundle() {
  const fixture = structuredClone(bundleFixture);
  fixture.manifest.contributions.push({
    owner: "provider-request",
    kind: "provider-request-traffic-policy",
    id: "lobster/enterprise-egress",
    version: "provider-request-traffic-policy/v1",
    required: true,
    readinessCriteria: ["provider.request.policy.lobster"],
  });
  fixture.availableContributions.push({
    owner: "provider-request",
    kind: "provider-request-traffic-policy",
    id: "lobster/enterprise-egress",
    version: "provider-request-traffic-policy/v1",
    provenance: {
      pluginId: "lobster-host",
      source: "/plugins/lobster-host/openclaw.plugin.json",
      origin: "config",
    },
  });
  return prepareHostIntegrationBundleSnapshotV1(fixture);
}

function fence(bundleGeneration: string) {
  return {
    configGeneration: "config-4",
    bundleGeneration,
    ownerGeneration: "capi-owner-9",
  };
}

afterEach(() => {
  clearCurrentProviderRequestTrafficPolicyV1();
});

describe("CAPI hosted binding", () => {
  it.each(["local", "hosted"] as const)(
    "preserves CAPI request and streaming response semantics through the %s dispatcher",
    async (mode) => {
      const dispatch = vi.fn(async (request) => {
        const headers = new Headers(request.init.headers);
        if (mode === "local") {
          expect(headers.get("authorization")).toBe("Bearer test-token");
        } else {
          expect(headers.get("authorization")).toBeNull();
          expect(request.credentialSlotRefs).toEqual(["lobster/capi-token"]);
        }
        return new Response(capiFixture.sse.input, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      const localDispatcher =
        mode === "local"
          ? createLocalOneHopFetchDispatcher(
              async (_url, init) =>
                await dispatch({
                  url: _url,
                  init,
                  networkGuard: {
                    version: "network-guard/v1",
                    target: {
                      protocol: "https:",
                      origin: "https://capi.example.com",
                      hostname: "capi.example.com",
                      port: 443,
                    },
                    route: {
                      mode: "explicit-proxy",
                      resolution: "proxy",
                      tls: "required",
                    },
                    addressPolicy: {
                      mode: "public-only",
                      trustedHostnames: [],
                      hostnameAllowlist: [],
                      allowedPrivateCidrs: [],
                      allowRfc2544BenchmarkRange: false,
                      allowIpv6UniqueLocalRange: false,
                      dnsRebinding: {
                        policy: "reject",
                        enforcement: "connection-owner-required",
                      },
                    },
                  },
                  credentialSlotRefs: ["lobster/capi-token"],
                }),
              {
                hasPreparedDispatcher: true,
                credentialSlots: prepareImplementations({
                  mode: "hosted",
                  dispatch: { dispatch },
                }).credentialSlot.bindings,
              },
            )
          : { dispatch };
      clearCurrentProviderRequestTrafficPolicyV1();
      const implementations = prepareImplementations({
        mode,
        dispatch: localDispatcher,
      });
      const bundleSnapshot = bundle();
      const binding = prepareCapiHostedBindingV1({
        selection: selection(),
        adapterConfig: capiFixture.request.config,
        bundle: bundleSnapshot,
        implementations,
      });

      const result = await binding.dispatch({
        fence: fence(binding.bundleGeneration),
        context: capiFixture.request.context,
        method: capiFixture.request.method,
        body: capiFixture.request.body,
      });

      await expect(result.response.text()).resolves.toBe(capiFixture.sse.expected);
      expect(binding.mode).toBe(mode);
      expect(binding.bundleGeneration).toBe(bundleSnapshot.generation);
      expect(binding.ownerEvidence).toMatchObject({
        state: "ready",
        ownerGeneration: "capi-owner-9",
        bundleGeneration: binding.bundleGeneration,
      });
      expect(Object.isFrozen(binding)).toBe(true);
      await result.release();
    },
  );

  it.each([
    ["configGeneration", "stale-config-generation"],
    ["bundleGeneration", "stale-bundle-generation"],
    ["ownerGeneration", "stale-owner-generation"],
  ] as const)("fences stale %s independently", async (field, code) => {
    const implementations = prepareImplementations({
      mode: "hosted",
      dispatch: { dispatch: vi.fn() },
    });
    const binding = prepareCapiHostedBindingV1({
      selection: selection(),
      adapterConfig: capiFixture.request.config,
      bundle: bundle(),
      implementations,
    });

    await expect(
      binding.dispatch({
        fence: { ...fence(binding.bundleGeneration), [field]: "stale" },
        context: capiFixture.request.context,
        method: capiFixture.request.method,
        body: capiFixture.request.body,
      }),
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("fails closed on a missing reference without invoking the dispatcher", () => {
    const dispatch = vi.fn();
    const implementations = prepareImplementations({
      mode: "hosted",
      dispatch: { dispatch },
    });
    const incomplete = structuredClone(bundleFixture);
    incomplete.manifest.contributions.push({
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      required: true,
      readinessCriteria: ["provider.request.policy.lobster"],
    });
    incomplete.availableContributions.push({
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      provenance: {
        pluginId: "lobster-host",
        source: "/plugins/lobster-host/openclaw.plugin.json",
        origin: "config",
      },
    });
    incomplete.availableContributions = incomplete.availableContributions.filter(
      (entry) => entry.id !== "lobster/egress",
    );

    expect(() =>
      prepareCapiHostedBindingV1({
        selection: selection(),
        adapterConfig: capiFixture.request.config,
        bundle: prepareHostIntegrationBundleSnapshotV1({
          manifest: {
            ...incomplete.manifest,
            contributions: incomplete.manifest.contributions.map((entry) =>
              entry.id === "lobster/egress" ? { ...entry, required: false } : entry,
            ),
          },
          availableContributions: incomplete.availableContributions,
        }),
        implementations,
      }),
    ).toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a traffic-policy route that does not select the prepared dispatcher", async () => {
    const implementations = prepareImplementations({
      mode: "hosted",
      dispatch: { dispatch: vi.fn() },
      dispatchBindingId: "other/egress",
    });
    const binding = prepareCapiHostedBindingV1({
      selection: selection(),
      adapterConfig: capiFixture.request.config,
      bundle: bundle(),
      implementations,
    });

    await expect(
      binding.dispatch({
        fence: fence(binding.bundleGeneration),
        context: capiFixture.request.context,
        method: capiFixture.request.method,
        body: capiFixture.request.body,
      }),
    ).rejects.toBeInstanceOf(CapiHostedBindingError);
  });

  it("captures config and dispatcher implementations when the binding is prepared", async () => {
    const dispatch = vi.fn<
      CapiHostedBindingImplementationsV1["dispatcher"]["dispatcher"]["dispatch"]
    >(async () => new Response(capiFixture.sse.input));
    const dispatcher = { dispatch };
    const implementations = prepareImplementations({
      mode: "hosted",
      dispatch: dispatcher,
    });
    const adapterConfig = { ...capiFixture.request.config };
    const binding = prepareCapiHostedBindingV1({
      selection: selection(),
      adapterConfig,
      bundle: bundle(),
      implementations,
    });
    adapterConfig.endpointTemplate = "https://mutated.example/{tenant_id}/{model}";
    dispatcher.dispatch = vi.fn(async () => new Response("mutated"));

    const result = await binding.dispatch({
      fence: fence(binding.bundleGeneration),
      context: capiFixture.request.context,
      method: capiFixture.request.method,
      body: capiFixture.request.body,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].url).toBe(capiFixture.expected.url);
    await expect(result.response.text()).resolves.toBe(capiFixture.sse.expected);
    await result.release();
  });
});
