import { readFileSync } from "node:fs";
import type {
  HostIntegrationBundleSnapshotV1,
  ProviderRequestHostedBindingImplementationsV1,
} from "openclaw/plugin-sdk/provider-request-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  M365MAIL_GRAPH_HOSTED_BINDING_VERSION,
  prepareM365MailGraphHostedBindingV1,
  type M365MailGraphHostedBindingSelectionV1,
} from "./graph-hosted-binding.js";
import {
  M365MAIL_GRAPH_ALLOWED_ORIGINS,
  type M365MailGraphOperationV1,
  type M365MailGraphRequestContextV1,
} from "./graph-request.js";

type HostedDispatch =
  ProviderRequestHostedBindingImplementationsV1["dispatcher"]["dispatcher"]["dispatch"];

type Fixture = {
  request: {
    context: M365MailGraphRequestContextV1;
    operation: M365MailGraphOperationV1;
  };
  expected: {
    url: string;
    body: string;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/m365mail-graph-request-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function selection(
  overrides: Partial<M365MailGraphHostedBindingSelectionV1> = {},
  trafficPolicyId = "example/enterprise-egress",
): M365MailGraphHostedBindingSelectionV1 {
  return {
    version: M365MAIL_GRAPH_HOSTED_BINDING_VERSION,
    configGeneration: "config-6",
    ownerGeneration: "m365mail-owner-1",
    configSource: {
      source: "openclaw.json",
      path: "channels.m365mail",
    },
    credentialSlot: {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: "m365mail/graph-token",
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
  const selected = selection({}, trafficPolicyId);
  return {
    version: "host-integration-bundle/v1",
    id: "example/host",
    bundleVersion: "1.2.0",
    generation: "bundle-m365mail-1",
    inventory: [
      {
        ...selected.credentialSlot,
        required: true,
        readinessCriteria: ["provider.request.credentials.graph"],
        status: "resolved",
        resolvedVersion: "credential-slot-resolver/v1",
        provenance: { pluginId: "example-host", source: "extension", origin: "bundled" },
      },
      {
        ...selected.trafficPolicy,
        required: true,
        readinessCriteria: ["provider.request.policy.example"],
        status: "resolved",
        resolvedVersion: "provider-request-traffic-policy/v1",
        provenance: { pluginId: "example-host", source: "extension", origin: "bundled" },
      },
      {
        ...selected.dispatcher,
        required: true,
        readinessCriteria: ["provider.request.dispatch.example"],
        status: "resolved",
        resolvedVersion: "provider-request-dispatcher/v1",
        provenance: { pluginId: "example-host", source: "extension", origin: "bundled" },
      },
    ],
  };
}

function implementations(
  dispatch: HostedDispatch,
  dispatchBindingId = "example/reverse-provider",
  trafficPolicyId = "example/enterprise-egress",
): ProviderRequestHostedBindingImplementationsV1 {
  return {
    credentialSlot: {
      id: "m365mail/graph-token",
      version: "credential-slot-resolver/v1",
      bindings: {
        readiness: () => [
          {
            slotId: "m365mail/graph-token",
            resolverId: "test/graph-token",
            version: "credential-slot/v1",
            resolverVersion: "credential-slot-resolver/v1",
            placement: "header",
            headerName: "authorization",
            allowedOrigins: [...M365MAIL_GRAPH_ALLOWED_ORIGINS],
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
        generation: "policy-9",
        required: true,
        provenance: { source: "test", revision: "revision-1" },
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
            id: "m365mail-graph",
            match: {
              providers: ["m365mail-graph"],
              capabilities: ["channel"],
              transports: ["request-response"],
              endpointClasses: ["microsoft-graph-mail"],
            },
            outcome: {
              action: "allow",
              routeProfileId: "example/managed",
              allowedOrigins: [...M365MAIL_GRAPH_ALLOWED_ORIGINS],
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

describe("Microsoft 365 Email Graph hosted binding", () => {
  it("dispatches final owner bytes through the selected slot and route", async () => {
    const dispatch = vi.fn<HostedDispatch>(async () => new Response(null, { status: 202 }));
    const trafficPolicyId = "example/m365mail-egress";
    const binding = prepareM365MailGraphHostedBindingV1({
      selection: selection({}, trafficPolicyId),
      bundle: bundle(trafficPolicyId),
      implementations: implementations(dispatch, "example/reverse-provider", trafficPolicyId),
    });

    const result = await binding.dispatch({
      fence: {
        configGeneration: binding.configGeneration,
        bundleGeneration: binding.bundleGeneration,
        ownerGeneration: binding.ownerGeneration,
      },
      ...fixture.request,
    });

    expect(binding.readiness).toEqual({
      owner: "channel",
      channel: "m365mail",
      state: "ready",
      reason: "BindingPrepared",
      authorityMode: "openclaw",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    const dispatched = dispatch.mock.calls[0]?.[0];
    expect(dispatched?.url).toBe(fixture.expected.url);
    expect(dispatched?.credentialSlotRefs).toEqual(["m365mail/graph-token"]);
    expect(new TextDecoder().decode(dispatched?.init.body as Uint8Array)).toBe(
      fixture.expected.body,
    );
    expect(result.policyDecision).toMatchObject({
      action: "allow",
      routeProfileId: "example/managed",
      dispatchBindingId: "example/reverse-provider",
    });
  });

  it("rejects redirects, stale generations, and route drift before replay", async () => {
    const redirect = vi.fn<HostedDispatch>(async () => {
      return new Response(null, {
        status: 307,
        headers: { location: `${fixture.expected.url}?redirected=1` },
      });
    });
    const binding = prepareM365MailGraphHostedBindingV1({
      selection: selection(),
      bundle: bundle(),
      implementations: implementations(redirect),
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
    ).rejects.toMatchObject({ code: "traffic-policy-denied" });
    expect(redirect).toHaveBeenCalledOnce();

    const dispatch = vi.fn<HostedDispatch>(async () => new Response(null, { status: 202 }));
    await expect(
      binding.dispatch({
        fence: {
          configGeneration: "stale",
          bundleGeneration: binding.bundleGeneration,
          ownerGeneration: binding.ownerGeneration,
        },
        ...fixture.request,
      }),
    ).rejects.toMatchObject({ code: "stale-config-generation" });

    const drifted = prepareM365MailGraphHostedBindingV1({
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
    ).rejects.toMatchObject({ code: "traffic-policy-route-mismatch" });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
