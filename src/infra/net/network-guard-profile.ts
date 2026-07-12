import { normalizeHostname } from "./hostname.js";

export const NETWORK_GUARD_PROFILE_VERSION = "network-guard/v1" as const;

export type NetworkGuardRouteMode =
  | "direct"
  | "environment-proxy"
  | "explicit-proxy"
  | "managed-proxy";

export type NetworkGuardResolutionMode = "pinned" | "proxy" | "caller";

export type NetworkGuardAddressMode = "public-only" | "trusted-host" | "allow-private-network";

export type NetworkGuardProfileV1 = {
  version: typeof NETWORK_GUARD_PROFILE_VERSION;
  target: {
    protocol: "http:" | "https:";
    origin: string;
    hostname: string;
    port: number;
  };
  route: {
    mode: NetworkGuardRouteMode;
    resolution: NetworkGuardResolutionMode;
    tls: "required" | "cleartext";
  };
  addressPolicy: {
    mode: NetworkGuardAddressMode;
    trustedHostnames: string[];
    hostnameAllowlist: string[];
    allowedPrivateCidrs: string[];
    allowRfc2544BenchmarkRange: boolean;
    allowIpv6UniqueLocalRange: boolean;
    dnsRebinding: {
      policy: "reject";
      enforcement: "local-pinned" | "connection-owner-required" | "not-enforced";
    };
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique non-empty strings`);
  }
}

function expectedDnsRebindingEnforcement(
  resolution: NetworkGuardResolutionMode,
): NetworkGuardProfileV1["addressPolicy"]["dnsRebinding"]["enforcement"] {
  if (resolution === "pinned") {
    return "local-pinned";
  }
  return resolution === "proxy" ? "connection-owner-required" : "not-enforced";
}

/** Validates the complete fixed-shape network guard contract before enforcement. */
export function assertNetworkGuardProfileV1(
  value: unknown,
): asserts value is NetworkGuardProfileV1 {
  const profile = requireRecord(value, "network guard profile");
  assertExactKeys(
    profile,
    ["version", "target", "route", "addressPolicy"],
    "network guard profile",
  );
  if (profile.version !== NETWORK_GUARD_PROFILE_VERSION) {
    throw new Error(`Unsupported network guard profile version: ${String(profile.version)}`);
  }

  const target = requireRecord(profile.target, "network guard target");
  assertExactKeys(target, ["protocol", "origin", "hostname", "port"], "network guard target");
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("network guard target protocol is invalid");
  }
  if (
    typeof target.origin !== "string" ||
    typeof target.hostname !== "string" ||
    !Number.isSafeInteger(target.port) ||
    (target.port as number) < 1 ||
    (target.port as number) > 65535
  ) {
    throw new Error("network guard target is invalid");
  }
  let origin: URL;
  try {
    origin = new URL(target.origin);
  } catch {
    throw new Error("network guard target origin is invalid");
  }
  if (
    origin.origin !== target.origin ||
    origin.protocol !== target.protocol ||
    normalizeHostname(origin.hostname) !== normalizeHostname(target.hostname) ||
    resolveUrlPort(origin) !== target.port
  ) {
    throw new Error("network guard target origin is inconsistent");
  }

  const route = requireRecord(profile.route, "network guard route");
  assertExactKeys(route, ["mode", "resolution", "tls"], "network guard route");
  if (
    !["direct", "environment-proxy", "explicit-proxy", "managed-proxy"].includes(
      String(route.mode),
    ) ||
    !["pinned", "proxy", "caller"].includes(String(route.resolution)) ||
    (route.tls !== "required" && route.tls !== "cleartext")
  ) {
    throw new Error("network guard route is invalid");
  }
  if (
    (target.protocol === "https:" && route.tls !== "required") ||
    (target.protocol === "http:" && route.tls !== "cleartext")
  ) {
    throw new Error("network guard route TLS posture does not match target protocol");
  }

  const addressPolicy = requireRecord(profile.addressPolicy, "network guard address policy");
  assertExactKeys(
    addressPolicy,
    [
      "mode",
      "trustedHostnames",
      "hostnameAllowlist",
      "allowedPrivateCidrs",
      "allowRfc2544BenchmarkRange",
      "allowIpv6UniqueLocalRange",
      "dnsRebinding",
    ],
    "network guard address policy",
  );
  if (
    addressPolicy.mode !== "public-only" &&
    addressPolicy.mode !== "trusted-host" &&
    addressPolicy.mode !== "allow-private-network"
  ) {
    throw new Error("network guard address mode is invalid");
  }
  assertStringArray(addressPolicy.trustedHostnames, "network guard trustedHostnames");
  assertStringArray(addressPolicy.hostnameAllowlist, "network guard hostnameAllowlist");
  assertStringArray(addressPolicy.allowedPrivateCidrs, "network guard allowedPrivateCidrs");
  if (
    typeof addressPolicy.allowRfc2544BenchmarkRange !== "boolean" ||
    typeof addressPolicy.allowIpv6UniqueLocalRange !== "boolean"
  ) {
    throw new Error("network guard address flags are invalid");
  }
  const dnsRebinding = requireRecord(addressPolicy.dnsRebinding, "network guard dnsRebinding");
  assertExactKeys(dnsRebinding, ["policy", "enforcement"], "network guard dnsRebinding");
  if (
    dnsRebinding.policy !== "reject" ||
    !["local-pinned", "connection-owner-required", "not-enforced"].includes(
      String(dnsRebinding.enforcement),
    )
  ) {
    throw new Error("network guard DNS rebinding policy is invalid");
  }
  if (
    dnsRebinding.enforcement !==
    expectedDnsRebindingEnforcement(route.resolution as NetworkGuardResolutionMode)
  ) {
    throw new Error("network guard DNS rebinding enforcement does not match resolution mode");
  }
}

function resolveUrlPort(url: URL): number {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }
  return url.protocol === "https:" ? 443 : 80;
}

export function assertNetworkGuardProfileTarget(
  profile: NetworkGuardProfileV1,
  requestUrl: string,
): void {
  assertNetworkGuardProfileV1(profile);
  const parsed = new URL(requestUrl);
  const hostname = normalizeHostname(parsed.hostname);
  if (
    parsed.protocol !== profile.target.protocol ||
    parsed.origin !== profile.target.origin ||
    hostname !== profile.target.hostname ||
    resolveUrlPort(parsed) !== profile.target.port
  ) {
    throw new Error("Network guard profile target does not match one-hop request URL");
  }
}

export function assertLocalNetworkGuardPrepared(params: {
  profile: NetworkGuardProfileV1;
  requestUrl: string;
  hasDispatcher: boolean;
}): void {
  assertNetworkGuardProfileTarget(params.profile, params.requestUrl);
  const expectedEnforcement = expectedDnsRebindingEnforcement(params.profile.route.resolution);
  if (params.profile.addressPolicy.dnsRebinding.enforcement !== expectedEnforcement) {
    throw new Error("Network guard DNS rebinding enforcement does not match resolution mode");
  }
  if (expectedEnforcement === "local-pinned" && !params.hasDispatcher) {
    throw new Error("Pinned network guard profile requires a prepared local dispatcher");
  }
}
