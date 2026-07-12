import {
  assertNetworkGuardProfileTarget,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";

export const REVERSE_PROVIDER_DISPATCH_VERSION = "reverse-provider-dispatch/v1" as const;

export type ReverseProviderDispatchCertainty =
  | "not-started"
  | "started-unconfirmed"
  | "response-started"
  | "completed";

export type ReverseProviderDispatchFailureCode =
  | "denied"
  | "unavailable"
  | "overloaded"
  | "stale-generation"
  | "timeout"
  | "cancelled"
  | "not-started"
  | "started-unconfirmed"
  | "response-limit-exceeded"
  | "protocol-violation"
  | "connection-lost";

type FrameBase = {
  version: typeof REVERSE_PROVIDER_DISPATCH_VERSION;
  incarnationId: string;
  operationId: string;
  ownerGeneration: string;
  hostBundleGeneration: string;
};

export type ReverseProviderDispatchOperationOpenV1 = FrameBase & {
  type: "operation-open";
  bindingId: string;
  deadlineMs: number;
  requestByteLimit: number;
  responseByteLimit: number;
  maxFrameBytes: number;
  maxChunkBytes: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    credentialSlotRefs?: string[];
    routeProfile: string;
    networkGuard: NetworkGuardProfileV1;
    auditCorrelation: string;
  };
};

export type ReverseProviderDispatchFrameV1 =
  | ReverseProviderDispatchOperationOpenV1
  | (FrameBase & {
      type: "credit";
      stream: "request" | "response";
      bytes: number;
    })
  | (FrameBase & {
      type: "chunk";
      stream: "request" | "response";
      sequence: number;
      payloadBase64: string;
    })
  | (FrameBase & {
      type: "half-close";
      stream: "request" | "response";
    })
  | (FrameBase & {
      type: "dispatch-started";
    })
  | (FrameBase & {
      type: "response-open";
      status: number;
      statusText: string;
      headers: Record<string, string>;
    })
  | (FrameBase & {
      type: "cancel";
      reason: string;
    })
  | (FrameBase & {
      type: "terminal";
      outcome: "completed" | "failed";
      certainty: ReverseProviderDispatchCertainty;
      failureCode?: ReverseProviderDispatchFailureCode;
    });

export type ReverseProviderDispatchTraceResult =
  | {
      ok: true;
      terminal: {
        outcome: "completed" | "failed";
        certainty: ReverseProviderDispatchCertainty;
        failureCode?: ReverseProviderDispatchFailureCode;
      };
      cancelled: boolean;
      ignoredFrames: number;
    }
  | {
      ok: false;
      code: "incomplete-trace" | "protocol-violation" | "stale-generation";
      frameIndex: number;
      certainty: ReverseProviderDispatchCertainty;
      message: string;
    };

const BASE_KEYS = [
  "version",
  "incarnationId",
  "operationId",
  "ownerGeneration",
  "hostBundleGeneration",
  "type",
] as const;

const FAILURE_CODES = new Set<ReverseProviderDispatchFailureCode>([
  "denied",
  "unavailable",
  "overloaded",
  "stale-generation",
  "timeout",
  "cancelled",
  "not-started",
  "started-unconfirmed",
  "response-limit-exceeded",
  "protocol-violation",
  "connection-lost",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new Error(`${label} contains unknown field ${unknown}`);
  }
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label}.${key} must be a non-empty bounded string`);
  }
  return value;
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label}.${key} must be a positive integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  return value as number;
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
  const record = assertRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    if (!key || typeof entry !== "string") {
      throw new Error(`${label} must contain only string keys and values`);
    }
  }
  return record as Record<string, string>;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function requireStream(record: Record<string, unknown>, label: string): "request" | "response" {
  const value = record.stream;
  if (value !== "request" && value !== "response") {
    throw new Error(`${label}.stream must be request or response`);
  }
  return value;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function measureReverseProviderDispatchChunkBytesV1(value: unknown): number {
  const label = "chunk.payloadBase64";
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const finalDataIndex = value.length - padding - 1;
  const finalSextet =
    finalDataIndex >= 0 ? BASE64_ALPHABET.indexOf(value[finalDataIndex] ?? "") : 0;
  if (
    (padding === 2 && (finalSextet & 0b1111) !== 0) ||
    (padding === 1 && (finalSextet & 0b11) !== 0)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  return (value.length / 4) * 3 - padding;
}

function encodedFrameBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("frame is not JSON serializable");
  }
  return Buffer.byteLength(encoded, "utf8");
}

function encodedChunkFrameBytes(
  open: Record<string, unknown>,
  stream: "request" | "response",
  sequence: number,
  payloadBytes: number,
): number {
  const emptyChunk = {
    version: open.version,
    incarnationId: open.incarnationId,
    operationId: open.operationId,
    ownerGeneration: open.ownerGeneration,
    hostBundleGeneration: open.hostBundleGeneration,
    type: "chunk",
    stream,
    sequence,
    payloadBase64: "",
  };
  return encodedFrameBytes(emptyChunk) + 4 * Math.ceil(payloadBytes / 3);
}

function assertFrameBase(record: Record<string, unknown>): void {
  if (record.version !== REVERSE_PROVIDER_DISPATCH_VERSION) {
    throw new Error(`Unsupported reverse provider dispatch version: ${String(record.version)}`);
  }
  requireString(record, "incarnationId", "frame");
  requireString(record, "operationId", "frame");
  requireString(record, "ownerGeneration", "frame");
  requireString(record, "hostBundleGeneration", "frame");
}

function assertOperationOpen(record: Record<string, unknown>): void {
  assertKeys(
    record,
    [
      ...BASE_KEYS,
      "bindingId",
      "deadlineMs",
      "requestByteLimit",
      "responseByteLimit",
      "maxFrameBytes",
      "maxChunkBytes",
      "request",
    ],
    "operation-open",
  );
  requireString(record, "bindingId", "operation-open");
  requirePositiveInteger(record, "deadlineMs", "operation-open");
  requirePositiveInteger(record, "requestByteLimit", "operation-open");
  requirePositiveInteger(record, "responseByteLimit", "operation-open");
  const maxFrameBytes = requirePositiveInteger(record, "maxFrameBytes", "operation-open");
  const maxChunkBytes = requirePositiveInteger(record, "maxChunkBytes", "operation-open");
  if (
    maxChunkBytes > (record.requestByteLimit as number) ||
    maxChunkBytes > (record.responseByteLimit as number)
  ) {
    throw new Error("operation-open.maxChunkBytes must not exceed stream byte limits");
  }
  if (encodedFrameBytes(record) > maxFrameBytes) {
    throw new Error("operation-open exceeds maxFrameBytes");
  }
  if (
    encodedChunkFrameBytes(
      record,
      "request",
      (record.requestByteLimit as number) - 1,
      maxChunkBytes,
    ) > maxFrameBytes ||
    encodedChunkFrameBytes(
      record,
      "response",
      (record.responseByteLimit as number) - 1,
      maxChunkBytes,
    ) > maxFrameBytes
  ) {
    throw new Error("operation-open.maxChunkBytes cannot fit within maxFrameBytes");
  }
  const request = assertRecord(record.request, "operation-open.request");
  assertKeys(
    request,
    [
      "method",
      "url",
      "headers",
      "credentialSlotRefs",
      "routeProfile",
      "networkGuard",
      "auditCorrelation",
    ],
    "operation-open.request",
  );
  requireString(request, "method", "operation-open.request");
  const url = requireString(request, "url", "operation-open.request");
  requireStringRecord(request.headers, "operation-open.request.headers");
  if (request.credentialSlotRefs !== undefined) {
    requireStringArray(request.credentialSlotRefs, "operation-open.request.credentialSlotRefs");
  }
  requireString(request, "routeProfile", "operation-open.request");
  requireString(request, "auditCorrelation", "operation-open.request");
  const networkGuard = assertRecord(request.networkGuard, "operation-open.request.networkGuard");
  assertNetworkGuardProfileTarget(networkGuard as NetworkGuardProfileV1, url);
}

export function assertReverseProviderDispatchFrameV1(
  value: unknown,
): ReverseProviderDispatchFrameV1 {
  const record = assertRecord(value, "frame");
  assertFrameBase(record);
  if (record.type === "operation-open") {
    assertOperationOpen(record);
    return record as ReverseProviderDispatchOperationOpenV1;
  }
  if (record.type === "credit") {
    assertKeys(record, [...BASE_KEYS, "stream", "bytes"], "credit");
    requireStream(record, "credit");
    requirePositiveInteger(record, "bytes", "credit");
    return record as ReverseProviderDispatchFrameV1;
  }
  if (record.type === "chunk") {
    assertKeys(record, [...BASE_KEYS, "stream", "sequence", "payloadBase64"], "chunk");
    requireStream(record, "chunk");
    requireNonNegativeInteger(record, "sequence", "chunk");
    measureReverseProviderDispatchChunkBytesV1(record.payloadBase64);
    return record as ReverseProviderDispatchFrameV1;
  }
  if (record.type === "half-close") {
    assertKeys(record, [...BASE_KEYS, "stream"], "half-close");
    requireStream(record, "half-close");
    return record as ReverseProviderDispatchFrameV1;
  }
  if (record.type === "dispatch-started") {
    assertKeys(record, BASE_KEYS, "dispatch-started");
    return record as ReverseProviderDispatchFrameV1;
  }
  if (record.type === "response-open") {
    assertKeys(record, [...BASE_KEYS, "status", "statusText", "headers"], "response-open");
    const status = requirePositiveInteger(record, "status", "response-open");
    if (status < 100 || status > 599) {
      throw new Error("response-open.status must be an HTTP status code");
    }
    if (typeof record.statusText !== "string" || record.statusText.length > 256) {
      throw new Error("response-open.statusText must be a bounded string");
    }
    requireStringRecord(record.headers, "response-open.headers");
    return record as ReverseProviderDispatchFrameV1;
  }
  if (record.type === "cancel") {
    assertKeys(record, [...BASE_KEYS, "reason"], "cancel");
    requireString(record, "reason", "cancel");
    return record as ReverseProviderDispatchFrameV1;
  }
  if (record.type === "terminal") {
    assertKeys(record, [...BASE_KEYS, "outcome", "certainty", "failureCode"], "terminal");
    if (record.outcome !== "completed" && record.outcome !== "failed") {
      throw new Error("terminal.outcome is invalid");
    }
    if (
      record.certainty !== "not-started" &&
      record.certainty !== "started-unconfirmed" &&
      record.certainty !== "response-started" &&
      record.certainty !== "completed"
    ) {
      throw new Error("terminal.certainty is invalid");
    }
    if (record.outcome === "completed") {
      if (record.certainty !== "completed" || record.failureCode !== undefined) {
        throw new Error("completed terminal must have completed certainty and no failure code");
      }
    } else if (
      typeof record.failureCode !== "string" ||
      !FAILURE_CODES.has(record.failureCode as ReverseProviderDispatchFailureCode)
    ) {
      throw new Error("failed terminal requires a failure code");
    }
    return record as ReverseProviderDispatchFrameV1;
  }
  throw new Error(`Unsupported reverse provider dispatch frame type: ${String(record.type)}`);
}
