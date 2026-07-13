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
  ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION,
  prepareAnthropicDirectHostedBindingV1,
  type AnthropicDirectHostedBindingImplementationsV1,
  type AnthropicDirectHostedBindingSelectionV1,
} from "./anthropic-direct-hosted-binding.js";
import type {
  AnthropicDirectAdapterConfigV1,
  AnthropicDirectRequestContextV1,
} from "./anthropic-direct.js";

type BundleFixture = {
  manifest: HostIntegrationBundleManifestV1;
  availableContributions: AvailableHostIntegrationContributionV1[];
};

type AnthropicFixture = {
  request: {
    config: AnthropicDirectAdapterConfigV1;
    context: AnthropicDirectRequestContextV1;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  expected: {
    url: string;
  };
};

const bundleFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/host-integration-bundle-v1.json", import.meta.url),
    "utf8",
  ),
) as BundleFixture;
const anthropicFixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/anthropic-direct-model-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as AnthropicFixture;

function policyRegistration(
  dispatchBindingId = "lobster/egress",
): ProviderRequestTrafficPolicyRegistrationV1 {
  return {
    version: "provider-request-traffic-policy/v1",
    id: "lobster/enterprise-egress",
    generation: "policy-12",
    required: true,
    provenance: {
      source: "test",
      revision: "revision-4",
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
        id: "anthropic-direct",
        match: {
          providers: ["anthropic"],
          capabilities: ["llm"],
          transports: ["stream"],
          endpointClasses: ["anthropic-public"],
        },
        outcome: {
          action: "allow",
          routeProfileId: "lobster/managed",
          allowedOrigins: ["https://api.anthropic.com"],
          allowPrivateNetwork: false,
          maximumTimeoutMs: 20_000,
        },
      },
    ],
  };
}

function selection(
  overrides: Partial<AnthropicDirectHostedBindingSelectionV1> = {},
): AnthropicDirectHostedBindingSelectionV1 {
  return {
    version: ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION,
    providerId: "anthropic",
    configGeneration: "config-8",
    ownerGeneration: "anthropic-owner-1",
    configSource: {
      source: "openclaw.json",
      path: "models.providers.anthropic",
    },
    adapter: {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: "lobster/anthropic-direct",
      version: "anthropic-direct-model-provider-adapter/v1",
    },
    credentialSlot: {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "lobster/anthropic-key",
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
  dispatch: AnthropicDirectHostedBindingImplementationsV1["dispatcher"]["dispatcher"];
  dispatchBindingId?: string;
}): AnthropicDirectHostedBindingImplementationsV1 {
  registerProviderRequestTrafficPolicyV1(policyRegistration(params.dispatchBindingId));
  const policy = getCurrentProviderRequestTrafficPolicyV1();
  if (!policy) {
    throw new Error("policy registration failed");
  }
  const credentials = prepareCredentialSlotBindingsV1({
    definitions: [
      {
        version: CREDENTIAL_SLOT_VERSION,
        slotId: "lobster/anthropic-key",
        placement: "header",
        headerName: "x-api-key",
        allowedOrigins: ["https://api.anthropic.com"],
        required: true,
        resolverId: "test/anthropic-key",
      },
    ],
    resolvers: [
      {
        version: CREDENTIAL_SLOT_RESOLVER_VERSION,
        resolverId: "test/anthropic-key",
        slotId: "lobster/anthropic-key",
        placement: "header",
        headerName: "x-api-key",
        allowedOrigins: ["https://api.anthropic.com"],
        resolve: async () => ({ value: "******" }),
      },
    ],
  });
  return {
    credentialSlot: {
      id: "lobster/anthropic-key",
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
  fixture.manifest.bundleVersion = "1.1.0";
  fixture.manifest.contributions.push(
    {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: "provider-request-traffic-policy/v1",
      required: true,
      readinessCriteria: ["provider.request.policy.lobster"],
    },
    {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: "lobster/anthropic-direct",
      version: "anthropic-direct-model-provider-adapter/v1",
      required: true,
      readinessCriteria: ["model.provider.anthropic-direct"],
    },
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "lobster/anthropic-key",
      version: "credential-slot-resolver/v1",
      required: true,
      readinessCriteria: ["provider.request.credentials.anthropic"],
    },
  );
  for (const contribution of fixture.manifest.contributions.slice(-3)) {
    fixture.availableContributions.push({
      owner: contribution.owner,
      kind: contribution.kind,
      id: contribution.id,
      version: contribution.version,
      provenance: {
        pluginId: "lobster-host",
        source: "/plugins/lobster-host/openclaw.plugin.json",
        origin: "config",
      },
    } as AvailableHostIntegrationContributionV1);
  }
  return prepareHostIntegrationBundleSnapshotV1(fixture);
}

function fence() {
  return {
    configGeneration: "config-8",
    bundleGeneration: "lobster/host@1.1.0",
    ownerGeneration: "anthropic-owner-1",
  };
}

afterEach(() => {
  clearCurrentProviderRequestTrafficPolicyV1();
});

describe("Anthropic direct hosted binding", () => {
  it.each(["local", "hosted"] as const)(
    "preserves attachment and streaming semantics through the %s dispatcher",
    async (mode) => {
      const responseBody =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n';
      const dispatch = vi.fn(async (request) => {
        const headers = new Headers(request.init.headers);
        if (mode === "local") {
          expect(headers.get("x-api-key")).toBe("******");
        } else {
          expect(headers.get("x-api-key")).toBeNull();
          expect(request.credentialSlotRefs).toEqual(["lobster/anthropic-key"]);
        }
        expect(request.url).toBe(anthropicFixture.expected.url);
        expect(headers.get("accept")).toBe("text/event-stream");
        const body = JSON.parse(Buffer.from(request.init.body as Uint8Array).toString());
        expect(body.messages[0].content[0].type).toBe("document");
        expect(body.messages[0].content).toContainEqual(expect.objectContaining({ type: "image" }));
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      const hostedImplementations = prepareImplementations({
        mode: "hosted",
        dispatch: { dispatch },
      });
      const selectedDispatcher =
        mode === "local"
          ? createLocalOneHopFetchDispatcher(
              async (url, init) =>
                await dispatch({
                  url,
                  init,
                  networkGuard: {
                    version: "network-guard/v1",
                    target: {
                      protocol: "https:",
                      origin: "https://api.anthropic.com",
                      hostname: "api.anthropic.com",
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
                  credentialSlotRefs: ["lobster/anthropic-key"],
                }),
              hostedImplementations.credentialSlot.bindings,
            )
          : { dispatch };
      clearCurrentProviderRequestTrafficPolicyV1();
      const binding = prepareAnthropicDirectHostedBindingV1({
        selection: selection(),
        adapterConfig: anthropicFixture.request.config,
        bundle: bundle(),
        implementations: prepareImplementations({
          mode,
          dispatch: selectedDispatcher,
        }),
      });

      const result = await binding.dispatch({
        fence: fence(),
        context: anthropicFixture.request.context,
        method: anthropicFixture.request.method,
        headers: anthropicFixture.request.headers,
        body: JSON.stringify(anthropicFixture.request.body),
      });

      await expect(result.response.text()).resolves.toBe(responseBody);
      expect(binding.mode).toBe(mode);
      expect(binding.policyGeneration).toBe("policy-12");
      expect(binding.ownerEvidence).toMatchObject({
        id: "lobster/anthropic-direct",
        state: "ready",
        ownerGeneration: "anthropic-owner-1",
        bundleGeneration: "lobster/host@1.1.0",
      });
      await result.release();
    },
  );

  it.each([
    ["configGeneration", "stale-config-generation"],
    ["bundleGeneration", "stale-bundle-generation"],
    ["ownerGeneration", "stale-owner-generation"],
  ] as const)("fences stale %s independently", async (field, code) => {
    const binding = prepareAnthropicDirectHostedBindingV1({
      selection: selection(),
      adapterConfig: anthropicFixture.request.config,
      bundle: bundle(),
      implementations: prepareImplementations({
        mode: "hosted",
        dispatch: { dispatch: vi.fn() },
      }),
    });

    await expect(
      binding.dispatch({
        fence: { ...fence(), [field]: "stale" },
        context: anthropicFixture.request.context,
        method: anthropicFixture.request.method,
        body: JSON.stringify(anthropicFixture.request.body),
      }),
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("fails closed when policy selects a different dispatcher", async () => {
    const dispatch = vi.fn();
    const binding = prepareAnthropicDirectHostedBindingV1({
      selection: selection(),
      adapterConfig: anthropicFixture.request.config,
      bundle: bundle(),
      implementations: prepareImplementations({
        mode: "hosted",
        dispatch: { dispatch },
        dispatchBindingId: "other/dispatcher",
      }),
    });

    await expect(
      binding.dispatch({
        fence: fence(),
        context: anthropicFixture.request.context,
        method: anthropicFixture.request.method,
        body: JSON.stringify(anthropicFixture.request.body),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "traffic-policy-route-mismatch" }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requires the Anthropic adapter contribution and snapshots selection state", () => {
    const incomplete = structuredClone(bundleFixture);
    incomplete.manifest.bundleVersion = "1.1.0";
    incomplete.manifest.contributions.push(
      {
        owner: "provider-request",
        kind: "provider-request-traffic-policy",
        id: "lobster/enterprise-egress",
        version: "provider-request-traffic-policy/v1",
        required: true,
        readinessCriteria: ["provider.request.policy.lobster"],
      },
      {
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "lobster/anthropic-direct",
        version: "anthropic-direct-model-provider-adapter/v1",
        required: false,
        readinessCriteria: ["model.provider.anthropic-direct"],
      },
      {
        owner: "provider-request",
        kind: "credential-slot-resolver",
        id: "lobster/anthropic-key",
        version: "credential-slot-resolver/v1",
        required: true,
        readinessCriteria: ["provider.request.credentials.anthropic"],
      },
    );
    for (const contribution of incomplete.manifest.contributions.slice(-3)) {
      if (contribution.id === "lobster/anthropic-direct") {
        continue;
      }
      incomplete.availableContributions.push({
        owner: contribution.owner,
        kind: contribution.kind,
        id: contribution.id,
        version: contribution.version,
        provenance: {
          pluginId: "lobster-host",
          source: "/plugins/lobster-host/openclaw.plugin.json",
          origin: "config",
        },
      } as AvailableHostIntegrationContributionV1);
    }
    expect(() =>
      prepareAnthropicDirectHostedBindingV1({
        selection: selection(),
        adapterConfig: anthropicFixture.request.config,
        bundle: prepareHostIntegrationBundleSnapshotV1(incomplete),
        implementations: prepareImplementations({
          mode: "hosted",
          dispatch: { dispatch: vi.fn() },
        }),
      }),
    ).toThrow();

    const mutableSelection = selection();
    const binding = prepareAnthropicDirectHostedBindingV1({
      selection: mutableSelection,
      adapterConfig: anthropicFixture.request.config,
      bundle: bundle(),
      implementations: prepareImplementations({
        mode: "hosted",
        dispatch: { dispatch: vi.fn() },
      }),
    });
    mutableSelection.providerId = "changed";
    expect(binding.selection.providerId).toBe("anthropic");
  });
});
