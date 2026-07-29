import { createHash } from "node:crypto";
import { REVERSE_PROVIDER_DISPATCH_VERSION } from "./reverse-provider-dispatch.js";
import {
  PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION,
  type ReverseProviderSessionAuthorityV1,
} from "./reverse-provider-session.js";

export const REVERSE_PROVIDER_OWNER_GENERATION_VERSION =
  "reverse-provider-owner-generation/v1" as const;

export type ReverseProviderOwnerPreparationInputV1 = {
  bindingId: string;
  effectiveConfigGeneration: string;
  trafficPolicyId: string;
  trafficPolicyGeneration: string;
  hostBundleGeneration: string;
  audience: string;
  keyFingerprint: string;
};

export type PreparedReverseProviderOwnerBindingV1 = Readonly<{
  authority: Readonly<ReverseProviderSessionAuthorityV1>;
  effectiveConfigGeneration: string;
  trafficPolicyId: string;
  trafficPolicyGeneration: string;
}>;

const INPUT_KEYS = [
  "bindingId",
  "effectiveConfigGeneration",
  "trafficPolicyId",
  "trafficPolicyGeneration",
  "hostBundleGeneration",
  "audience",
  "keyFingerprint",
] as const;
const MAX_STRING_LENGTH = 512;

function parseInput(value: unknown): ReverseProviderOwnerPreparationInputV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("owner preparation must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(INPUT_KEYS);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  const missing = INPUT_KEYS.find((key) => !(key in record));
  if (unknown) {
    throw new Error(`owner preparation contains unknown field ${unknown}`);
  }
  if (missing) {
    throw new Error(`owner preparation is missing field ${missing}`);
  }
  const read = (key: (typeof INPUT_KEYS)[number]): string => {
    const field = record[key];
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > MAX_STRING_LENGTH ||
      field !== field.trim()
    ) {
      throw new Error(`owner preparation.${key} must be a non-empty bounded string`);
    }
    return field;
  };
  return {
    bindingId: read("bindingId"),
    effectiveConfigGeneration: read("effectiveConfigGeneration"),
    trafficPolicyId: read("trafficPolicyId"),
    trafficPolicyGeneration: read("trafficPolicyGeneration"),
    hostBundleGeneration: read("hostBundleGeneration"),
    audience: read("audience"),
    keyFingerprint: read("keyFingerprint"),
  };
}

/**
 * Prepares one complete reverse-provider owner binding and derives its opaque
 * semantic generation. Reconnects never mint a new owner generation.
 */
export function prepareReverseProviderOwnerBindingV1(
  value: ReverseProviderOwnerPreparationInputV1,
): PreparedReverseProviderOwnerBindingV1 {
  const input = parseInput(value);
  const identity = JSON.stringify({
    contractVersion: REVERSE_PROVIDER_OWNER_GENERATION_VERSION,
    bindingId: input.bindingId,
    interfaceVersion: PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION,
    carrierVersion: REVERSE_PROVIDER_DISPATCH_VERSION,
    effectiveConfigGeneration: input.effectiveConfigGeneration,
    trafficPolicyId: input.trafficPolicyId,
    trafficPolicyGeneration: input.trafficPolicyGeneration,
    hostBundleGeneration: input.hostBundleGeneration,
    audience: input.audience,
    keyFingerprint: input.keyFingerprint,
  });
  const ownerGeneration = `${REVERSE_PROVIDER_OWNER_GENERATION_VERSION}:sha256:${createHash("sha256").update(identity).digest("hex")}`;
  const authority = Object.freeze({
    bindingId: input.bindingId,
    interfaceVersion: PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION,
    carrierVersion: REVERSE_PROVIDER_DISPATCH_VERSION,
    ownerGeneration,
    hostBundleGeneration: input.hostBundleGeneration,
    audience: input.audience,
    keyFingerprint: input.keyFingerprint,
  });
  return Object.freeze({
    authority,
    effectiveConfigGeneration: input.effectiveConfigGeneration,
    trafficPolicyId: input.trafficPolicyId,
    trafficPolicyGeneration: input.trafficPolicyGeneration,
  });
}
