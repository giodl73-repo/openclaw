import { isDeepStrictEqual } from "node:util";
import type { PreparedCredentialSlotBindingsV1 } from "../infra/net/credential-slot.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { OneHopFetchDispatcher } from "../infra/net/one-hop-fetch-dispatcher.js";
import {
  evaluateProviderRequestTrafficPolicyV1,
  PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
  type ProviderRequestTrafficPolicyCapabilityV1,
  type ProviderRequestTrafficPolicyDecisionV1,
  type ProviderRequestTrafficPolicyEndpointClassV1,
  type ProviderRequestTrafficPolicySnapshotV1,
  type ProviderRequestTrafficPolicyTransportV1,
} from "./provider-request-traffic-policy.js";

export const PROVIDER_REQUEST_DISPATCHER_VERSION = "provider-request-dispatcher/v1" as const;

export type ProviderRequestHostedBindingImplementationsV1 = {
  credentialSlot: {
    id: string;
    version: string;
    bindings: PreparedCredentialSlotBindingsV1;
  };
  trafficPolicy: {
    id: string;
    version: typeof PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION;
    snapshot: ProviderRequestTrafficPolicySnapshotV1;
  };
  dispatcher: {
    id: string;
    version: typeof PROVIDER_REQUEST_DISPATCHER_VERSION;
    routeProfileId: string;
    mode: "local" | "hosted";
    dispatcher: OneHopFetchDispatcher;
  };
};

export type PreparedHostedProviderRequestV1 = {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  credentialSlotRefs: string[];
};

type HostedDispatchFailureCode = "traffic-policy-denied" | "traffic-policy-route-mismatch";

function allowDecision(params: {
  policy: ProviderRequestTrafficPolicySnapshotV1;
  provider: string;
  capability: ProviderRequestTrafficPolicyCapabilityV1;
  transport: ProviderRequestTrafficPolicyTransportV1;
  endpointClass: ProviderRequestTrafficPolicyEndpointClassV1;
  url: string;
  timeoutMs?: number;
  providerLabel: string;
  createError: (code: HostedDispatchFailureCode, message: string) => Error;
}): Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }> {
  const decision = evaluateProviderRequestTrafficPolicyV1(params.policy, {
    provider: params.provider,
    capability: params.capability,
    transport: params.transport,
    endpointClass: params.endpointClass,
    url: params.url,
    allowPrivateNetwork: false,
    timeoutMs: params.timeoutMs,
  });
  if (!decision || decision.action === "deny") {
    throw params.createError(
      "traffic-policy-denied",
      `${params.providerLabel} request is not allowed by ${params.policy.id}`,
    );
  }
  return decision;
}

export async function dispatchHostedProviderRequestV1(params: {
  policy: ProviderRequestTrafficPolicySnapshotV1;
  providerId: string;
  providerLabel: string;
  capability: ProviderRequestTrafficPolicyCapabilityV1;
  transport: ProviderRequestTrafficPolicyTransportV1;
  endpointClass: ProviderRequestTrafficPolicyEndpointClassV1;
  dispatcherSelectionId: string;
  dispatcherRouteProfileId: string;
  dispatcher: OneHopFetchDispatcher;
  request: PreparedHostedProviderRequestV1;
  signal?: AbortSignal;
  validateUrl?: (url: URL) => void;
  createError: (code: HostedDispatchFailureCode, message: string) => Error;
}): Promise<{
  response: Response;
  release: () => Promise<void>;
  policyDecision: Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }>;
}> {
  const decision = allowDecision({
    policy: params.policy,
    provider: params.providerId,
    capability: params.capability,
    transport: params.transport,
    endpointClass: params.endpointClass,
    url: params.request.url,
    providerLabel: params.providerLabel,
    createError: params.createError,
  });
  if (
    decision.dispatchBindingId !== params.dispatcherSelectionId ||
    decision.routeProfileId !== params.dispatcherRouteProfileId
  ) {
    throw params.createError(
      "traffic-policy-route-mismatch",
      `${params.providerLabel} traffic policy did not select the prepared dispatcher and route`,
    );
  }
  const validateUrl = (url: URL) => {
    const redirected = allowDecision({
      policy: params.policy,
      provider: params.providerId,
      capability: params.capability,
      transport: params.transport,
      endpointClass: params.endpointClass,
      url: url.toString(),
      timeoutMs: decision.timeoutMs,
      providerLabel: params.providerLabel,
      createError: params.createError,
    });
    if (
      redirected.policyGeneration !== decision.policyGeneration ||
      redirected.routeProfileId !== decision.routeProfileId ||
      redirected.dispatchBindingId !== decision.dispatchBindingId ||
      redirected.allowPrivateNetwork !== decision.allowPrivateNetwork ||
      redirected.timeoutMs !== decision.timeoutMs ||
      !isDeepStrictEqual(redirected.dispatcherPolicy, decision.dispatcherPolicy)
    ) {
      throw params.createError(
        "traffic-policy-route-mismatch",
        `${params.providerLabel} redirect changed the prepared traffic-policy route`,
      );
    }
    params.validateUrl?.(url);
  };
  const result = await fetchWithSsrFGuard({
    url: params.request.url,
    init: {
      method: params.request.method,
      headers: params.request.headers,
      ...(params.request.body ? { body: Buffer.from(params.request.body) } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    },
    oneHopDispatcher: params.dispatcher,
    credentialSlotRefs: params.request.credentialSlotRefs,
    dispatcherPolicy: decision.dispatcherPolicy,
    timeoutMs: decision.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    allowCrossOriginUnsafeRedirectReplay: false,
    validateUrl,
    policy: decision.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
  });
  return {
    response: result.response,
    release: result.release,
    policyDecision: decision,
  };
}
