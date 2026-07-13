import {
  dispatchHostedProviderRequestV1,
  PROVIDER_REQUEST_DISPATCHER_VERSION,
  PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
  resolveHostIntegrationContributionFromSnapshotV1,
  type HostIntegrationBundleSnapshotV1,
  type HostIntegrationContributionReferenceV1,
  type ProviderRequestHostedBindingImplementationsV1,
  type ProviderRequestTrafficPolicyDecisionV1,
} from "../runtime-api.js";
import {
  adaptMSTeamsAcfChannelResponseV1,
  MSTEAMS_ACF_BEARER_SLOT_ID,
  MSTEAMS_ACF_ENDPOINT_CLASS,
  MSTEAMS_ACF_PROVIDER_ID,
  prepareMSTeamsAcfChannelRequestV1,
  type MSTeamsAcfRequestContextV1,
} from "./acf-channel-request.js";

export const MSTEAMS_ACF_HOSTED_BINDING_VERSION = "msteams-acf-hosted-binding/v1" as const;

type BindingReference = HostIntegrationContributionReferenceV1;

export type MSTeamsAcfHostedBindingSelectionV1 = {
  version: typeof MSTEAMS_ACF_HOSTED_BINDING_VERSION;
  configGeneration: string;
  ownerGeneration: string;
  configSource: {
    source: string;
    path?: string;
  };
  credentialSlot: BindingReference;
  trafficPolicy: BindingReference;
  dispatcher: BindingReference;
};

export type MSTeamsAcfHostedBindingGenerationFenceV1 = {
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
};

export type PreparedMSTeamsAcfHostedBindingV1 = {
  version: typeof MSTEAMS_ACF_HOSTED_BINDING_VERSION;
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
  policyGeneration: string;
  mode: "local" | "hosted";
  selection: Readonly<MSTeamsAcfHostedBindingSelectionV1>;
  readiness: {
    owner: "channel";
    channel: "msteams";
    state: "ready";
    reason: "BindingPrepared";
    authorityMode: "openclaw";
  };
  dispatch: (params: {
    fence: MSTeamsAcfHostedBindingGenerationFenceV1;
    context: MSTeamsAcfRequestContextV1;
    method: string;
    url: string;
    headers?: HeadersInit;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  }) => Promise<{
    response: Response;
    release: () => Promise<void>;
    policyDecision: Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }>;
  }>;
};

export type MSTeamsAcfHostedBindingFailureCode =
  | "incompatible-implementation"
  | "invalid-selection"
  | "stale-bundle-generation"
  | "stale-config-generation"
  | "stale-owner-generation"
  | "traffic-policy-denied"
  | "traffic-policy-route-mismatch";

export class MSTeamsAcfHostedBindingError extends Error {
  readonly code: MSTeamsAcfHostedBindingFailureCode;

  constructor(code: MSTeamsAcfHostedBindingFailureCode, message: string) {
    super(message);
    this.name = "MSTeamsAcfHostedBindingError";
    this.code = code;
  }
}

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;

function normalizeGeneration(value: string, label: string): string {
  const normalized = value.trim();
  if (!GENERATION_RE.test(normalized)) {
    throw new MSTeamsAcfHostedBindingError("invalid-selection", `${label} is invalid`);
  }
  return normalized;
}

function expectedReference(
  reference: BindingReference,
  expected: BindingReference,
  label: string,
): void {
  if (
    reference.owner !== expected.owner ||
    reference.kind !== expected.kind ||
    reference.id !== expected.id ||
    reference.version !== expected.version
  ) {
    throw new MSTeamsAcfHostedBindingError(
      "invalid-selection",
      `${label} must select ${expected.id}@${expected.version}`,
    );
  }
}

function assertImplementation(
  selected: BindingReference,
  implementation: { id: string; version: string },
  label: string,
): void {
  if (implementation.id !== selected.id || implementation.version !== selected.version) {
    throw new MSTeamsAcfHostedBindingError(
      "incompatible-implementation",
      `${label} implementation does not match the selected contribution`,
    );
  }
}

function assertFence(
  binding: Pick<
    PreparedMSTeamsAcfHostedBindingV1,
    "configGeneration" | "bundleGeneration" | "ownerGeneration"
  >,
  fence: MSTeamsAcfHostedBindingGenerationFenceV1,
): void {
  if (fence.configGeneration !== binding.configGeneration) {
    throw new MSTeamsAcfHostedBindingError(
      "stale-config-generation",
      "Microsoft Teams ACF effective config generation is stale",
    );
  }
  if (fence.bundleGeneration !== binding.bundleGeneration) {
    throw new MSTeamsAcfHostedBindingError(
      "stale-bundle-generation",
      "Microsoft Teams ACF host bundle generation is stale",
    );
  }
  if (fence.ownerGeneration !== binding.ownerGeneration) {
    throw new MSTeamsAcfHostedBindingError(
      "stale-owner-generation",
      "Microsoft Teams ACF Channel owner generation is stale",
    );
  }
}

export function prepareMSTeamsAcfHostedBindingV1(params: {
  selection: MSTeamsAcfHostedBindingSelectionV1;
  bundle: HostIntegrationBundleSnapshotV1;
  implementations: ProviderRequestHostedBindingImplementationsV1;
}): PreparedMSTeamsAcfHostedBindingV1 {
  if (params.selection.version !== MSTEAMS_ACF_HOSTED_BINDING_VERSION) {
    throw new MSTeamsAcfHostedBindingError(
      "invalid-selection",
      "Microsoft Teams ACF binding version is unsupported",
    );
  }
  expectedReference(
    params.selection.credentialSlot,
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: MSTEAMS_ACF_BEARER_SLOT_ID,
      version: "credential-slot-resolver/v1",
    },
    "Microsoft Teams ACF credential slot",
  );
  expectedReference(
    params.selection.trafficPolicy,
    {
      owner: "provider-request",
      kind: "provider-request-traffic-policy",
      id: "lobster/enterprise-egress",
      version: PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
    },
    "Microsoft Teams ACF traffic policy",
  );
  if (
    params.selection.dispatcher.owner !== "provider-request" ||
    params.selection.dispatcher.kind !== "provider-request-dispatcher" ||
    params.selection.dispatcher.version !== PROVIDER_REQUEST_DISPATCHER_VERSION
  ) {
    throw new MSTeamsAcfHostedBindingError(
      "invalid-selection",
      "Microsoft Teams ACF dispatcher selection is incompatible",
    );
  }
  for (const reference of [
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
    throw new MSTeamsAcfHostedBindingError(
      "incompatible-implementation",
      "Traffic policy snapshot does not match the selected contribution",
    );
  }

  const configGeneration = normalizeGeneration(
    params.selection.configGeneration,
    "Microsoft Teams ACF config generation",
  );
  const ownerGeneration = normalizeGeneration(
    params.selection.ownerGeneration,
    "Microsoft Teams ACF owner generation",
  );
  const bundleGeneration = `${params.bundle.id}@${params.bundle.bundleVersion}`;
  const credentialReadiness = params.implementations.credentialSlot.bindings.readiness();
  const trafficPolicy = params.implementations.trafficPolicy.snapshot;
  const dispatcherRouteProfileId = params.implementations.dispatcher.routeProfileId;
  const dispatcherTarget = params.implementations.dispatcher.dispatcher;
  const dispatcher = Object.freeze({
    dispatch: dispatcherTarget.dispatch.bind(dispatcherTarget),
  });
  const source = params.selection.configSource.source.trim();
  const path = params.selection.configSource.path?.trim();
  if (!source) {
    throw new MSTeamsAcfHostedBindingError(
      "invalid-selection",
      "Microsoft Teams ACF config source is required",
    );
  }
  const selection = Object.freeze({
    ...params.selection,
    configGeneration,
    ownerGeneration,
    configSource: Object.freeze({
      source,
      ...(path ? { path } : {}),
    }),
    credentialSlot: Object.freeze({ ...params.selection.credentialSlot }),
    trafficPolicy: Object.freeze({ ...params.selection.trafficPolicy }),
    dispatcher: Object.freeze({ ...params.selection.dispatcher }),
  });

  const binding: PreparedMSTeamsAcfHostedBindingV1 = {
    version: MSTEAMS_ACF_HOSTED_BINDING_VERSION,
    configGeneration,
    bundleGeneration,
    ownerGeneration,
    policyGeneration: trafficPolicy.generation,
    mode: params.implementations.dispatcher.mode,
    selection,
    readiness: Object.freeze({
      owner: "channel",
      channel: "msteams",
      state: "ready",
      reason: "BindingPrepared",
      authorityMode: "openclaw",
    }),
    dispatch: async ({ fence, context, method, url, headers, body, signal }) => {
      assertFence(binding, fence);
      const prepared = prepareMSTeamsAcfChannelRequestV1({
        context,
        method,
        url,
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        credentialSlots: credentialReadiness,
      });
      const result = await dispatchHostedProviderRequestV1({
        policy: trafficPolicy,
        providerId: MSTEAMS_ACF_PROVIDER_ID,
        providerLabel: "Microsoft Teams ACF",
        capability: "channel",
        transport: "request-response",
        endpointClass: MSTEAMS_ACF_ENDPOINT_CLASS,
        dispatcherSelectionId: selection.dispatcher.id,
        dispatcherRouteProfileId,
        dispatcher,
        request: prepared,
        ...(signal ? { signal } : {}),
        validateUrl: (candidate) => {
          if (candidate.toString() !== prepared.url) {
            throw new MSTeamsAcfHostedBindingError(
              "traffic-policy-denied",
              "Microsoft Teams ACF redirects are not supported",
            );
          }
        },
        createError: (code, message) => new MSTeamsAcfHostedBindingError(code, message),
      });
      return {
        response: adaptMSTeamsAcfChannelResponseV1(result.response, prepared.responsePolicy),
        release: result.release,
        policyDecision: result.policyDecision,
      };
    },
  };
  return Object.freeze(binding);
}
