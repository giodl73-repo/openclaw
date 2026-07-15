import {
  dispatchHostedProviderRequestV1,
  PROVIDER_REQUEST_DISPATCHER_VERSION,
  PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
  resolveHostIntegrationContributionFromSnapshotV1,
  type HostIntegrationBundleSnapshotV1,
  type HostIntegrationContributionReferenceV1,
  type ProviderRequestHostedBindingImplementationsV1,
  type ProviderRequestTrafficPolicyDecisionV1,
} from "openclaw/plugin-sdk/provider-request-runtime";
import {
  acceptM365MailGraphResponseV1,
  M365MAIL_GRAPH_BEARER_SLOT_ID,
  M365MAIL_GRAPH_ENDPOINT_CLASS,
  M365MAIL_GRAPH_PROVIDER_ID,
  prepareM365MailGraphRequestV1,
  type M365MailGraphOperationV1,
  type M365MailGraphRequestContextV1,
} from "./graph-request.js";

export const M365MAIL_GRAPH_HOSTED_BINDING_VERSION = "m365mail-graph-hosted-binding/v1" as const;

type BindingReference = HostIntegrationContributionReferenceV1;

export type M365MailGraphHostedBindingSelectionV1 = {
  version: typeof M365MAIL_GRAPH_HOSTED_BINDING_VERSION;
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

export type M365MailGraphHostedBindingGenerationFenceV1 = {
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
};

export type PreparedM365MailGraphHostedBindingV1 = {
  version: typeof M365MAIL_GRAPH_HOSTED_BINDING_VERSION;
  configGeneration: string;
  bundleGeneration: string;
  ownerGeneration: string;
  policyGeneration: string;
  mode: "local" | "hosted";
  selection: Readonly<M365MailGraphHostedBindingSelectionV1>;
  readiness: {
    owner: "channel";
    channel: "m365mail";
    state: "ready";
    reason: "BindingPrepared";
    authorityMode: "openclaw";
  };
  dispatch: (params: {
    fence: M365MailGraphHostedBindingGenerationFenceV1;
    context: M365MailGraphRequestContextV1;
    operation: M365MailGraphOperationV1;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }) => Promise<{
    policyDecision: Extract<ProviderRequestTrafficPolicyDecisionV1, { action: "allow" }>;
  }>;
};

export type M365MailGraphHostedBindingFailureCode =
  | "incompatible-implementation"
  | "invalid-selection"
  | "stale-bundle-generation"
  | "stale-config-generation"
  | "stale-owner-generation"
  | "traffic-policy-denied"
  | "traffic-policy-route-mismatch";

export class M365MailGraphHostedBindingError extends Error {
  readonly code: M365MailGraphHostedBindingFailureCode;

  constructor(code: M365MailGraphHostedBindingFailureCode, message: string) {
    super(message);
    this.name = "M365MailGraphHostedBindingError";
    this.code = code;
  }
}

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;

function normalizeGeneration(value: string, label: string): string {
  const normalized = value.trim();
  if (!GENERATION_RE.test(normalized)) {
    throw new M365MailGraphHostedBindingError("invalid-selection", `${label} is invalid`);
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
    throw new M365MailGraphHostedBindingError(
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
    throw new M365MailGraphHostedBindingError(
      "incompatible-implementation",
      `${label} implementation does not match the selected contribution`,
    );
  }
}

function assertFence(
  binding: Pick<
    PreparedM365MailGraphHostedBindingV1,
    "configGeneration" | "bundleGeneration" | "ownerGeneration"
  >,
  fence: M365MailGraphHostedBindingGenerationFenceV1,
): void {
  if (fence.configGeneration !== binding.configGeneration) {
    throw new M365MailGraphHostedBindingError(
      "stale-config-generation",
      "Microsoft 365 Email effective config generation is stale",
    );
  }
  if (fence.bundleGeneration !== binding.bundleGeneration) {
    throw new M365MailGraphHostedBindingError(
      "stale-bundle-generation",
      "Microsoft 365 Email host bundle generation is stale",
    );
  }
  if (fence.ownerGeneration !== binding.ownerGeneration) {
    throw new M365MailGraphHostedBindingError(
      "stale-owner-generation",
      "Microsoft 365 Email owner generation is stale",
    );
  }
}

export function prepareM365MailGraphHostedBindingV1(params: {
  selection: M365MailGraphHostedBindingSelectionV1;
  bundle: HostIntegrationBundleSnapshotV1;
  implementations: ProviderRequestHostedBindingImplementationsV1;
}): PreparedM365MailGraphHostedBindingV1 {
  if (params.selection.version !== M365MAIL_GRAPH_HOSTED_BINDING_VERSION) {
    throw new M365MailGraphHostedBindingError(
      "invalid-selection",
      "Microsoft 365 Email Graph binding version is unsupported",
    );
  }
  expectedReference(
    params.selection.credentialSlot,
    {
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: M365MAIL_GRAPH_BEARER_SLOT_ID,
      version: "credential-slot-resolver/v1",
    },
    "Microsoft 365 Email Graph credential slot",
  );
  if (
    params.selection.trafficPolicy.owner !== "provider-request" ||
    params.selection.trafficPolicy.kind !== "provider-request-traffic-policy" ||
    params.selection.trafficPolicy.version !== PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION
  ) {
    throw new M365MailGraphHostedBindingError(
      "invalid-selection",
      "Microsoft 365 Email Graph traffic policy selection is incompatible",
    );
  }
  if (
    params.selection.dispatcher.owner !== "provider-request" ||
    params.selection.dispatcher.kind !== "provider-request-dispatcher" ||
    params.selection.dispatcher.version !== PROVIDER_REQUEST_DISPATCHER_VERSION
  ) {
    throw new M365MailGraphHostedBindingError(
      "invalid-selection",
      "Microsoft 365 Email Graph dispatcher selection is incompatible",
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
    throw new M365MailGraphHostedBindingError(
      "incompatible-implementation",
      "Traffic policy snapshot does not match the selected contribution",
    );
  }

  const configGeneration = normalizeGeneration(
    params.selection.configGeneration,
    "Microsoft 365 Email config generation",
  );
  const ownerGeneration = normalizeGeneration(
    params.selection.ownerGeneration,
    "Microsoft 365 Email owner generation",
  );
  const bundleGeneration = params.bundle.generation;
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
    throw new M365MailGraphHostedBindingError(
      "invalid-selection",
      "Microsoft 365 Email config source is required",
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

  const binding: PreparedM365MailGraphHostedBindingV1 = {
    version: M365MAIL_GRAPH_HOSTED_BINDING_VERSION,
    configGeneration,
    bundleGeneration,
    ownerGeneration,
    policyGeneration: trafficPolicy.generation,
    mode: params.implementations.dispatcher.mode,
    selection,
    readiness: Object.freeze({
      owner: "channel",
      channel: "m365mail",
      state: "ready",
      reason: "BindingPrepared",
      authorityMode: "openclaw",
    }),
    dispatch: async ({ fence, context, operation, headers, signal }) => {
      assertFence(binding, fence);
      const prepared = prepareM365MailGraphRequestV1({
        context,
        operation,
        ...(headers ? { headers } : {}),
        credentialSlots: credentialReadiness,
      });
      const result = await dispatchHostedProviderRequestV1({
        policy: trafficPolicy,
        providerId: M365MAIL_GRAPH_PROVIDER_ID,
        providerLabel: "Microsoft 365 Email Graph",
        capability: "channel",
        transport: "request-response",
        endpointClass: M365MAIL_GRAPH_ENDPOINT_CLASS,
        dispatcherSelectionId: selection.dispatcher.id,
        dispatcherRouteProfileId,
        dispatcher,
        request: prepared,
        ...(signal ? { signal } : {}),
        validateUrl: (candidate) => {
          if (candidate.toString() !== prepared.url) {
            throw new M365MailGraphHostedBindingError(
              "traffic-policy-denied",
              "Microsoft Graph mail redirects are not supported",
            );
          }
        },
        createError: (code, message) => new M365MailGraphHostedBindingError(code, message),
      });
      try {
        await acceptM365MailGraphResponseV1(result.response, prepared.responsePolicy);
      } finally {
        await result.release();
      }
      return {
        policyDecision: result.policyDecision,
      };
    },
  };
  return Object.freeze(binding);
}
