import {
  resolveHostIntegrationContributionFromSnapshotV1,
  type HostIntegrationBundleSnapshotV1,
  type HostIntegrationContributionReferenceV1,
} from "../../hosting/host-integration-bundle.js";
import type { HostIntegrationOwnerEvidenceV1 } from "../../hosting/host-integration-status.js";
import {
  PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
  type ProviderRequestTrafficPolicyDecisionV1,
} from "../provider-request-traffic-policy.js";
import {
  ANTHROPIC_API_KEY_SLOT_ID,
  ANTHROPIC_DIRECT_MODEL_ADAPTER_ID,
  ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION,
  adaptAnthropicDirectResponseV1,
  prepareAnthropicDirectRequestV1,
  type AnthropicDirectAdapterConfigV1,
  type AnthropicDirectRequestContextV1,
} from "./anthropic-direct.js";
import {
  PROVIDER_REQUEST_DISPATCHER_VERSION,
  dispatchHostedModelRequestV1,
  type ModelProviderHostedBindingImplementationsV1,
} from "./model-provider-hosted-dispatch.js";

export const ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION =
  "anthropic-direct-hosted-binding/v1" as const;

type AnthropicDirectBindingReference = HostIntegrationContributionReferenceV1;

export type AnthropicDirectHostedBindingSelectionV1 = {
  version: typeof ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION;
  configGeneration: string;
  ownerGeneration: string;
  configSource: {
    source: string;
    path?: string;
  };
  providerId: string;
  adapter: AnthropicDirectBindingReference;
  credentialSlot: AnthropicDirectBindingReference;
  trafficPolicy: AnthropicDirectBindingReference;
  dispatcher: AnthropicDirectBindingReference;
};

export type AnthropicDirectHostedBindingImplementationsV1 =
  ModelProviderHostedBindingImplementationsV1;

export type AnthropicDirectHostedBindingGenerationFenceV1 = {
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
};

export type PreparedAnthropicDirectHostedBindingV1 = {
  version: typeof ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION;
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
  policyGeneration: string;
  mode: "local" | "hosted";
  selection: Readonly<AnthropicDirectHostedBindingSelectionV1>;
  ownerEvidence: HostIntegrationOwnerEvidenceV1;
  dispatch: (params: {
    fence: AnthropicDirectHostedBindingGenerationFenceV1;
    context: AnthropicDirectRequestContextV1;
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

type AnthropicDirectHostedBindingFailureCode =
  | "incompatible-implementation"
  | "invalid-selection"
  | "stale-bundle-generation"
  | "stale-config-generation"
  | "stale-owner-generation"
  | "traffic-policy-denied"
  | "traffic-policy-route-mismatch";

export class AnthropicDirectHostedBindingError extends Error {
  readonly code: AnthropicDirectHostedBindingFailureCode;

  constructor(code: AnthropicDirectHostedBindingFailureCode, message: string) {
    super(message);
    this.name = "AnthropicDirectHostedBindingError";
    this.code = code;
  }
}

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;

function normalizeGeneration(value: string, label: string): string {
  const normalized = value.trim();
  if (!GENERATION_RE.test(normalized)) {
    throw new AnthropicDirectHostedBindingError("invalid-selection", `${label} is invalid`);
  }
  return normalized;
}

function freezeReference(
  reference: AnthropicDirectBindingReference,
): AnthropicDirectBindingReference {
  return Object.freeze({ ...reference });
}

function expectedReference(
  reference: AnthropicDirectBindingReference,
  expected: AnthropicDirectBindingReference,
  label: string,
): void {
  if (
    reference.owner !== expected.owner ||
    reference.kind !== expected.kind ||
    reference.id !== expected.id ||
    reference.version !== expected.version
  ) {
    throw new AnthropicDirectHostedBindingError(
      "invalid-selection",
      `${label} must select ${expected.id}@${expected.version}`,
    );
  }
}

function assertImplementation(
  selected: AnthropicDirectBindingReference,
  implementation: { id: string; version: string },
  label: string,
): void {
  if (implementation.id !== selected.id || implementation.version !== selected.version) {
    throw new AnthropicDirectHostedBindingError(
      "incompatible-implementation",
      `${label} implementation does not match the selected contribution`,
    );
  }
}

function assertFence(
  binding: Pick<
    PreparedAnthropicDirectHostedBindingV1,
    "configGeneration" | "bundleGeneration" | "ownerGeneration"
  >,
  fence: AnthropicDirectHostedBindingGenerationFenceV1,
): void {
  if (fence.configGeneration !== binding.configGeneration) {
    throw new AnthropicDirectHostedBindingError(
      "stale-config-generation",
      "Anthropic direct binding effective config generation is stale",
    );
  }
  if (fence.bundleGeneration !== binding.bundleGeneration) {
    throw new AnthropicDirectHostedBindingError(
      "stale-bundle-generation",
      "Anthropic direct binding host bundle generation is stale",
    );
  }
  if (fence.ownerGeneration !== binding.ownerGeneration) {
    throw new AnthropicDirectHostedBindingError(
      "stale-owner-generation",
      "Anthropic direct binding owner generation is stale",
    );
  }
}

export function prepareAnthropicDirectHostedBindingV1(params: {
  selection: AnthropicDirectHostedBindingSelectionV1;
  adapterConfig: AnthropicDirectAdapterConfigV1;
  bundle: HostIntegrationBundleSnapshotV1;
  implementations: AnthropicDirectHostedBindingImplementationsV1;
}): PreparedAnthropicDirectHostedBindingV1 {
  if (params.selection.version !== ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION) {
    throw new AnthropicDirectHostedBindingError(
      "invalid-selection",
      "Anthropic direct binding version is unsupported",
    );
  }
  expectedReference(
    params.selection.adapter,
    {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: ANTHROPIC_DIRECT_MODEL_ADAPTER_ID,
      version: ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION,
    },
    "Anthropic direct adapter",
  );
  expectedReference(
    params.selection.credentialSlot,
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: ANTHROPIC_API_KEY_SLOT_ID,
      version: "credential-slot-resolver/v1",
    },
    "Anthropic direct credential slot",
  );
  if (
    params.selection.trafficPolicy.owner !== "provider-request" ||
    params.selection.trafficPolicy.kind !== "provider-request-traffic-policy" ||
    params.selection.trafficPolicy.version !== PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION
  ) {
    throw new AnthropicDirectHostedBindingError(
      "invalid-selection",
      "Anthropic direct traffic policy selection is incompatible",
    );
  }
  if (
    params.selection.dispatcher.owner !== "provider-request" ||
    params.selection.dispatcher.kind !== "provider-request-dispatcher" ||
    params.selection.dispatcher.version !== PROVIDER_REQUEST_DISPATCHER_VERSION
  ) {
    throw new AnthropicDirectHostedBindingError(
      "invalid-selection",
      "Anthropic direct dispatcher selection is incompatible",
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
    throw new AnthropicDirectHostedBindingError(
      "incompatible-implementation",
      "Traffic policy snapshot does not match the selected contribution",
    );
  }

  const configGeneration = normalizeGeneration(
    params.selection.configGeneration,
    "Anthropic direct config generation",
  );
  const ownerGeneration = normalizeGeneration(
    params.selection.ownerGeneration,
    "Anthropic direct owner generation",
  );
  const providerId = params.selection.providerId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new AnthropicDirectHostedBindingError(
      "invalid-selection",
      "Anthropic direct provider ID is invalid",
    );
  }
  const bundleGeneration = params.bundle.generation;
  const adapterConfig = Object.freeze({ ...params.adapterConfig });
  const credentialReadiness = params.implementations.credentialSlot.bindings.readiness();
  const dispatcherTarget = params.implementations.dispatcher.dispatcher;
  const dispatcher = Object.freeze({
    dispatch: dispatcherTarget.dispatch.bind(dispatcherTarget),
  });
  const dispatcherSelectionId = params.selection.dispatcher.id;
  const dispatcherRouteProfileId = params.implementations.dispatcher.routeProfileId;
  const trafficPolicy = params.implementations.trafficPolicy.snapshot;
  const source = params.selection.configSource.source.trim();
  const path = params.selection.configSource.path?.trim();
  if (!source) {
    throw new AnthropicDirectHostedBindingError(
      "invalid-selection",
      "Anthropic direct config source is required",
    );
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

  const binding: PreparedAnthropicDirectHostedBindingV1 = {
    version: ANTHROPIC_DIRECT_HOSTED_BINDING_VERSION,
    configGeneration,
    bundleGeneration,
    ownerGeneration,
    policyGeneration: trafficPolicy.generation,
    mode: params.implementations.dispatcher.mode,
    selection,
    ownerEvidence: Object.freeze({
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: ANTHROPIC_DIRECT_MODEL_ADAPTER_ID,
      bundleGeneration,
      state: "ready",
      reason: "BindingPrepared",
      message: "Anthropic direct model-owner binding is prepared and inactive.",
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
      const prepared = prepareAnthropicDirectRequestV1({
        config: adapterConfig,
        context,
        method,
        ...(headers ? { headers } : {}),
        body,
        credentialSlots: credentialReadiness,
      });
      const result = await dispatchHostedModelRequestV1({
        policy: trafficPolicy,
        providerId,
        providerLabel: "Anthropic direct",
        endpointClass: "anthropic-public",
        dispatcherSelectionId,
        dispatcherRouteProfileId,
        dispatcher,
        request: prepared,
        ...(signal ? { signal } : {}),
        createError: (code, message) => new AnthropicDirectHostedBindingError(code, message),
      });
      return {
        response: adaptAnthropicDirectResponseV1(result.response, prepared.responsePolicy),
        release: result.release,
        policyDecision: result.policyDecision,
      };
    },
  };
  return Object.freeze(binding);
}
