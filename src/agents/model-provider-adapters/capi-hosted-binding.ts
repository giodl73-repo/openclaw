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
  CAPI_BEARER_SLOT_ID,
  CAPI_MODEL_ADAPTER_ID,
  CAPI_MODEL_ADAPTER_VERSION,
  adaptCapiModelResponseV1,
  prepareCapiModelRequestV1,
  type CapiModelAdapterConfigV1,
  type CapiModelRequestContextV1,
} from "./capi.js";

export const CAPI_HOSTED_BINDING_VERSION = "capi-hosted-binding/v1" as const;
export const PROVIDER_REQUEST_DISPATCHER_VERSION = "provider-request-dispatcher/v1" as const;

type CapiBindingReference = HostIntegrationContributionReferenceV1;

export type CapiHostedBindingSelectionV1 = {
  version: typeof CAPI_HOSTED_BINDING_VERSION;
  configGeneration: string;
  ownerGeneration: string;
  configSource: {
    source: string;
    path?: string;
  };
  providerId: string;
  adapter: CapiBindingReference;
  credentialSlot: CapiBindingReference;
  trafficPolicy: CapiBindingReference;
  dispatcher: CapiBindingReference;
};

export type CapiHostedBindingImplementationsV1 = {
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

export type CapiHostedBindingGenerationFenceV1 = {
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
};

export type PreparedCapiHostedBindingV1 = {
  version: typeof CAPI_HOSTED_BINDING_VERSION;
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
  policyGeneration: string;
  mode: "local" | "hosted";
  selection: Readonly<CapiHostedBindingSelectionV1>;
  ownerEvidence: HostIntegrationOwnerEvidenceV1;
  dispatch: (params: {
    fence: CapiHostedBindingGenerationFenceV1;
    context: CapiModelRequestContextV1;
    method: string;
    headers?: HeadersInit;
    body: string | Uint8Array;
    signal?: AbortSignal;
  }) => Promise<{
    response: Response;
    release: () => Promise<void>;
    policyDecision: Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }>;
  }>;
};

export type CapiHostedBindingFailureCode =
  | "invalid-selection"
  | "incompatible-implementation"
  | "traffic-policy-denied"
  | "traffic-policy-route-mismatch"
  | "stale-config-generation"
  | "stale-bundle-generation"
  | "stale-owner-generation";

export class CapiHostedBindingError extends Error {
  readonly code: CapiHostedBindingFailureCode;

  constructor(code: CapiHostedBindingFailureCode, message: string) {
    super(message);
    this.name = "CapiHostedBindingError";
    this.code = code;
  }
}

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;

function normalizeGeneration(value: string, label: string): string {
  const normalized = value.trim();
  if (!GENERATION_RE.test(normalized)) {
    throw new CapiHostedBindingError("invalid-selection", `${label} is invalid`);
  }
  return normalized;
}

function freezeReference(reference: CapiBindingReference): CapiBindingReference {
  return Object.freeze({ ...reference });
}

function expectedReference(
  reference: CapiBindingReference,
  expected: CapiBindingReference,
  label: string,
): void {
  if (
    reference.owner !== expected.owner ||
    reference.kind !== expected.kind ||
    reference.id !== expected.id ||
    reference.version !== expected.version
  ) {
    throw new CapiHostedBindingError(
      "invalid-selection",
      `${label} must select ${expected.id}@${expected.version}`,
    );
  }
}

function assertImplementation(
  selected: CapiBindingReference,
  implementation: { id: string; version: string },
  label: string,
): void {
  if (implementation.id !== selected.id || implementation.version !== selected.version) {
    throw new CapiHostedBindingError(
      "incompatible-implementation",
      `${label} implementation does not match the selected contribution`,
    );
  }
}

function assertFence(
  binding: Pick<
    PreparedCapiHostedBindingV1,
    "configGeneration" | "bundleGeneration" | "ownerGeneration"
  >,
  fence: CapiHostedBindingGenerationFenceV1,
): void {
  if (fence.configGeneration !== binding.configGeneration) {
    throw new CapiHostedBindingError(
      "stale-config-generation",
      "CAPI binding effective config generation is stale",
    );
  }
  if (fence.bundleGeneration !== binding.bundleGeneration) {
    throw new CapiHostedBindingError(
      "stale-bundle-generation",
      "CAPI binding host bundle generation is stale",
    );
  }
  if (fence.ownerGeneration !== binding.ownerGeneration) {
    throw new CapiHostedBindingError(
      "stale-owner-generation",
      "CAPI binding owner generation is stale",
    );
  }
}

function allowDecision(params: {
  policy: ProviderRequestTrafficPolicySnapshotV1;
  provider: string;
  url: string;
  timeoutMs?: number;
}): Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }> {
  const decision = evaluateProviderRequestTrafficPolicyV1(params.policy, {
    provider: params.provider,
    capability: "llm",
    transport: "stream",
    endpointClass: "custom",
    url: params.url,
    allowPrivateNetwork: false,
    timeoutMs: params.timeoutMs,
  });
  if (!decision || decision.action === "deny") {
    throw new CapiHostedBindingError(
      "traffic-policy-denied",
      `CAPI request is not allowed by ${params.policy.id}`,
    );
  }
  return decision;
}

export function prepareCapiHostedBindingV1(params: {
  selection: CapiHostedBindingSelectionV1;
  adapterConfig: CapiModelAdapterConfigV1;
  bundle: HostIntegrationBundleSnapshotV1;
  implementations: CapiHostedBindingImplementationsV1;
}): PreparedCapiHostedBindingV1 {
  if (params.selection.version !== CAPI_HOSTED_BINDING_VERSION) {
    throw new CapiHostedBindingError("invalid-selection", "CAPI binding version is unsupported");
  }
  expectedReference(
    params.selection.adapter,
    {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: CAPI_MODEL_ADAPTER_ID,
      version: CAPI_MODEL_ADAPTER_VERSION,
    },
    "CAPI adapter",
  );
  expectedReference(
    params.selection.credentialSlot,
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: CAPI_BEARER_SLOT_ID,
      version: "credential-slot-resolver/v1",
    },
    "CAPI credential slot",
  );
  expectedReference(
    params.selection.trafficPolicy,
    {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
    },
    "CAPI traffic policy",
  );
  if (
    params.selection.dispatcher.owner !== "provider-request" ||
    params.selection.dispatcher.kind !== "provider-request-dispatcher" ||
    params.selection.dispatcher.version !== PROVIDER_REQUEST_DISPATCHER_VERSION
  ) {
    throw new CapiHostedBindingError(
      "invalid-selection",
      "CAPI dispatcher selection is incompatible",
    );
  }

  for (const reference of [
    params.selection.adapter,
    params.selection.credentialSlot,
    params.selection.trafficPolicy,
    params.selection.dispatcher,
  ]) {
    resolveHostIntegrationContributionFromSnapshotV1(params.bundle, reference);
  }
  assertImplementation(
    params.selection.credentialSlot,
    params.implementations.credentialSlot,
    "Credential slot",
  );
  assertImplementation(
    params.selection.trafficPolicy,
    params.implementations.trafficPolicy,
    "Traffic policy",
  );
  assertImplementation(
    params.selection.dispatcher,
    params.implementations.dispatcher,
    "Dispatcher",
  );
  if (params.implementations.trafficPolicy.snapshot.id !== params.selection.trafficPolicy.id) {
    throw new CapiHostedBindingError(
      "incompatible-implementation",
      "Traffic policy snapshot does not match the selected contribution",
    );
  }

  const configGeneration = normalizeGeneration(
    params.selection.configGeneration,
    "CAPI config generation",
  );
  const ownerGeneration = normalizeGeneration(
    params.selection.ownerGeneration,
    "CAPI owner generation",
  );
  const providerId = params.selection.providerId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new CapiHostedBindingError("invalid-selection", "CAPI provider ID is invalid");
  }
  const bundleGeneration = `${params.bundle.id}@${params.bundle.bundleVersion}`;
  const adapterConfig = Object.freeze({ ...params.adapterConfig });
  const credentialReadiness = params.implementations.credentialSlot.bindings.readiness();
  const dispatcherTarget = params.implementations.dispatcher.dispatcher;
  const dispatcher = Object.freeze({
    dispatch: dispatcherTarget.dispatch.bind(dispatcherTarget),
  });
  const trafficPolicy = params.implementations.trafficPolicy.snapshot;
  const source = params.selection.configSource.source.trim();
  const path = params.selection.configSource.path?.trim();
  if (!source) {
    throw new CapiHostedBindingError("invalid-selection", "CAPI config source is required");
  }
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

  const binding: PreparedCapiHostedBindingV1 = {
    version: CAPI_HOSTED_BINDING_VERSION,
    configGeneration,
    bundleGeneration,
    ownerGeneration,
    policyGeneration: trafficPolicy.generation,
    mode: params.implementations.dispatcher.mode,
    selection,
    ownerEvidence: Object.freeze({
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: CAPI_MODEL_ADAPTER_ID,
      bundleGeneration,
      state: "ready",
      reason: "BindingPrepared",
      message: "CAPI model-owner binding is prepared and inactive.",
      config: Object.freeze({
        source,
        ...(path ? { path } : {}),
      }),
      ownerGeneration,
      reloadDisposition: "reload-required",
      authorityMode: "openclaw",
    }),
    dispatch: async ({ fence, context, method, headers, body, signal }) => {
      assertFence(binding, fence);
      const prepared = prepareCapiModelRequestV1({
        config: adapterConfig,
        context,
        method,
        ...(headers ? { headers } : {}),
        body,
        credentialSlots: credentialReadiness,
      });
      const decision = allowDecision({
        policy: trafficPolicy,
        provider: providerId,
        url: prepared.url,
      });
      if (
        decision.dispatchBindingId !== params.selection.dispatcher.id ||
        decision.routeProfileId !== params.implementations.dispatcher.routeProfileId
      ) {
        throw new CapiHostedBindingError(
          "traffic-policy-route-mismatch",
          "CAPI traffic policy did not select the prepared dispatcher and route",
        );
      }
      const validateUrl = (url: URL) => {
        const redirected = allowDecision({
          policy: trafficPolicy,
          provider: providerId,
          url: url.toString(),
          timeoutMs: decision.timeoutMs,
        });
        if (
          redirected.policyGeneration !== decision.policyGeneration ||
          redirected.routeProfileId !== decision.routeProfileId ||
          redirected.dispatchBindingId !== decision.dispatchBindingId
        ) {
          throw new CapiHostedBindingError(
            "traffic-policy-route-mismatch",
            "CAPI redirect changed the prepared traffic-policy route",
          );
        }
      };
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
        allowCrossOriginUnsafeRedirectReplay: false,
        validateUrl,
        policy: decision.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      });
      return {
        response: adaptCapiModelResponseV1(result.response, prepared.responsePolicy),
        release: result.release,
        policyDecision: decision,
      };
    },
  };
  return Object.freeze(binding);
}
