import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "../provider-request-traffic-policy.js";
import {
  WEBIQ_HOSTED_BINDING_VERSION,
  prepareWebIqHostedBindingV1,
  type WebIqHostedBindingImplementationsV1,
  type WebIqHostedBindingSelectionV1,
} from "./webiq-hosted-binding.js";
import type { WebIqAdapterConfigV1, WebIqSearchRequestV1 } from "./webiq.js";

type Fixture = {
  request: { config: WebIqAdapterConfigV1; request: WebIqSearchRequestV1 };
  expected: { body: Record<string, unknown> };
  response: Record<string, unknown>;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/webiq-web-search-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function bundle() {
  const contributions = [
    {
      owner: "web-search-provider" as const,
      kind: "web-search-provider-adapter" as const,
      id: "lobster/webiq",
      version: "webiq-web-search-provider-adapter/v1",
      required: true,
      readinessCriteria: ["web-search.provider.webiq"],
    },
    {
      owner: "provider-request" as const,
      kind: "credential-slot-resolver" as const,
      id: "lobster/webiq-key",
      version: "credential-slot-resolver/v1",
      required: true,
      readinessCriteria: ["provider.request.credentials.webiq"],
    },
    {
      owner: "provider-request" as const,
      kind: "provider-request-traffic-policy" as const,
      id: "lobster/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      required: true,
      readinessCriteria: ["provider.request.policy.lobster"],
    },
    {
      owner: "provider-request" as const,
      kind: "provider-request-dispatcher" as const,
      id: "lobster/egress",
      version: "provider-request-dispatcher/v1",
      required: true,
      readinessCriteria: ["provider.request.dispatch.lobster"],
    },
  ];
  return prepareHostIntegrationBundleSnapshotV1({
    manifest: {
      version: "host-integration-bundle/v1",
      id: "lobster/host",
      bundleVersion: "1.1.0",
      contributions,
    },
    availableContributions: contributions.map((entry) =>
      Object.assign({}, entry, {
        provenance: {
          pluginId: "lobster-host",
          source: "/plugins/lobster-host/openclaw.plugin.json",
          origin: "config" as const,
        },
      }),
    ),
  });
}

function selection(): WebIqHostedBindingSelectionV1 {
  return {
    version: WEBIQ_HOSTED_BINDING_VERSION,
    configGeneration: "config-5",
    ownerGeneration: "webiq-owner-2",
    configSource: {
      source: "openclaw.json",
      path: "plugins.entries.webiq.config.webSearch",
    },
    providerId: "webiq",
    adapter: {
      owner: "web-search-provider",
      kind: "web-search-provider-adapter",
      id: "lobster/webiq",
      version: "webiq-web-search-provider-adapter/v1",
    },
    credentialSlot: {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "lobster/webiq-key",
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
  };
}

function implementations(
  mode: "local" | "hosted",
  dispatcher: WebIqHostedBindingImplementationsV1["dispatcher"]["dispatcher"],
): WebIqHostedBindingImplementationsV1 {
  registerProviderRequestTrafficPolicyV1({
    version: "provider-request-traffic-policy/v1",
    id: "lobster/enterprise-egress",
    generation: "policy-8",
    required: true,
    provenance: { source: "test", revision: "revision-1" },
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
        id: "webiq",
        match: {
          providers: ["webiq"],
          capabilities: ["web-search"],
          transports: ["request-response"],
          endpointClasses: ["custom"],
        },
        outcome: {
          action: "allow",
          routeProfileId: "lobster/managed",
          allowedOrigins: ["https://api.microsoft.ai"],
          allowPrivateNetwork: false,
          maximumTimeoutMs: 20_000,
        },
      },
    ],
  });
  const policy = getCurrentProviderRequestTrafficPolicyV1();
  if (!policy) {
    throw new Error("policy registration failed");
  }
  return {
    credentialSlot: {
      id: "lobster/webiq-key",
      version: "credential-slot-resolver/v1",
      bindings: prepareCredentialSlotBindingsV1({
        definitions: [
          {
            version: CREDENTIAL_SLOT_VERSION,
            slotId: "lobster/webiq-key",
            placement: "header",
            headerName: "x-apikey",
            allowedOrigins: ["https://api.microsoft.ai"],
            required: true,
            resolverId: "test/webiq-key",
          },
        ],
        resolvers: [
          {
            version: CREDENTIAL_SLOT_RESOLVER_VERSION,
            resolverId: "test/webiq-key",
            slotId: "lobster/webiq-key",
            placement: "header",
            headerName: "x-apikey",
            allowedOrigins: ["https://api.microsoft.ai"],
            resolve: async () => ({ value: "webiq-secret" }),
          },
        ],
      }),
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
      mode,
      dispatcher,
    },
  };
}

afterEach(() => {
  clearCurrentProviderRequestTrafficPolicyV1();
});

describe("WebIQ hosted binding", () => {
  it.each(["local", "hosted"] as const)(
    "preserves the portable request and response fixture through %s dispatch",
    async (mode) => {
      const exchange = vi.fn(async (request) => {
        const headers = new Headers(request.init.headers);
        expect(JSON.parse(String(request.init.body))).toEqual(fixture.expected.body);
        if (mode === "local") {
          expect(headers.get("x-apikey")).toBe("webiq-secret");
        } else {
          expect(headers.get("x-apikey")).toBeNull();
          expect(request.credentialSlotRefs).toEqual(["lobster/webiq-key"]);
        }
        return new Response(JSON.stringify(fixture.response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const hostedImplementations = implementations("hosted", { dispatch: exchange });
      const dispatcher =
        mode === "hosted"
          ? { dispatch: exchange }
          : createLocalOneHopFetchDispatcher(
              async (url, init) =>
                await exchange({
                  url,
                  init,
                  networkGuard: {
                    version: "network-guard/v1",
                    target: {
                      protocol: "https:",
                      origin: "https://api.microsoft.ai",
                      hostname: "api.microsoft.ai",
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
                  credentialSlotRefs: ["lobster/webiq-key"],
                }),
              hostedImplementations.credentialSlot.bindings,
            );
      clearCurrentProviderRequestTrafficPolicyV1();
      const binding = prepareWebIqHostedBindingV1({
        selection: selection(),
        adapterConfig: fixture.request.config,
        bundle: bundle(),
        implementations: implementations(mode, dispatcher),
      });
      const result = await binding.dispatch({
        fence: {
          configGeneration: "config-5",
          bundleGeneration: "lobster/host@1.1.0",
          ownerGeneration: "webiq-owner-2",
        },
        request: fixture.request.request,
      });
      await expect(result.response.json()).resolves.toMatchObject({
        query: fixture.request.request.query,
        provider: "webiq",
        count: 1,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "webiq",
          wrapped: true,
        },
        results: [
          {
            url: "https://openclaw.ai/",
            siteName: "openclaw.ai",
          },
        ],
      });
      expect(binding.ownerEvidence).toMatchObject({
        owner: "web-search-provider",
        kind: "web-search-provider-adapter",
        id: "lobster/webiq",
      });
      await result.release();
    },
  );

  it("fences stale owner generations before dispatch", async () => {
    const dispatch = vi.fn();
    const binding = prepareWebIqHostedBindingV1({
      selection: selection(),
      adapterConfig: fixture.request.config,
      bundle: bundle(),
      implementations: implementations("hosted", { dispatch }),
    });
    await expect(
      binding.dispatch({
        fence: {
          configGeneration: "config-5",
          bundleGeneration: "lobster/host@1.1.0",
          ownerGeneration: "stale",
        },
        request: fixture.request.request,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "stale-owner-generation" }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("captures config, selection, and dispatcher implementations when prepared", async () => {
    const dispatch = vi.fn<
      WebIqHostedBindingImplementationsV1["dispatcher"]["dispatcher"]["dispatch"]
    >(async () => Response.json(fixture.response));
    const dispatcher = { dispatch };
    const preparedImplementations = implementations("hosted", dispatcher);
    const adapterConfig = { ...fixture.request.config };
    const bindingSelection = selection();
    const binding = prepareWebIqHostedBindingV1({
      selection: bindingSelection,
      adapterConfig,
      bundle: bundle(),
      implementations: preparedImplementations,
    });
    adapterConfig.baseUrl = "https://mutated.example";
    bindingSelection.dispatcher.id = "mutated/dispatcher";
    preparedImplementations.dispatcher.routeProfileId = "mutated/route";
    dispatcher.dispatch = vi.fn(async () => new Response("mutated"));

    const result = await binding.dispatch({
      fence: {
        configGeneration: "config-5",
        bundleGeneration: "lobster/host@1.1.0",
        ownerGeneration: "webiq-owner-2",
      },
      request: fixture.request.request,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].url).toBe("https://api.microsoft.ai/v3/search/web");
    await expect(result.response.json()).resolves.toMatchObject({
      query: fixture.request.request.query,
      provider: "webiq",
    });
    await result.release();
  });
});
