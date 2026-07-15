import { isDeepStrictEqual } from "node:util";
import {
  resolveHostIntegrationContributionFromSnapshotV1,
  type HostIntegrationBundleSnapshotV1,
  type HostIntegrationContributionReferenceV1,
} from "../../hosting/host-integration-bundle.js";
import type { HostIntegrationOwnerEvidenceV1 } from "../../hosting/host-integration-status.js";
import type { PreparedCredentialSlotBindingsV1 } from "../../infra/net/credential-slot.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { OneHopFetchDispatcher } from "../../infra/net/one-hop-fetch-dispatcher.js";
import {
  PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
  evaluateProviderRequestTrafficPolicyV1,
  type ProviderRequestTrafficPolicyDecisionV1,
  type ProviderRequestTrafficPolicySnapshotV1,
} from "../provider-request-traffic-policy.js";
import {
  WEBIQ_ADAPTER_ID,
  WEBIQ_ADAPTER_VERSION,
  WEBIQ_API_KEY_SLOT_ID,
  adaptWebIqResponseV1,
  prepareWebIqRequestV1,
  type WebIqAdapterConfigV1,
  type WebIqSearchRequestV1,
} from "./webiq.js";

export const WEBIQ_HOSTED_BINDING_VERSION = "webiq-hosted-binding/v1" as const;
export const PROVIDER_REQUEST_DISPATCHER_VERSION = "provider-request-dispatcher/v1" as const;

type Reference = HostIntegrationContributionReferenceV1;

export type WebIqHostedBindingSelectionV1 = {
  version: typeof WEBIQ_HOSTED_BINDING_VERSION;
  configGeneration: string;
  ownerGeneration: string;
  configSource: { source: string; path?: string };
  providerId: string;
  adapter: Reference;
  credentialSlot: Reference;
  trafficPolicy: Reference;
  dispatcher: Reference;
};

export type WebIqHostedBindingImplementationsV1 = {
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

export type WebIqHostedBindingFenceV1 = {
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
};

export type WebIqHostedBindingFailureCode =
  | "invalid-selection"
  | "incompatible-implementation"
  | "traffic-policy-denied"
  | "traffic-policy-route-mismatch"
  | "stale-config-generation"
  | "stale-bundle-generation"
  | "stale-owner-generation";

export class WebIqHostedBindingError extends Error {
  readonly code: WebIqHostedBindingFailureCode;

  constructor(code: WebIqHostedBindingFailureCode, message: string) {
    super(message);
    this.name = "WebIqHostedBindingError";
    this.code = code;
  }
}

export type PreparedWebIqHostedBindingV1 = {
  version: typeof WEBIQ_HOSTED_BINDING_VERSION;
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
  policyGeneration: string;
  mode: "local" | "hosted";
  selection: Readonly<WebIqHostedBindingSelectionV1>;
  ownerEvidence: HostIntegrationOwnerEvidenceV1;
  dispatch: (params: {
    fence: WebIqHostedBindingFenceV1;
    request: WebIqSearchRequestV1;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }) => Promise<{
    response: Response;
    release: () => Promise<void>;
    policyDecision: Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }>;
  }>;
};

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;

function generation(value: string, label: string): string {
  const normalized = value.trim();
  if (!GENERATION_RE.test(normalized)) {
    throw new WebIqHostedBindingError("invalid-selection", `${label} is invalid`);
  }
  return normalized;
}

function freezeReference(reference: Reference): Reference {
  return Object.freeze({ ...reference });
}

function expected(reference: Reference, value: Reference, label: string): void {
  if (
    reference.owner !== value.owner ||
    reference.kind !== value.kind ||
    reference.id !== value.id ||
    reference.version !== value.version
  ) {
    throw new WebIqHostedBindingError(
      "invalid-selection",
      `${label} must select ${value.id}@${value.version}`,
    );
  }
}

function implementation(
  selected: Reference,
  value: { id: string; version: string },
  label: string,
): void {
  if (selected.id !== value.id || selected.version !== value.version) {
    throw new WebIqHostedBindingError(
      "incompatible-implementation",
      `${label} implementation does not match the selected contribution`,
    );
  }
}

function fence(binding: PreparedWebIqHostedBindingV1, value: WebIqHostedBindingFenceV1): void {
  for (const [actual, expectedValue, code] of [
    [value.configGeneration, binding.configGeneration, "stale-config-generation"],
    [value.bundleGeneration, binding.bundleGeneration, "stale-bundle-generation"],
    [value.ownerGeneration, binding.ownerGeneration, "stale-owner-generation"],
  ] as const) {
    if (actual !== expectedValue) {
      throw new WebIqHostedBindingError(code, "WebIQ hosted binding generation is stale");
    }
  }
}

function allow(
  policy: ProviderRequestTrafficPolicySnapshotV1,
  provider: string,
  url: string,
  timeoutMs?: number,
): Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }> {
  const decision = evaluateProviderRequestTrafficPolicyV1(policy, {
    provider,
    capability: "web-search",
    transport: "request-response",
    endpointClass: "custom",
    url,
    allowPrivateNetwork: false,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (!decision || decision.action === "deny") {
    throw new WebIqHostedBindingError(
      "traffic-policy-denied",
      `WebIQ request is not allowed by ${policy.id}`,
    );
  }
  return decision;
}

export function prepareWebIqHostedBindingV1(params: {
  selection: WebIqHostedBindingSelectionV1;
  adapterConfig: WebIqAdapterConfigV1;
  bundle: HostIntegrationBundleSnapshotV1;
  implementations: WebIqHostedBindingImplementationsV1;
}): PreparedWebIqHostedBindingV1 {
  if (params.selection.version !== WEBIQ_HOSTED_BINDING_VERSION) {
    throw new WebIqHostedBindingError("invalid-selection", "WebIQ binding version is unsupported");
  }
  expected(
    params.selection.adapter,
    {
      owner: "web-search-provider",
      kind: "web-search-provider-adapter",
      id: WEBIQ_ADAPTER_ID,
      version: WEBIQ_ADAPTER_VERSION,
    },
    "WebIQ adapter",
  );
  expected(
    params.selection.credentialSlot,
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: WEBIQ_API_KEY_SLOT_ID,
      version: "credential-slot-resolver/v1",
    },
    "WebIQ credential slot",
  );
  if (
    params.selection.trafficPolicy.owner !== "provider-request" ||
    params.selection.trafficPolicy.kind !== "provider-request-traffic-policy" ||
    params.selection.trafficPolicy.version !== PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION
  ) {
    throw new WebIqHostedBindingError(
      "invalid-selection",
      "WebIQ traffic policy selection is incompatible",
    );
  }
  if (
    params.selection.dispatcher.owner !== "provider-request" ||
    params.selection.dispatcher.kind !== "provider-request-dispatcher" ||
    params.selection.dispatcher.version !== PROVIDER_REQUEST_DISPATCHER_VERSION
  ) {
    throw new WebIqHostedBindingError("invalid-selection", "WebIQ dispatcher is incompatible");
  }
  for (const reference of [
    params.selection.adapter,
    params.selection.credentialSlot,
    params.selection.trafficPolicy,
    params.selection.dispatcher,
  ]) {
    resolveHostIntegrationContributionFromSnapshotV1(params.bundle, reference);
  }
  implementation(
    params.selection.credentialSlot,
    params.implementations.credentialSlot,
    "Credential slot",
  );
  implementation(
    params.selection.trafficPolicy,
    params.implementations.trafficPolicy,
    "Traffic policy",
  );
  implementation(params.selection.dispatcher, params.implementations.dispatcher, "Dispatcher");
  if (params.implementations.trafficPolicy.snapshot.id !== params.selection.trafficPolicy.id) {
    throw new WebIqHostedBindingError(
      "incompatible-implementation",
      "Traffic policy snapshot does not match the selected contribution",
    );
  }
  const configGeneration = generation(params.selection.configGeneration, "WebIQ config generation");
  const ownerGeneration = generation(params.selection.ownerGeneration, "WebIQ owner generation");
  const providerId = params.selection.providerId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new WebIqHostedBindingError("invalid-selection", "WebIQ provider ID is invalid");
  }
  const source = params.selection.configSource.source.trim();
  if (!source) {
    throw new WebIqHostedBindingError("invalid-selection", "WebIQ config source is required");
  }
  const bundleGeneration = params.bundle.generation;
  const adapterConfig = Object.freeze({ ...params.adapterConfig });
  const policy = params.implementations.trafficPolicy.snapshot;
  const credentialSlots = params.implementations.credentialSlot.bindings.readiness().map((slot) =>
    Object.freeze({
      ...slot,
      allowedOrigins: Object.freeze([...slot.allowedOrigins]),
    }),
  );
  const dispatcherTarget = params.implementations.dispatcher.dispatcher;
  const dispatcher = Object.freeze({ dispatch: dispatcherTarget.dispatch.bind(dispatcherTarget) });
  const dispatcherId = params.selection.dispatcher.id;
  const routeProfileId = params.implementations.dispatcher.routeProfileId;
  const path = params.selection.configSource.path?.trim();
  const selection = Object.freeze({
    ...params.selection,
    configGeneration,
    ownerGeneration,
    providerId,
    configSource: Object.freeze({
      source,
      ...(path ? { path } : {}),
    }),
    adapter: freezeReference(params.selection.adapter),
    credentialSlot: freezeReference(params.selection.credentialSlot),
    trafficPolicy: freezeReference(params.selection.trafficPolicy),
    dispatcher: freezeReference(params.selection.dispatcher),
  });
  const binding: PreparedWebIqHostedBindingV1 = {
    version: WEBIQ_HOSTED_BINDING_VERSION,
    configGeneration,
    bundleGeneration,
    ownerGeneration,
    policyGeneration: policy.generation,
    mode: params.implementations.dispatcher.mode,
    selection,
    ownerEvidence: Object.freeze({
      owner: "web-search-provider",
      kind: "web-search-provider-adapter",
      id: WEBIQ_ADAPTER_ID,
      bundleGeneration,
      state: "ready",
      reason: "BindingPrepared",
      message: "WebIQ web-search owner binding is prepared and inactive.",
      config: Object.freeze({
        source,
        ...(path ? { path } : {}),
      }),
      ownerGeneration,
      reloadDisposition: "reload-required",
      authorityMode: "openclaw",
    }),
    dispatch: async ({ fence: requestedFence, request, headers, signal }) => {
      fence(binding, requestedFence);
      const prepared = prepareWebIqRequestV1({
        config: adapterConfig,
        request,
        ...(headers ? { headers } : {}),
        credentialSlots,
      });
      const decision = allow(policy, providerId, prepared.url);
      if (
        decision.dispatchBindingId !== dispatcherId ||
        decision.routeProfileId !== routeProfileId
      ) {
        throw new WebIqHostedBindingError(
          "traffic-policy-route-mismatch",
          "WebIQ traffic policy did not select the prepared dispatcher and route",
        );
      }
      const startedAt = Date.now();
      const result = await fetchWithSsrFGuard({
        url: prepared.url,
        init: {
          method: prepared.method,
          headers: prepared.headers,
          body: Buffer.from(prepared.body),
          ...(signal ? { signal } : {}),
        },
        oneHopDispatcher: dispatcher,
        credentialSlotRefs: prepared.credentialSlotRefs,
        dispatcherPolicy: decision.dispatcherPolicy,
        timeoutMs: decision.timeoutMs,
        ...(signal ? { signal } : {}),
        allowCrossOriginUnsafeRedirectReplay: false,
        validateUrl: (url) => {
          if (url.protocol !== "https:") {
            throw new WebIqHostedBindingError(
              "traffic-policy-route-mismatch",
              "WebIQ redirects must preserve HTTPS",
            );
          }
          const redirected = allow(policy, providerId, url.toString(), decision.timeoutMs);
          if (
            redirected.policyGeneration !== decision.policyGeneration ||
            redirected.routeProfileId !== decision.routeProfileId ||
            redirected.dispatchBindingId !== decision.dispatchBindingId ||
            redirected.allowPrivateNetwork !== decision.allowPrivateNetwork ||
            redirected.timeoutMs !== decision.timeoutMs ||
            !isDeepStrictEqual(redirected.dispatcherPolicy, decision.dispatcherPolicy)
          ) {
            throw new WebIqHostedBindingError(
              "traffic-policy-route-mismatch",
              "WebIQ redirect changed the prepared traffic-policy route",
            );
          }
        },
        policy: decision.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      });
      try {
        const response = await adaptWebIqResponseV1(
          result.response,
          prepared.responsePolicy,
          Date.now() - startedAt,
        );
        await result.release();
        return {
          response,
          release: result.release,
          policyDecision: decision,
        };
      } catch (error) {
        await result.release();
        throw error;
      }
    },
  };
  return Object.freeze(binding);
}
