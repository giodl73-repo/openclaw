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
  PROVIDER_REQUEST_DISPATCHER_VERSION,
  dispatchHostedModelRequestV1,
  type ModelProviderHostedBindingImplementationsV1,
} from "./model-provider-hosted-dispatch.js";
import {
  SUBSTRATE_BEARER_SLOT_ID,
  SUBSTRATE_LLMAPI_MODEL_ADAPTER_ID,
  SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION,
  prepareSubstrateLlmApiRequestV1,
  type SubstrateLlmApiAdapterConfigV1,
  type SubstrateLlmApiRequestContextV1,
} from "./substrate-llmapi.js";

export const SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION =
  "substrate-llmapi-hosted-binding/v1" as const;

type SubstrateBindingReference = HostIntegrationContributionReferenceV1;

export type SubstrateLlmApiHostedBindingSelectionV1 = {
  version: typeof SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION;
  configGeneration: string;
  ownerGeneration: string;
  configSource: {
    source: string;
    path?: string;
  };
  providerId: string;
  adapter: SubstrateBindingReference;
  credentialSlot: SubstrateBindingReference;
  trafficPolicy: SubstrateBindingReference;
  dispatcher: SubstrateBindingReference;
};

export type SubstrateLlmApiHostedBindingImplementationsV1 =
  ModelProviderHostedBindingImplementationsV1;

export type SubstrateLlmApiHostedBindingGenerationFenceV1 = {
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
};

export type PreparedSubstrateLlmApiHostedBindingV1 = {
  version: typeof SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION;
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
  policyGeneration: string;
  mode: "local" | "hosted";
  selection: Readonly<SubstrateLlmApiHostedBindingSelectionV1>;
  ownerEvidence: HostIntegrationOwnerEvidenceV1;
  dispatch: (params: {
    fence: SubstrateLlmApiHostedBindingGenerationFenceV1;
    context: SubstrateLlmApiRequestContextV1;
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

export type SubstrateLlmApiHostedBindingFailureCode =
  | "invalid-selection"
  | "incompatible-implementation"
  | "traffic-policy-denied"
  | "traffic-policy-route-mismatch"
  | "stale-config-generation"
  | "stale-bundle-generation"
  | "stale-owner-generation";

export class SubstrateLlmApiHostedBindingError extends Error {
  readonly code: SubstrateLlmApiHostedBindingFailureCode;

  constructor(code: SubstrateLlmApiHostedBindingFailureCode, message: string) {
    super(message);
    this.name = "SubstrateLlmApiHostedBindingError";
    this.code = code;
  }
}

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;

function normalizeGeneration(value: string, label: string): string {
  const normalized = value.trim();
  if (!GENERATION_RE.test(normalized)) {
    throw new SubstrateLlmApiHostedBindingError("invalid-selection", `${label} is invalid`);
  }
  return normalized;
}

function freezeReference(reference: SubstrateBindingReference): SubstrateBindingReference {
  return Object.freeze({ ...reference });
}

function expectedReference(
  reference: SubstrateBindingReference,
  expected: SubstrateBindingReference,
  label: string,
): void {
  if (
    reference.owner !== expected.owner ||
    reference.kind !== expected.kind ||
    reference.id !== expected.id ||
    reference.version !== expected.version
  ) {
    throw new SubstrateLlmApiHostedBindingError(
      "invalid-selection",
      `${label} must select ${expected.id}@${expected.version}`,
    );
  }
}

function assertImplementation(
  selected: SubstrateBindingReference,
  implementation: { id: string; version: string },
  label: string,
): void {
  if (implementation.id !== selected.id || implementation.version !== selected.version) {
    throw new SubstrateLlmApiHostedBindingError(
      "incompatible-implementation",
      `${label} implementation does not match the selected contribution`,
    );
  }
}

function assertFence(
  binding: Pick<
    PreparedSubstrateLlmApiHostedBindingV1,
    "configGeneration" | "bundleGeneration" | "ownerGeneration"
  >,
  fence: SubstrateLlmApiHostedBindingGenerationFenceV1,
): void {
  if (fence.configGeneration !== binding.configGeneration) {
    throw new SubstrateLlmApiHostedBindingError(
      "stale-config-generation",
      "Substrate binding effective config generation is stale",
    );
  }
  if (fence.bundleGeneration !== binding.bundleGeneration) {
    throw new SubstrateLlmApiHostedBindingError(
      "stale-bundle-generation",
      "Substrate binding host bundle generation is stale",
    );
  }
  if (fence.ownerGeneration !== binding.ownerGeneration) {
    throw new SubstrateLlmApiHostedBindingError(
      "stale-owner-generation",
      "Substrate binding owner generation is stale",
    );
  }
}

function freezeAdapterConfig(
  config: SubstrateLlmApiAdapterConfigV1,
): SubstrateLlmApiAdapterConfigV1 {
  return Object.freeze({
    ...config,
    modelMap: Object.freeze({ ...config.modelMap }),
    taxonomy: Object.freeze({
      ...config.taxonomy,
      extendedProperties: Object.freeze({ ...config.taxonomy.extendedProperties }),
    }),
  });
}

export function prepareSubstrateLlmApiHostedBindingV1(params: {
  selection: SubstrateLlmApiHostedBindingSelectionV1;
  adapterConfig: SubstrateLlmApiAdapterConfigV1;
  bundle: HostIntegrationBundleSnapshotV1;
  implementations: SubstrateLlmApiHostedBindingImplementationsV1;
}): PreparedSubstrateLlmApiHostedBindingV1 {
  if (params.selection.version !== SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION) {
    throw new SubstrateLlmApiHostedBindingError(
      "invalid-selection",
      "Substrate binding version is unsupported",
    );
  }
  expectedReference(
    params.selection.adapter,
    {
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: SUBSTRATE_LLMAPI_MODEL_ADAPTER_ID,
      version: SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION,
    },
    "Substrate adapter",
  );
  expectedReference(
    params.selection.credentialSlot,
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: SUBSTRATE_BEARER_SLOT_ID,
      version: "credential-slot-resolver/v1",
    },
    "Substrate credential slot",
  );
  expectedReference(
    params.selection.trafficPolicy,
    {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
    },
    "Substrate traffic policy",
  );
  if (
    params.selection.dispatcher.owner !== "provider-request" ||
    params.selection.dispatcher.kind !== "provider-request-dispatcher" ||
    params.selection.dispatcher.version !== PROVIDER_REQUEST_DISPATCHER_VERSION
  ) {
    throw new SubstrateLlmApiHostedBindingError(
      "invalid-selection",
      "Substrate dispatcher selection is incompatible",
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
    throw new SubstrateLlmApiHostedBindingError(
      "incompatible-implementation",
      "Traffic policy snapshot does not match the selected contribution",
    );
  }

  const configGeneration = normalizeGeneration(
    params.selection.configGeneration,
    "Substrate config generation",
  );
  const ownerGeneration = normalizeGeneration(
    params.selection.ownerGeneration,
    "Substrate owner generation",
  );
  const providerId = params.selection.providerId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new SubstrateLlmApiHostedBindingError(
      "invalid-selection",
      "Substrate provider ID is invalid",
    );
  }
  const bundleGeneration = `${params.bundle.id}@${params.bundle.bundleVersion}`;
  const adapterConfig = freezeAdapterConfig(params.adapterConfig);
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
    throw new SubstrateLlmApiHostedBindingError(
      "invalid-selection",
      "Substrate config source is required",
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

  const binding: PreparedSubstrateLlmApiHostedBindingV1 = {
    version: SUBSTRATE_LLMAPI_HOSTED_BINDING_VERSION,
    configGeneration,
    bundleGeneration,
    ownerGeneration,
    policyGeneration: trafficPolicy.generation,
    mode: params.implementations.dispatcher.mode,
    selection,
    ownerEvidence: Object.freeze({
      owner: "model-provider",
      kind: "model-provider-adapter",
      id: SUBSTRATE_LLMAPI_MODEL_ADAPTER_ID,
      bundleGeneration,
      state: "ready",
      reason: "BindingPrepared",
      message: "Substrate model-owner binding is prepared and inactive.",
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
      const prepared = prepareSubstrateLlmApiRequestV1({
        config: adapterConfig,
        context,
        method,
        ...(headers ? { headers } : {}),
        body,
        credentialSlots: credentialReadiness,
      });
      return await dispatchHostedModelRequestV1({
        policy: trafficPolicy,
        providerId,
        providerLabel: "Substrate",
        dispatcherSelectionId,
        dispatcherRouteProfileId,
        dispatcher,
        request: prepared,
        ...(signal ? { signal } : {}),
        createError: (code, message) => new SubstrateLlmApiHostedBindingError(code, message),
      });
    },
  };
  return Object.freeze(binding);
}
