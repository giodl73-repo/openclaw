import {
  compileCredentialSlotDefinitionsV1,
  prepareCredentialSlotBindingsV1,
  type CredentialSlotDefinitionV1,
  type CredentialSlotResolverV1,
} from "../infra/net/credential-slot.js";
import type { OneHopFetchDispatcher } from "../infra/net/one-hop-fetch-dispatcher.js";

export const PROVIDER_REQUEST_DISPATCHER_VERSION = "provider-request-dispatcher/v1" as const;

export type ProviderRequestDispatcherRegistrationV1 = {
  version: typeof PROVIDER_REQUEST_DISPATCHER_VERSION;
  id: string;
  trafficPolicyId: string;
  trafficPolicyGeneration: string;
  credentialSlots?: readonly CredentialSlotDefinitionV1[];
  dispatch: OneHopFetchDispatcher["dispatch"];
};

export type ProviderRequestDispatcherBindingV1 = Readonly<
  Omit<ProviderRequestDispatcherRegistrationV1, "credentialSlots"> & {
    owner: string;
    credentialSlotRefs: readonly string[];
  }
>;

export type ProviderRequestDispatcherFailureCode =
  | "invalid-registration"
  | "duplicate-binding"
  | "binding-unavailable"
  | "stale-policy-generation";

export class ProviderRequestDispatcherError extends Error {
  readonly code: ProviderRequestDispatcherFailureCode;
  readonly bindingId?: string;

  constructor(code: ProviderRequestDispatcherFailureCode, message: string, bindingId?: string) {
    super(message);
    this.name = "ProviderRequestDispatcherError";
    this.code = code;
    this.bindingId = bindingId;
  }
}

export type ProviderRequestDispatcherProcessStateV1 = ReadonlyMap<
  string,
  ProviderRequestDispatcherBindingV1
>;

const ID_RE = /^[a-z0-9][a-z0-9._/-]*$/;
let bindings: ProviderRequestDispatcherProcessStateV1 = new Map();

function normalizeId(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!ID_RE.test(normalized)) {
    throw new ProviderRequestDispatcherError(
      "invalid-registration",
      `${label} is invalid`,
      label === "Provider request dispatcher ID" ? normalized || undefined : undefined,
    );
  }
  return normalized;
}

function compileBinding(
  owner: string,
  registration: ProviderRequestDispatcherRegistrationV1,
  resolveCredentialSlotResolvers: () => readonly CredentialSlotResolverV1[],
): ProviderRequestDispatcherBindingV1 {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new ProviderRequestDispatcherError(
      "invalid-registration",
      "Provider request dispatcher owner is required",
    );
  }
  const receivedVersion: unknown = registration.version;
  if (receivedVersion !== PROVIDER_REQUEST_DISPATCHER_VERSION) {
    throw new ProviderRequestDispatcherError(
      "invalid-registration",
      `Unsupported provider request dispatcher version: ${String(receivedVersion)}`,
      registration.id,
    );
  }
  if (typeof registration.dispatch !== "function") {
    throw new ProviderRequestDispatcherError(
      "invalid-registration",
      "Provider request dispatcher implementation is required",
      registration.id,
    );
  }
  const credentialSlotDefinitions = compileCredentialSlotDefinitionsV1(
    registration.credentialSlots ?? [],
  );
  const credentialSlotRefs = Object.freeze(credentialSlotDefinitions.map((entry) => entry.slotId));
  const dispatch: OneHopFetchDispatcher["dispatch"] =
    credentialSlotDefinitions.length > 0
      ? async (request) => {
          const refs = request.credentialSlotRefs ?? [];
          const credentialSlots =
            refs.length > 0
              ? prepareCredentialSlotBindingsV1({
                  definitions: credentialSlotDefinitions,
                  resolvers: resolveCredentialSlotResolvers(),
                })
              : undefined;
          const init = credentialSlots
            ? // Existing owner headers remain protected. A slot is explicit authority
              // to fill an absent header, never to replace SDK- or caller-supplied auth.
              ((await credentialSlots.apply({
                slotRefs: refs,
                url: request.url,
                init: request.init,
                signal: request.init.signal ?? undefined,
              })) as typeof request.init)
            : request.init;
          // Slot references are OpenClaw authority. The connection owner receives
          // only the materialized request and cannot resolve or replay credentials.
          return await registration.dispatch({ ...request, init, credentialSlotRefs: [] });
        }
      : registration.dispatch;
  return Object.freeze({
    version: PROVIDER_REQUEST_DISPATCHER_VERSION,
    id: normalizeId(registration.id, "Provider request dispatcher ID"),
    trafficPolicyId: normalizeId(
      registration.trafficPolicyId,
      "Provider request dispatcher traffic-policy ID",
    ),
    trafficPolicyGeneration: normalizeId(
      registration.trafficPolicyGeneration,
      "Provider request dispatcher traffic-policy generation",
    ),
    credentialSlotRefs,
    dispatch,
    owner: normalizedOwner,
  });
}

export function registerProviderRequestDispatcherForOwnerV1(
  owner: string,
  registration: ProviderRequestDispatcherRegistrationV1,
  options: {
    credentialSlotResolvers?:
      | readonly CredentialSlotResolverV1[]
      | (() => readonly CredentialSlotResolverV1[]);
  } = {},
): () => void {
  const configuredCredentialSlotResolvers = options.credentialSlotResolvers;
  const resolveCredentialSlotResolvers =
    typeof configuredCredentialSlotResolvers === "function"
      ? configuredCredentialSlotResolvers
      : () => configuredCredentialSlotResolvers ?? [];
  const binding = compileBinding(owner, registration, resolveCredentialSlotResolvers);
  const current = bindings.get(binding.id);
  if (current) {
    throw new ProviderRequestDispatcherError(
      "duplicate-binding",
      `Provider request dispatcher "${binding.id}" is already registered by ${current.owner}`,
      binding.id,
    );
  }
  bindings = new Map(bindings).set(binding.id, binding);
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (bindings.get(binding.id) !== binding) {
      return;
    }
    const next = new Map(bindings);
    next.delete(binding.id);
    bindings = next;
  };
}

export function resolveProviderRequestDispatcherV1(params: {
  bindingId: string;
  trafficPolicyId: string;
  trafficPolicyGeneration: string;
}): ProviderRequestDispatcherBindingV1 {
  const bindingId = normalizeId(params.bindingId, "Provider request dispatcher ID");
  const binding = bindings.get(bindingId);
  if (!binding) {
    throw new ProviderRequestDispatcherError(
      "binding-unavailable",
      `Provider request dispatcher "${bindingId}" is unavailable`,
      bindingId,
    );
  }
  if (
    binding.trafficPolicyId !== params.trafficPolicyId ||
    binding.trafficPolicyGeneration !== params.trafficPolicyGeneration
  ) {
    throw new ProviderRequestDispatcherError(
      "stale-policy-generation",
      `Provider request dispatcher "${bindingId}" is stale for the selected traffic policy`,
      bindingId,
    );
  }
  return binding;
}

export function snapshotProviderRequestDispatcherProcessStateV1(): ProviderRequestDispatcherProcessStateV1 {
  return bindings;
}

export function restoreProviderRequestDispatcherProcessStateV1(
  state: ProviderRequestDispatcherProcessStateV1,
): void {
  bindings = state;
}

export function clearProviderRequestDispatchersV1(): void {
  bindings = new Map();
}
