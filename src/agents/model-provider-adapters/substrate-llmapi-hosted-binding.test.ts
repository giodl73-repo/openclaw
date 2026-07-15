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
import {
  createLocalOneHopFetchDispatcher,
  type OneHopFetchRequest,
} from "../../infra/net/one-hop-fetch-dispatcher.js";
import {
  clearCurrentProviderRequestTrafficPolicyV1,
  getCurrentProviderRequestTrafficPolicyV1,
  registerProviderRequestTrafficPolicyV1,
  type ProviderRequestTrafficPolicyRegistrationV1,
} from "../provider-request-traffic-policy.js";
import {
  SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION,
  prepareSubstrateLlmApiHostedBindingV1,
  type SubstrateLlmApiHostedBindingImplementationsV1,
  type SubstrateLlmApiHostedBindingSelectionV1,
} from "./substrate-llmapi-hosted-binding.js";
import type {
  SubstrateLlmApiAdapterConfigV1,
  SubstrateLlmApiRequestContextV1,
} from "./substrate-llmapi.js";

type BundleFixture = {
  manifest: HostIntegrationBundleManifestV1;
  availableContributions: AvailableHostIntegrationContributionV1[];
};

type SubstrateFixture = {
  request: {
    config: SubstrateLlmApiAdapterConfigV1;
    context: SubstrateLlmApiRequestContextV1;
    method: string;
    body: string;
  };
  expected: {
    url: string;
    modelType: string;
  };
};

const bundleFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/host-integration-bundle-v1.json", import.meta.url),
    "utf8",
  ),
) as BundleFixture;
const substrateFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/substrate-llmapi-model-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as SubstrateFixture;

function policyRegistration(
  dispatchBindingId = "example/reverse-provider",
): ProviderRequestTrafficPolicyRegistrationV1 {
  return {
    version: "provider-request-traffic-policy/v1",
    id: "example/enterprise-egress",
    generation: "policy-8",
    required: true,
    provenance: {
      source: "test",
      revision: "revision-2",
    },
    routeProfiles: [
      {
        id: "example/managed",
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "https://proxy.example.test",
        },
        dispatchBindingId,
      },
    ],
    rules: [
      {
        id: "substrate",
        match: {
          providers: ["substrate-llmapi"],
          capabilities: ["llm"],
          transports: ["stream"],
          endpointClasses: ["custom"],
        },
        outcome: {
          action: "allow",
          routeProfileId: "example/managed",
          allowedOrigins: ["https://substrate.example.com"],
          allowPrivateNetwork: false,
          maximumTimeoutMs: 20_000,
        },
      },
    ],
  };
}

function selection(
  overrides: Partial<SubstrateLlmApiHostedBindingSelectionV1> = {},
): SubstrateLlmApiHostedBindingSelectionV1 {
  return {
    version: SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION,
    providerId: "substrate-llmapi",
    configGeneration: "config-5",
    ownerGeneration: "substrate-owner-1",
    configSource: {
      source: "openclaw.json",
      path: "models.providers.substrate",
    },
    adapter: {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: "substrate/llmapi",
      version: "substrate-llmapi-model-provider-adapter/v1",
    },
    credentialSlot: {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "substrate/token",
      version: "credential-slot-resolver/v1",
    },
    trafficPolicy: {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "example/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
    },
    dispatcher: {
      owner: "provider-request",
      kind: "provider-request-dispatcher",
      id: "example/reverse-provider",
      version: "provider-request-dispatcher/v1",
    },
    ...overrides,
  };
}

function prepareImplementations(params: {
  mode: "local" | "hosted";
  dispatch: SubstrateLlmApiHostedBindingImplementationsV1["dispatcher"]["dispatcher"];
  dispatchBindingId?: string;
}): SubstrateLlmApiHostedBindingImplementationsV1 {
  registerProviderRequestTrafficPolicyV1(policyRegistration(params.dispatchBindingId));
  const policy = getCurrentProviderRequestTrafficPolicyV1();
  if (!policy) {
    throw new Error("policy registration failed");
  }
  const credentials = prepareCredentialSlotBindingsV1({
    definitions: [
      {
        version: CREDENTIAL_SLOT_VERSION,
        slotId: "substrate/token",
        placement: "header",
        headerName: "authorization",
        allowedOrigins: ["https://substrate.example.com"],
        required: true,
        resolverId: "test/substrate-token",
      },
    ],
    resolvers: [
      {
        version: CREDENTIAL_SLOT_RESOLVER_VERSION,
        resolverId: "test/substrate-token",
        slotId: "substrate/token",
        placement: "header",
        headerName: "authorization",
        allowedOrigins: ["https://substrate.example.com"],
        resolve: async () => ({ value: "******" }),
      },
    ],
  });
  return {
    credentialSlot: {
      id: "substrate/token",
      version: "credential-slot-resolver/v1",
      bindings: credentials,
    },
    trafficPolicy: {
      id: "example/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      snapshot: policy,
    },
    dispatcher: {
      id: "example/reverse-provider",
      version: "provider-request-dispatcher/v1",
      routeProfileId: "example/managed",
      mode: params.mode,
      dispatcher: params.dispatch,
    },
  };
}

function bundle() {
  const fixture = structuredClone(bundleFixture);
  fixture.manifest.bundleVersion = "1.1.0";
  fixture.manifest.contributions.push(
    {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: "substrate/llmapi",
      version: "substrate-llmapi-model-provider-adapter/v1",
      required: true,
      readinessCriteria: ["model.provider.substrate"],
    },
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "substrate/token",
      version: "credential-slot-resolver/v1",
      required: true,
      readinessCriteria: ["provider.request.credentials.substrate"],
    },
    {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "example/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      required: true,
      readinessCriteria: ["provider.request.policy.example"],
    },
  );
  for (const contribution of fixture.manifest.contributions.slice(-3)) {
    fixture.availableContributions.push({
      owner: contribution.owner,
      kind: contribution.kind,
      id: contribution.id,
      version: contribution.version,
      provenance: {
        pluginId: "example-host",
        source: "/plugins/example-host/openclaw.plugin.json",
        origin: "config",
      },
    } as AvailableHostIntegrationContributionV1);
  }
  return prepareHostIntegrationBundleSnapshotV1(fixture);
}

function fence(bundleGeneration: string) {
  return {
    configGeneration: "config-5",
    bundleGeneration,
    ownerGeneration: "substrate-owner-1",
  };
}

afterEach(() => {
  clearCurrentProviderRequestTrafficPolicyV1();
});

describe("Substrate LLM API hosted binding", () => {
  it.each(["local", "hosted"] as const)(
    "preserves request and response semantics through the %s dispatcher",
    async (mode) => {
      const responseBody = '{"id":"response-1"}';
      const dispatch = vi.fn(async (request) => {
        const headers = new Headers(request.init.headers);
        if (mode === "local") {
          expect(headers.get("authorization")).toBe("******");
        } else {
          expect(headers.get("authorization")).toBeNull();
          expect(request.credentialSlotRefs).toEqual(["substrate/token"]);
        }
        expect(request.url).toBe(substrateFixture.expected.url);
        expect(headers.get("x-modeltype")).toBe(substrateFixture.expected.modelType);
        expect(Buffer.from(request.init.body as Uint8Array).toString()).toBe(
          substrateFixture.request.body,
        );
        return new Response(responseBody, { status: 200 });
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
                      origin: "https://substrate.example.com",
                      hostname: "substrate.example.com",
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
                  credentialSlotRefs: ["substrate/token"],
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
      const binding = prepareSubstrateLlmApiHostedBindingV1({
        selection: selection(),
        adapterConfig: substrateFixture.request.config,
        bundle: bundle(),
        implementations: prepareImplementations({
          mode,
          dispatch: localDispatcher,
        }),
      });

      const result = await binding.dispatch({
        fence: fence(binding.bundleGeneration),
        context: substrateFixture.request.context,
        method: substrateFixture.request.method,
        body: substrateFixture.request.body,
      });

      await expect(result.response.text()).resolves.toBe(responseBody);
      expect(binding.mode).toBe(mode);
      expect(binding.policyGeneration).toBe("policy-8");
      expect(binding.ownerEvidence).toMatchObject({
        id: "substrate/llmapi",
        state: "ready",
        ownerGeneration: "substrate-owner-1",
        bundleGeneration: binding.bundleGeneration,
      });
      await result.release();
    },
  );

  it.each([
    ["configGeneration", "stale-config-generation"],
    ["bundleGeneration", "stale-bundle-generation"],
    ["ownerGeneration", "stale-owner-generation"],
  ] as const)("fences stale %s independently", async (field, code) => {
    const binding = prepareSubstrateLlmApiHostedBindingV1({
      selection: selection(),
      adapterConfig: substrateFixture.request.config,
      bundle: bundle(),
      implementations: prepareImplementations({
        mode: "hosted",
        dispatch: { dispatch: vi.fn() },
      }),
    });

    await expect(
      binding.dispatch({
        fence: { ...fence(binding.bundleGeneration), [field]: "stale" },
        context: substrateFixture.request.context,
        method: substrateFixture.request.method,
        body: substrateFixture.request.body,
      }),
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("fails closed on missing adapter or credential contributions before dispatch", () => {
    const dispatch = vi.fn();
    const preparedBundle = bundle();
    const incomplete = {
      ...preparedBundle,
      inventory: preparedBundle.inventory.filter((entry) => entry.id !== "substrate/llmapi"),
    };

    expect(() =>
      prepareSubstrateLlmApiHostedBindingV1({
        selection: selection(),
        adapterConfig: substrateFixture.request.config,
        bundle: incomplete,
        implementations: prepareImplementations({
          mode: "hosted",
          dispatch: { dispatch },
        }),
      }),
    ).toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails before dispatch when the prepared token slot is absent", async () => {
    const dispatch = vi.fn();
    const implementations = prepareImplementations({
      mode: "hosted",
      dispatch: { dispatch },
    });
    implementations.credentialSlot.bindings = prepareCredentialSlotBindingsV1({
      definitions: [],
      resolvers: [],
    });
    const binding = prepareSubstrateLlmApiHostedBindingV1({
      selection: selection(),
      adapterConfig: substrateFixture.request.config,
      bundle: bundle(),
      implementations,
    });

    await expect(
      binding.dispatch({
        fence: fence(binding.bundleGeneration),
        context: substrateFixture.request.context,
        method: substrateFixture.request.method,
        body: substrateFixture.request.body,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "missing-credential-slot" }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("captures nested adapter config and dispatcher implementations immutably", async () => {
    const dispatch = vi.fn(async (_request: OneHopFetchRequest) => new Response("ok"));
    const config = structuredClone(substrateFixture.request.config);
    const implementations = prepareImplementations({
      mode: "hosted",
      dispatch: { dispatch },
    });
    const bindingSelection = selection();
    const binding = prepareSubstrateLlmApiHostedBindingV1({
      selection: bindingSelection,
      adapterConfig: config,
      bundle: bundle(),
      implementations,
    });
    Object.assign(config.modelMap, { "anthropic/claude-opus-4-6": "mutated" });
    Object.assign(config.taxonomy.extendedProperties, { Client: "mutated" });
    bindingSelection.dispatcher.id = "mutated/dispatcher";
    implementations.dispatcher.routeProfileId = "mutated/route";
    implementations.dispatcher.dispatcher.dispatch = vi.fn();

    await binding.dispatch({
      fence: fence(binding.bundleGeneration),
      context: substrateFixture.request.context,
      method: substrateFixture.request.method,
      body: substrateFixture.request.body,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    const request = dispatch.mock.calls[0]?.[0];
    expect(new Headers(request?.init.headers).get("x-modeltype")).toBe(
      substrateFixture.expected.modelType,
    );
    expect(
      JSON.parse(new Headers(request?.init.headers).get("x-taxonomy-extendedproperties") ?? "{}")
        .Client,
    ).toBe("Example Host");
  });

  it("rejects a traffic-policy route that does not select the prepared dispatcher", async () => {
    const dispatch = vi.fn();
    const binding = prepareSubstrateLlmApiHostedBindingV1({
      selection: selection(),
      adapterConfig: substrateFixture.request.config,
      bundle: bundle(),
      implementations: prepareImplementations({
        mode: "hosted",
        dispatch: { dispatch },
        dispatchBindingId: "other/dispatcher",
      }),
    });

    await expect(
      binding.dispatch({
        fence: fence(binding.bundleGeneration),
        context: substrateFixture.request.context,
        method: substrateFixture.request.method,
        body: substrateFixture.request.body,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "traffic-policy-route-mismatch" }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
