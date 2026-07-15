import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";

export const ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION =
  "anthropic-direct-model-provider-adapter/v1" as const;
export const ANTHROPIC_DIRECT_MODEL_ADAPTER_ID = "anthropic/direct" as const;
export const ANTHROPIC_API_KEY_SLOT_ID = "anthropic/api-key" as const;
export const ANTHROPIC_DIRECT_ORIGIN = "https://api.anthropic.com" as const;
export const ANTHROPIC_DIRECT_MESSAGES_PATH = "/v1/messages" as const;
export const ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;
const ANTHROPIC_PASSTHROUGH_HEADERS = ["accept", "anthropic-beta", "anthropic-version"] as const;

export type AnthropicDirectAdapterConfigV1 = {
  endpoint?: string;
};

export type AnthropicDirectRequestContextV1 = {
  originalUrl: string;
};

export type AnthropicDirectResponsePolicyV1 = Readonly<{
  mode: "anthropic-messages";
  streaming: boolean;
}>;

export type PreparedAnthropicDirectRequestV1 = {
  adapterVersion: typeof ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION;
  url: string;
  method: "POST";
  headers: Headers;
  body: Uint8Array;
  credentialSlotRefs: [typeof ANTHROPIC_API_KEY_SLOT_ID];
  responsePolicy: AnthropicDirectResponsePolicyV1;
  rewrittenAttachmentMessages: number;
};

type AnthropicDirectAdapterFailureCode =
  | "body-limit-exceeded"
  | "incompatible-credential-slot"
  | "invalid-body"
  | "invalid-config"
  | "invalid-request"
  | "missing-credential-slot";

export class AnthropicDirectAdapterError extends Error {
  readonly code: AnthropicDirectAdapterFailureCode;

  constructor(code: AnthropicDirectAdapterFailureCode, message: string) {
    super(message);
    this.name = "AnthropicDirectAdapterError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

const MARKER_PATTERN = /<(provider-image|provider-document)\b[^>]*?\bdata="(data:[^"]+)"[^>]*\/>/g;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactMessagesUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AnthropicDirectAdapterError(
      "invalid-config",
      "Anthropic direct endpoint must be an absolute HTTPS URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== ANTHROPIC_DIRECT_ORIGIN ||
    url.pathname !== ANTHROPIC_DIRECT_MESSAGES_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AnthropicDirectAdapterError(
      "invalid-config",
      `Anthropic direct endpoint must use ${ANTHROPIC_DIRECT_ORIGIN}${ANTHROPIC_DIRECT_MESSAGES_PATH}`,
    );
  }
  return url;
}

function credentialSlot(slots: CredentialSlotReadinessV1[]): CredentialSlotReadinessV1 {
  const matches = slots.filter((entry) => entry.slotId === ANTHROPIC_API_KEY_SLOT_ID);
  if (matches.length !== 1) {
    throw new AnthropicDirectAdapterError(
      "missing-credential-slot",
      `Anthropic direct requests require exactly one ${ANTHROPIC_API_KEY_SLOT_ID}`,
    );
  }
  const slot = matches[0]!;
  if (
    slot.version !== CREDENTIAL_SLOT_VERSION ||
    slot.resolverVersion !== CREDENTIAL_SLOT_RESOLVER_VERSION ||
    slot.placement !== "header" ||
    slot.headerName.toLowerCase() !== "x-api-key" ||
    !slot.required ||
    slot.allowedOrigins.length !== 1 ||
    slot.allowedOrigins[0] !== ANTHROPIC_DIRECT_ORIGIN
  ) {
    throw new AnthropicDirectAdapterError(
      "incompatible-credential-slot",
      `${ANTHROPIC_API_KEY_SLOT_ID} must inject x-api-key only for ${ANTHROPIC_DIRECT_ORIGIN}`,
    );
  }
  return slot;
}

function parseDataUri(value: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;]+);base64,(.+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const mediaType = match[1] ?? "";
  const data = match[2] ?? "";
  if (!mediaType || !data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    return undefined;
  }
  return { mediaType, data };
}

function rewriteTextContent(value: string): unknown[] | undefined {
  MARKER_PATTERN.lastIndex = 0;
  const parts: unknown[] = [];
  let cursor = 0;
  let found = false;
  for (const match of value.matchAll(MARKER_PATTERN)) {
    found = true;
    const full = match[0];
    const start = match.index;
    if (start > cursor) {
      parts.push({ type: "text", text: value.slice(cursor, start) });
    }
    const parsed = parseDataUri(match[2] ?? "");
    if (!parsed) {
      parts.push({ type: "text", text: full });
    } else {
      const type = match[1] === "provider-document" ? "document" : "image";
      parts.push({
        type,
        source: {
          type: "base64",
          media_type: parsed.mediaType,
          data: parsed.data,
        },
      });
    }
    cursor = start + full.length;
  }
  if (!found) {
    return undefined;
  }
  if (cursor < value.length) {
    parts.push({ type: "text", text: value.slice(cursor) });
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "" });
  }
  const documents = parts.filter((part) => isObject(part) && part.type === "document");
  if (documents.length === 0) {
    return parts;
  }
  return [...documents, ...parts.filter((part) => !isObject(part) || part.type !== "document")];
}

function rewriteContentArray(parts: unknown[]): { parts: unknown[]; rewritten: boolean } {
  const result: unknown[] = [];
  let rewritten = false;
  for (const part of parts) {
    if (!isObject(part) || part.type !== "text" || typeof part.text !== "string") {
      result.push(part);
      continue;
    }
    const expanded = rewriteTextContent(part.text);
    if (!expanded) {
      result.push(part);
      continue;
    }
    if (part.cache_control !== undefined) {
      const finalPart = expanded.at(-1);
      if (isObject(finalPart)) {
        finalPart.cache_control = part.cache_control;
      }
    }
    rewritten = true;
    result.push(...expanded);
  }
  return { parts: result, rewritten };
}

function rewriteAttachmentMarkers(root: JsonObject): number {
  if (!Array.isArray(root.messages)) {
    return 0;
  }
  let rewrittenMessages = 0;
  for (const message of root.messages) {
    if (!isObject(message) || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      const rewritten = rewriteTextContent(message.content);
      if (rewritten) {
        message.content = rewritten;
        rewrittenMessages += 1;
      }
      continue;
    }
    if (Array.isArray(message.content)) {
      const rewritten = rewriteContentArray(message.content);
      if (rewritten.rewritten) {
        message.content = rewritten.parts;
        rewrittenMessages += 1;
      }
    }
  }
  return rewrittenMessages;
}

function boundedBody(body: string | Uint8Array): Uint8Array {
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? new Uint8Array(body)
        : undefined;
  if (!bytes) {
    throw new AnthropicDirectAdapterError(
      "invalid-body",
      "Anthropic direct body must be a bounded string or Uint8Array",
    );
  }
  if (bytes.byteLength > ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES) {
    throw new AnthropicDirectAdapterError(
      "body-limit-exceeded",
      `Anthropic direct body exceeds ${ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES} bytes`,
    );
  }
  return bytes;
}

export function prepareAnthropicDirectRequestV1(params: {
  config: AnthropicDirectAdapterConfigV1;
  context: AnthropicDirectRequestContextV1;
  method: string;
  headers?: HeadersInit;
  body: string | Uint8Array;
  credentialSlots: CredentialSlotReadinessV1[];
}): PreparedAnthropicDirectRequestV1 {
  if (params.method.toUpperCase() !== "POST") {
    throw new AnthropicDirectAdapterError(
      "invalid-request",
      "Anthropic direct model requests must use POST",
    );
  }
  credentialSlot(params.credentialSlots);
  const configuredUrl = exactMessagesUrl(
    params.config.endpoint ?? `${ANTHROPIC_DIRECT_ORIGIN}${ANTHROPIC_DIRECT_MESSAGES_PATH}`,
  );
  const originalUrl = exactMessagesUrl(params.context.originalUrl);
  if (
    configuredUrl.origin !== originalUrl.origin ||
    configuredUrl.pathname !== originalUrl.pathname
  ) {
    throw new AnthropicDirectAdapterError(
      "invalid-request",
      "Anthropic direct request does not match the configured endpoint",
    );
  }
  const originalBody = boundedBody(params.body);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(originalBody));
  } catch {
    throw new AnthropicDirectAdapterError(
      "invalid-body",
      "Anthropic direct body must be valid JSON",
    );
  }
  if (!isObject(value)) {
    throw new AnthropicDirectAdapterError(
      "invalid-body",
      "Anthropic direct body must be a JSON object",
    );
  }
  const rewrittenAttachmentMessages = rewriteAttachmentMarkers(value);
  const body =
    rewrittenAttachmentMessages === 0
      ? originalBody
      : new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES) {
    throw new AnthropicDirectAdapterError(
      "body-limit-exceeded",
      `Rewritten Anthropic direct body exceeds ${ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES} bytes`,
    );
  }
  const sourceHeaders = new Headers(params.headers);
  const headers = new Headers();
  for (const name of ANTHROPIC_PASSTHROUGH_HEADERS) {
    const headerValue = sourceHeaders.get(name);
    if (headerValue !== null) {
      headers.set(name, headerValue);
    }
  }
  headers.set("content-type", "application/json");
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", "2023-06-01");
  }
  const streaming = value.stream === true;
  return {
    adapterVersion: ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION,
    url: originalUrl.toString(),
    method: "POST",
    headers,
    body,
    credentialSlotRefs: [ANTHROPIC_API_KEY_SLOT_ID],
    responsePolicy: Object.freeze({
      mode: "anthropic-messages",
      streaming,
    }),
    rewrittenAttachmentMessages,
  };
}

export function adaptAnthropicDirectResponseV1(
  response: Response,
  _policy: AnthropicDirectResponsePolicyV1,
): Response {
  return response;
}
