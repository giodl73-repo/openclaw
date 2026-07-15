import { readFileSync } from "node:fs";
import type {
  HostIntegrationBundleSnapshotV1,
  ProviderRequestHostedBindingImplementationsV1,
} from "openclaw/plugin-sdk/provider-request-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MSTEAMS_ACF_ALLOWED_ORIGINS,
  type MSTeamsAcfRequestContextV1,
} from "./acf-channel-request.js";
import {
  MSTEAMS_ACF_HOSTED_BINDING_VERSION,
  prepareMSTeamsAcfHostedBindingV1,
  type MSTeamsAcfHostedBindingSelectionV1,
} from "./acf-hosted-binding.js";

type HostedDispatch =
  ProviderRequestHostedBindingImplementationsV1["dispatcher"]["dispatcher"]["dispatch"];

type Fixture = {
  request: {
    context: MSTeamsAcfRequestContextV1;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/msteams-acf-channel-request-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function selection(
  overrides: Partial<MSTeamsAcfHostedBindingSelectionV1> = {},
  trafficPolicyId = "example/enterprise-egress",
): MSTeamsAcfHostedBindingSelectionV1 {
  return {
    version: MSTEAMS_ACF_HOSTED_BINDING_VERSION,
    configGeneration: "config-5",
    ownerGeneration: "msteams-owner-3",
    configSource: {
      source: "openclaw.json",
      path: "channels.msteams",
    },
    credentialSlot: {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "msteams/acf-token",
      version: "credential-slot-resolver/v1",
    },
    trafficPolicy: {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: trafficPolicyId,
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

function bundle(trafficPolicyId = "example/enterprise-egress"): HostIntegrationBundleSnapshotV1 {
  return {
    version: "host-integration-bundle/v1",
    id: "example/host",
    bundleVersion: "1.1.0",
    generation: "bundle-msteams-1",
    inventory: [
      {
        ...selection().credentialSlot,
        required: true,
        readinessCriteria: ["provider.request.credentials.acf"],
        status: "resolved",
        resolvedVersion: "credential-slot-resolver/v1",
        provenance: {
          pluginId: "example-host",
          source: "extension",
          origin: "bundled",
        },
      },
      {
        ...selection({}, trafficPolicyId).trafficPolicy,
        required: true,
        readinessCriteria: ["provider.request.policy.example"],
        status: "resolved",
        resolvedVersion: "provider-request-traffic-policy/v1",
        provenance: {
          pluginId: "example-host",
          source: "extension",
          origin: "bundled",
        },
      },
      {
        ...selection().dispatcher,
        required: true,
        readinessCriteria: ["provider.request.dispatch.example"],
        status: "resolved",
        resolvedVersion: "provider-request-dispatcher/v1",
        provenance: {
          pluginId: "example-host",
          source: "extension",
          origin: "bundled",
        },
      },
    ],
  };
}

function implementations(
  dispatch: ProviderRequestHostedBindingImplementationsV1["dispatcher"]["dispatcher"]["dispatch"],
  dispatchBindingId = "example/reverse-provider",
  trafficPolicyId = "example/enterprise-egress",
): ProviderRequestHostedBindingImplementationsV1 {
  return {
    credentialSlot: {
      id: "msteams/acf-token",
      version: "credential-slot-resolver/v1",
      bindings: {
        readiness: () => [
          {
            slotId: "msteams/acf-token",
            resolverId: "test/acf-token",
            version: "credential-slot/v1",
            resolverVersion: "credential-slot-resolver/v1",
            placement: "header",
            headerName: "authorization",
            allowedOrigins: [...MSTEAMS_ACF_ALLOWED_ORIGINS],
            required: true,
          },
        ],
        apply: async ({ init }) => init,
      },
    },
    trafficPolicy: {
      id: trafficPolicyId,
      version: "provider-request-traffic-policy/v1",
      snapshot: {
        version: "provider-request-traffic-policy/v1",
        id: trafficPolicyId,
        generation: "policy-8",
        required: true,
        provenance: {
          source: "test",
          revision: "revision-1",
        },
        readiness: "ready",
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
            id: "msteams-acf",
            match: {
              providers: ["msteams-acf"],
              capabilities: ["channel"],
              transports: ["request-response"],
              endpointClasses: ["bot-framework-connector"],
            },
            outcome: {
              action: "allow",
              routeProfileId: "example/managed",
              allowedOrigins: [...MSTEAMS_ACF_ALLOWED_ORIGINS],
              allowPrivateNetwork: false,
              maximumTimeoutMs: 30_000,
            },
          },
        ],
      },
    },
    dispatcher: {
      id: "example/reverse-provider",
      version: "provider-request-dispatcher/v1",
      routeProfileId: "example/managed",
      mode: "hosted",
      dispatcher: { dispatch },
    },
  };
}

describe("Microsoft Teams ACF hosted binding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes final Channel-owned bytes through the selected physical dispatcher", async () => {
    const dispatch = vi.fn<HostedDispatch>(async () => {
      return new Response(JSON.stringify({ id: "activity-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const trafficPolicyId = "example/msteams-egress";
    const selected = selection({}, trafficPolicyId);
    const impl = implementations(dispatch, "example/reverse-provider", trafficPolicyId);
    const binding = prepareMSTeamsAcfHostedBindingV1({
      selection: selected,
      bundle: bundle(trafficPolicyId),
      implementations: impl,
    });
    selected.dispatcher.id = "mutated/dispatcher";
    impl.dispatcher.routeProfileId = "mutated/route";

    expect(binding.readiness).toEqual({
      owner: "channel",
      channel: "msteams",
      state: "ready",
      reason: "BindingPrepared",
      authorityMode: "openclaw",
    });
    const result = await binding.dispatch({
      fence: {
        configGeneration: binding.configGeneration,
        bundleGeneration: binding.bundleGeneration,
        ownerGeneration: binding.ownerGeneration,
      },
      ...fixture.request,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    const dispatched = dispatch.mock.calls[0]?.[0];
    expect(dispatched?.url).toBe(fixture.request.url);
    expect(dispatched?.credentialSlotRefs).toEqual(["msteams/acf-token"]);
    expect(new TextDecoder().decode(dispatched?.init.body as Uint8Array)).toBe(
      fixture.request.body,
    );
    expect(result.policyDecision).toMatchObject({
      action: "allow",
      routeProfileId: "example/managed",
      dispatchBindingId: "example/reverse-provider",
    });
    expect(await result.response.json()).toEqual({ id: "activity-1" });
    await result.release();
  });

  it("rejects Bot Connector redirects before replaying Channel-owned bytes", async () => {
    const dispatch = vi.fn<HostedDispatch>(async () => {
      return new Response(null, {
        status: 307,
        headers: { location: `${fixture.request.url}/activity-1` },
      });
    });
    const binding = prepareMSTeamsAcfHostedBindingV1({
      selection: selection(),
      bundle: bundle(),
      implementations: implementations(dispatch),
    });

    await expect(
      binding.dispatch({
        fence: {
          configGeneration: binding.configGeneration,
          bundleGeneration: binding.bundleGeneration,
          ownerGeneration: binding.ownerGeneration,
        },
        ...fixture.request,
      }),
    ).rejects.toMatchObject({
      code: "traffic-policy-denied",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects stale authority and route drift before physical dispatch", async () => {
    const dispatch = vi.fn(async () => new Response(null, { status: 202 }));
    const binding = prepareMSTeamsAcfHostedBindingV1({
      selection: selection(),
      bundle: bundle(),
      implementations: implementations(dispatch),
    });

    await expect(
      binding.dispatch({
        fence: {
          configGeneration: "stale",
          bundleGeneration: binding.bundleGeneration,
          ownerGeneration: binding.ownerGeneration,
        },
        ...fixture.request,
      }),
    ).rejects.toMatchObject({
      code: "stale-config-generation",
    });
    expect(dispatch).not.toHaveBeenCalled();

    const drifted = prepareMSTeamsAcfHostedBindingV1({
      selection: selection(),
      bundle: bundle(),
      implementations: implementations(dispatch, "other/dispatcher"),
    });
    await expect(
      drifted.dispatch({
        fence: {
          configGeneration: drifted.configGeneration,
          bundleGeneration: drifted.bundleGeneration,
          ownerGeneration: drifted.ownerGeneration,
        },
        ...fixture.request,
      }),
    ).rejects.toMatchObject({
      code: "traffic-policy-route-mismatch",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
