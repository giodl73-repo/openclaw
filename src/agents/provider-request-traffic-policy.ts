import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
import type { ProviderEndpointClass } from "./provider-attribution.js";

export const PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION =
  "provider-request-traffic-policy/v1" as const;

export type ProviderRequestTrafficPolicyProvenanceV1 = {
  source: string;
  revision: string;
};

// V1 is attached only to the guarded streaming LLM fetch path. Additional
// capabilities and transports require equivalent enforcement before expansion.
export type ProviderRequestTrafficPolicyCapabilityV1 = "llm";
export type ProviderRequestTrafficPolicyTransportV1 = "stream";

export type ProviderRequestTrafficPolicyMatchV1 = {
  providers?: readonly string[];
  capabilities?: readonly ProviderRequestTrafficPolicyCapabilityV1[];
  transports?: readonly ProviderRequestTrafficPolicyTransportV1[];
  endpointClasses?: readonly ProviderEndpointClass[];
  origins?: readonly string[];
};

export type ProviderRequestTrafficPolicyRuleV1 = {
  id: string;
  match: ProviderRequestTrafficPolicyMatchV1;
  outcome:
    | {
        action: "deny";
        reason: string;
      }
    | {
        action: "allow";
        routeProfileId: string;
        allowedOrigins: readonly string[];
        allowPrivateNetwork: boolean;
        maximumTimeoutMs?: number;
      };
};

export type ProviderRequestTrafficPolicyRouteProfileV1 = {
  id: string;
  dispatcherPolicy: PinnedDispatcherPolicy;
  dispatchBindingId?: string;
};

export type ProviderRequestTrafficPolicyRegistrationV1 = {
  version: typeof PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION;
  id: string;
  generation: string;
  required: boolean;
  provenance: ProviderRequestTrafficPolicyProvenanceV1;
  rules: readonly ProviderRequestTrafficPolicyRuleV1[];
  routeProfiles: readonly ProviderRequestTrafficPolicyRouteProfileV1[];
};

export type ProviderRequestTrafficPolicySnapshotV1 = ProviderRequestTrafficPolicyRegistrationV1 & {
  readiness: "ready";
};

export type ProviderRequestTrafficPolicyFactsV1 = {
  provider: string;
  capability: ProviderRequestTrafficPolicyCapabilityV1;
  transport: ProviderRequestTrafficPolicyTransportV1;
  endpointClass: ProviderEndpointClass;
  url: string;
  allowPrivateNetwork: boolean;
  timeoutMs?: number;
  dispatcherPolicy?: PinnedDispatcherPolicy;
};

export type ProviderRequestTrafficPolicyDecisionV1 =
  | {
      action: "deny";
      policyId: string;
      policyGeneration: string;
      reason: string;
    }
  | {
      action: "allow";
      policyId: string;
      policyGeneration: string;
      routeProfileId: string;
      dispatchBindingId?: string;
      allowPrivateNetwork: boolean;
      timeoutMs?: number;
      dispatcherPolicy: PinnedDispatcherPolicy;
    };

const ID_RE = /^[a-z0-9][a-z0-9._/-]*$/;
let currentPolicy:
  | {
      owner: string;
      snapshot: ProviderRequestTrafficPolicySnapshotV1;
    }
  | undefined;

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!ID_RE.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Provider request traffic policy origin is invalid");
  }
  return url.origin;
}

function normalizeStringSet(values: readonly string[] | undefined): readonly string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .toSorted();
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
    throw new Error("Provider request traffic policy match set is invalid");
  }
  return Object.freeze(normalized);
}

function cloneRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (value.rejectUnauthorized === false) {
    throw new Error("Provider request traffic policy cannot disable TLS verification");
  }
  return Object.freeze({ ...value });
}

function cloneDispatcherPolicy(policy: PinnedDispatcherPolicy): PinnedDispatcherPolicy {
  let pinnedHostname: { hostname: string; addresses: string[] } | undefined;
  if (policy.pinnedHostname) {
    if (policy.pinnedHostname.addresses.length === 0) {
      throw new Error("Provider request traffic policy pinned hostname has no addresses");
    }
    pinnedHostname = {
      hostname: policy.pinnedHostname.hostname,
      addresses: [...policy.pinnedHostname.addresses],
    };
    Object.freeze(pinnedHostname.addresses);
    Object.freeze(pinnedHostname);
  }
  if (policy.mode === "direct") {
    return Object.freeze({
      mode: "direct",
      ...(policy.connect ? { connect: cloneRecord(policy.connect) } : {}),
      ...(pinnedHostname ? { pinnedHostname } : {}),
    });
  }
  if (policy.mode === "env-proxy") {
    return Object.freeze({
      mode: "env-proxy",
      ...(policy.connect ? { connect: cloneRecord(policy.connect) } : {}),
      ...(policy.proxyTls ? { proxyTls: cloneRecord(policy.proxyTls) } : {}),
      ...(pinnedHostname ? { pinnedHostname } : {}),
    });
  }
  const proxyUrl = new URL(policy.proxyUrl);
  if (!["http:", "https:"].includes(proxyUrl.protocol)) {
    throw new Error("Provider request traffic policy proxy URL is invalid");
  }
  return Object.freeze({
    mode: "explicit-proxy",
    proxyUrl: proxyUrl.toString(),
    ...(policy.allowPrivateProxy === true ? { allowPrivateProxy: true } : {}),
    ...(policy.proxyTls ? { proxyTls: cloneRecord(policy.proxyTls) } : {}),
    ...(pinnedHostname ? { pinnedHostname } : {}),
  });
}

function normalizeRegistration(
  registration: ProviderRequestTrafficPolicyRegistrationV1,
): ProviderRequestTrafficPolicySnapshotV1 {
  if (registration.version !== PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION) {
    throw new Error("Provider request traffic policy version is unsupported");
  }
  const id = normalizeId(registration.id, "Provider request traffic policy ID");
  const generation = registration.generation.trim();
  const source = registration.provenance.source.trim();
  const revision = registration.provenance.revision.trim();
  if (!generation || !source || !revision) {
    throw new Error("Provider request traffic policy provenance is incomplete");
  }

  const routeIds = new Set<string>();
  const routeProfiles = registration.routeProfiles.map((profile) => {
    const profileId = normalizeId(profile.id, "Provider request route profile ID");
    if (routeIds.has(profileId)) {
      throw new Error(`Duplicate provider request route profile: ${profileId}`);
    }
    routeIds.add(profileId);
    return Object.freeze({
      id: profileId,
      dispatcherPolicy: cloneDispatcherPolicy(profile.dispatcherPolicy),
      ...(profile.dispatchBindingId
        ? {
            dispatchBindingId: normalizeId(
              profile.dispatchBindingId,
              "Provider request dispatch binding ID",
            ),
          }
        : {}),
    });
  });
  if (routeProfiles.length === 0) {
    throw new Error("Provider request traffic policy requires a route profile");
  }

  const ruleIds = new Set<string>();
  const rules = registration.rules.map((rule) => {
    const ruleId = normalizeId(rule.id, "Provider request traffic policy rule ID");
    if (ruleIds.has(ruleId)) {
      throw new Error(`Duplicate provider request traffic policy rule: ${ruleId}`);
    }
    ruleIds.add(ruleId);
    const providers = normalizeStringSet(rule.match.providers);
    const match = Object.freeze({
      providers: providers
        ? Object.freeze(providers.map((value) => value.toLowerCase()))
        : undefined,
      capabilities: normalizeStringSet(rule.match.capabilities) as
        | readonly ProviderRequestTrafficPolicyCapabilityV1[]
        | undefined,
      transports: normalizeStringSet(rule.match.transports) as
        | readonly ProviderRequestTrafficPolicyTransportV1[]
        | undefined,
      endpointClasses: normalizeStringSet(rule.match.endpointClasses) as
        | readonly ProviderEndpointClass[]
        | undefined,
      origins: rule.match.origins
        ? Object.freeze(rule.match.origins.map(normalizeOrigin).toSorted())
        : undefined,
    });
    if (rule.outcome.action === "deny") {
      const reason = rule.outcome.reason.trim();
      if (!reason) {
        throw new Error("Provider request traffic policy deny reason is required");
      }
      return Object.freeze({
        id: ruleId,
        match,
        outcome: Object.freeze({ action: "deny" as const, reason }),
      });
    }
    const routeProfileId = normalizeId(
      rule.outcome.routeProfileId,
      "Provider request route profile reference",
    );
    if (!routeIds.has(routeProfileId)) {
      throw new Error(`Unknown provider request route profile: ${routeProfileId}`);
    }
    const allowedOrigins = rule.outcome.allowedOrigins.map(normalizeOrigin).toSorted();
    if (allowedOrigins.length === 0 || new Set(allowedOrigins).size !== allowedOrigins.length) {
      throw new Error("Provider request traffic policy allowed origins are invalid");
    }
    if (
      rule.outcome.maximumTimeoutMs !== undefined &&
      (!Number.isSafeInteger(rule.outcome.maximumTimeoutMs) || rule.outcome.maximumTimeoutMs <= 0)
    ) {
      throw new Error("Provider request traffic policy timeout is invalid");
    }
    return Object.freeze({
      id: ruleId,
      match,
      outcome: Object.freeze({
        action: "allow" as const,
        routeProfileId,
        allowedOrigins: Object.freeze(allowedOrigins),
        allowPrivateNetwork: rule.outcome.allowPrivateNetwork,
        ...(rule.outcome.maximumTimeoutMs !== undefined
          ? { maximumTimeoutMs: rule.outcome.maximumTimeoutMs }
          : {}),
      }),
    });
  });
  if (rules.length === 0) {
    throw new Error("Provider request traffic policy requires a rule");
  }
  return Object.freeze({
    version: PROVIDER_REQUEST_TRAFFIC_POLICY_VERSION,
    id,
    generation,
    required: registration.required,
    provenance: Object.freeze({ source, revision }),
    rules: Object.freeze(rules),
    routeProfiles: Object.freeze(routeProfiles),
    readiness: "ready",
  });
}

export function registerProviderRequestTrafficPolicyV1(
  registration: ProviderRequestTrafficPolicyRegistrationV1,
): () => void {
  return registerProviderRequestTrafficPolicyForOwnerV1("core", registration);
}

export function registerProviderRequestTrafficPolicyForOwnerV1(
  owner: string,
  registration: ProviderRequestTrafficPolicyRegistrationV1,
): () => void {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error("Provider request traffic policy owner is required");
  }
  const snapshot = normalizeRegistration(registration);
  if (currentPolicy && currentPolicy.owner !== normalizedOwner) {
    throw new Error(
      `Provider request traffic policy is already registered by another owner: ${currentPolicy.owner}`,
    );
  }
  if (currentPolicy && currentPolicy.snapshot.id !== snapshot.id) {
    throw new Error(
      `Provider request traffic policy is already registered: ${currentPolicy.snapshot.id}`,
    );
  }
  const published = { owner: normalizedOwner, snapshot };
  currentPolicy = published;
  return () => {
    if (currentPolicy === published) {
      currentPolicy = undefined;
    }
  };
}

export function getCurrentProviderRequestTrafficPolicyV1():
  | ProviderRequestTrafficPolicySnapshotV1
  | undefined {
  return currentPolicy?.snapshot;
}

export function clearCurrentProviderRequestTrafficPolicyV1(): void {
  currentPolicy = undefined;
}

function matchesRule(
  match: ProviderRequestTrafficPolicyMatchV1,
  facts: ProviderRequestTrafficPolicyFactsV1,
  origin: string,
): boolean {
  return (
    (!match.providers || match.providers.includes(facts.provider.toLowerCase())) &&
    (!match.capabilities || match.capabilities.includes(facts.capability)) &&
    (!match.transports || match.transports.includes(facts.transport)) &&
    (!match.endpointClasses || match.endpointClasses.includes(facts.endpointClass)) &&
    (!match.origins || match.origins.includes(origin))
  );
}

function mergeRecord(
  base: Record<string, unknown> | undefined,
  selected: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base) {
    return selected ? { ...selected } : undefined;
  }
  if (!selected) {
    return { ...base };
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(selected)) {
    if (key in merged && !Object.is(merged[key], value)) {
      throw new Error(`Provider request traffic policy conflicts on TLS field ${key}`);
    }
    merged[key] = value;
  }
  return merged;
}

function intersectPinnedHostname(
  base: PinnedDispatcherPolicy["pinnedHostname"],
  selected: PinnedDispatcherPolicy["pinnedHostname"],
): PinnedDispatcherPolicy["pinnedHostname"] {
  if (!base) {
    return selected;
  }
  if (!selected) {
    return base;
  }
  if (base.hostname.toLowerCase() !== selected.hostname.toLowerCase()) {
    throw new Error("Provider request traffic policy conflicts on pinned hostname");
  }
  const selectedAddresses = new Set(selected.addresses);
  const addresses = base.addresses.filter((address) => selectedAddresses.has(address));
  if (addresses.length === 0) {
    throw new Error("Provider request traffic policy conflicts on pinned addresses");
  }
  return {
    hostname: base.hostname,
    addresses,
  };
}

function intersectDispatcherPolicy(
  base: PinnedDispatcherPolicy | undefined,
  selected: PinnedDispatcherPolicy,
): PinnedDispatcherPolicy {
  if (!base || base.mode === "direct") {
    if (
      base?.mode === "direct" &&
      selected.mode !== "direct" &&
      (base.connect || base.pinnedHostname)
    ) {
      throw new Error(
        "Provider request traffic policy cannot replace prepared direct-route security",
      );
    }
    const connect = mergeRecord(
      base?.connect,
      "connect" in selected ? selected.connect : undefined,
    );
    const pinnedHostname = intersectPinnedHostname(base?.pinnedHostname, selected.pinnedHostname);
    return {
      ...selected,
      ...(connect ? { connect } : {}),
      ...(pinnedHostname ? { pinnedHostname } : {}),
    } as PinnedDispatcherPolicy;
  }
  if (base.mode !== selected.mode) {
    throw new Error("Provider request traffic policy conflicts with the configured proxy route");
  }
  if (base.mode === "explicit-proxy" && selected.mode === "explicit-proxy") {
    if (new URL(base.proxyUrl).toString() !== new URL(selected.proxyUrl).toString()) {
      throw new Error("Provider request traffic policy conflicts with the configured proxy URL");
    }
    return {
      ...selected,
      proxyUrl: base.proxyUrl,
      allowPrivateProxy: base.allowPrivateProxy === true && selected.allowPrivateProxy === true,
      proxyTls: mergeRecord(base.proxyTls, selected.proxyTls),
      pinnedHostname: intersectPinnedHostname(base.pinnedHostname, selected.pinnedHostname),
    };
  }
  if (base.mode === "env-proxy" && selected.mode === "env-proxy") {
    return {
      ...selected,
      connect: mergeRecord(base.connect, selected.connect),
      proxyTls: mergeRecord(base.proxyTls, selected.proxyTls),
      pinnedHostname: intersectPinnedHostname(base.pinnedHostname, selected.pinnedHostname),
    };
  }
  throw new Error("Provider request traffic policy route is incompatible");
}

export function evaluateCurrentProviderRequestTrafficPolicyV1(
  facts: ProviderRequestTrafficPolicyFactsV1,
): ProviderRequestTrafficPolicyDecisionV1 | undefined {
  const policy = currentPolicy?.snapshot;
  if (!policy) {
    return undefined;
  }
  const origin = new URL(facts.url).origin;
  const matching = policy.rules.filter((rule) => matchesRule(rule.match, facts, origin));
  if (matching.length === 0) {
    return policy.required
      ? {
          action: "deny",
          policyId: policy.id,
          policyGeneration: policy.generation,
          reason: "RequiredPolicyNoMatch",
        }
      : undefined;
  }
  const denied = matching.find((rule) => rule.outcome.action === "deny");
  if (denied?.outcome.action === "deny") {
    return {
      action: "deny",
      policyId: policy.id,
      policyGeneration: policy.generation,
      reason: denied.outcome.reason,
    };
  }
  const allowed = matching.filter(
    (rule): rule is typeof rule & { outcome: Extract<typeof rule.outcome, { action: "allow" }> } =>
      rule.outcome.action === "allow",
  );
  if (allowed.some((rule) => !rule.outcome.allowedOrigins.includes(origin))) {
    return {
      action: "deny",
      policyId: policy.id,
      policyGeneration: policy.generation,
      reason: "DestinationOutsidePolicy",
    };
  }
  const routeProfileIds = new Set(allowed.map((rule) => rule.outcome.routeProfileId));
  if (routeProfileIds.size !== 1) {
    return {
      action: "deny",
      policyId: policy.id,
      policyGeneration: policy.generation,
      reason: "ConflictingRouteProfiles",
    };
  }
  const routeProfileId = allowed[0]?.outcome.routeProfileId;
  const routeProfile = policy.routeProfiles.find((profile) => profile.id === routeProfileId);
  if (!routeProfile) {
    return {
      action: "deny",
      policyId: policy.id,
      policyGeneration: policy.generation,
      reason: "RouteProfileUnavailable",
    };
  }
  try {
    return {
      action: "allow",
      policyId: policy.id,
      policyGeneration: policy.generation,
      routeProfileId: routeProfile.id,
      ...(routeProfile.dispatchBindingId
        ? { dispatchBindingId: routeProfile.dispatchBindingId }
        : {}),
      allowPrivateNetwork:
        facts.allowPrivateNetwork &&
        allowed.every((rule) => rule.outcome.allowPrivateNetwork === true),
      ...(() => {
        const timeouts = [
          facts.timeoutMs,
          ...allowed.map((rule) => rule.outcome.maximumTimeoutMs),
        ].filter((value): value is number => value !== undefined);
        return timeouts.length > 0 ? { timeoutMs: Math.min(...timeouts) } : {};
      })(),
      dispatcherPolicy: intersectDispatcherPolicy(
        facts.dispatcherPolicy,
        routeProfile.dispatcherPolicy,
      ),
    };
  } catch {
    return {
      action: "deny",
      policyId: policy.id,
      policyGeneration: policy.generation,
      reason: "ConfiguredRouteConflict",
    };
  }
}
