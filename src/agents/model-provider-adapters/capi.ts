import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";

export const CAPI_MODEL_ADAPTER_VERSION = "capi-model-provider-adapter/v1" as const;
export const CAPI_MODEL_ADAPTER_ID = "lobster/capi" as const;
export const CAPI_BEARER_SLOT_ID = "lobster/capi-token" as const;

export const CAPI_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;
const CAPI_SSE_BUFFER_MAX_BYTES = 1024 * 1024;
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._-]+$/;
const UUID_RE =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const SAFE_SSE_EVENT_TYPE_RE = /^[A-Za-z0-9_.-]+$/;
const CAPI_PASSTHROUGH_HEADERS = [
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
] as const;

export type CapiModelAdapterFailureCode =
  | "invalid-config"
  | "invalid-context"
  | "invalid-request"
  | "body-required"
  | "body-limit-exceeded"
  | "invalid-body"
  | "model-required"
  | "invalid-model"
  | "missing-credential-slot"
  | "incompatible-credential-slot";

export class CapiModelAdapterError extends Error {
  readonly code: CapiModelAdapterFailureCode;

  constructor(code: CapiModelAdapterFailureCode, message: string) {
    super(message);
    this.name = "CapiModelAdapterError";
    this.code = code;
  }
}

export type CapiModelAdapterConfigV1 = {
  version: typeof CAPI_MODEL_ADAPTER_VERSION;
  endpointTemplate: string;
  partnerSource: string;
  featureId?: string;
};

export type CapiModelRequestContextV1 = {
  tenantId: string;
  userId: string;
  correlationId: string;
};

export type PreparedCapiModelRequestV1 = {
  adapterId: typeof CAPI_MODEL_ADAPTER_ID;
  adapterVersion: typeof CAPI_MODEL_ADAPTER_VERSION;
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
  credentialSlotRefs: [typeof CAPI_BEARER_SLOT_ID];
  model: string | undefined;
  stream: boolean;
  responsePolicy: {
    injectAnthropicSseEventTypes: boolean;
  };
};

function parseEndpointTemplate(config: CapiModelAdapterConfigV1): {
  template: string;
  templateMode: boolean;
} {
  if (config.version !== CAPI_MODEL_ADAPTER_VERSION) {
    throw new CapiModelAdapterError(
      "invalid-config",
      `Unsupported CAPI model adapter version: ${config.version}`,
    );
  }
  const template = config.endpointTemplate.trim();
  const hasTenant = template.includes("{tenant_id}");
  const hasModel = template.includes("{model}");
  if (!template || hasTenant !== hasModel) {
    throw new CapiModelAdapterError(
      "invalid-config",
      "CAPI endpoint must contain both tenant and model placeholders or neither",
    );
  }
  if (!config.partnerSource.trim()) {
    throw new CapiModelAdapterError("invalid-config", "CAPI partner source is required");
  }
  if (!hasTenant) {
    assertHttpsUrl(template, "CAPI endpoint");
  }
  return { template, templateMode: hasTenant };
}

function assertHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CapiModelAdapterError("invalid-config", `${label} is invalid`);
  }
  if (parsed.protocol !== "https:") {
    throw new CapiModelAdapterError("invalid-config", `${label} must use HTTPS`);
  }
  return parsed;
}

function normalizeBody(body: string | Uint8Array): Uint8Array {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > CAPI_REQUEST_BODY_MAX_BYTES) {
    throw new CapiModelAdapterError(
      "body-limit-exceeded",
      `CAPI request body exceeds ${CAPI_REQUEST_BODY_MAX_BYTES} bytes`,
    );
  }
  return Uint8Array.from(bytes);
}

function parseBody(body: Uint8Array): { model?: string; stream: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new CapiModelAdapterError("invalid-body", "CAPI request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapiModelAdapterError("invalid-body", "CAPI request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    stream: record.stream === true,
  };
}

function assertCredentialSlot(slots: CredentialSlotReadinessV1[], expectedOrigin: string): void {
  const matching = slots.filter((slot) => slot.slotId === CAPI_BEARER_SLOT_ID);
  if (matching.length !== 1) {
    throw new CapiModelAdapterError(
      "missing-credential-slot",
      `CAPI requires exactly one prepared "${CAPI_BEARER_SLOT_ID}" credential slot`,
    );
  }
  const slot = matching[0];
  if (
    slot.version !== CREDENTIAL_SLOT_VERSION ||
    slot.resolverVersion !== CREDENTIAL_SLOT_RESOLVER_VERSION ||
    slot.placement !== "header" ||
    slot.headerName !== "authorization" ||
    slot.required !== true ||
    slot.allowedOrigins.length !== 1 ||
    slot.allowedOrigins[0] !== expectedOrigin
  ) {
    throw new CapiModelAdapterError(
      "incompatible-credential-slot",
      `CAPI credential slot "${CAPI_BEARER_SLOT_ID}" is incompatible with the prepared endpoint`,
    );
  }
}

function appendStreamSuffix(url: URL): void {
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/stream`;
}

function setHeaderIfValid(headers: Headers, name: string, value: string): void {
  headers.delete(name);
  if (!value) {
    return;
  }
  try {
    headers.set(name, value);
  } catch {
    // Optional identity metadata must not turn invalid untrusted values into headers.
  }
}

function buildSourceHeader(config: CapiModelAdapterConfigV1): string {
  return JSON.stringify({
    consumptionSource: "Api",
    partnerSource: config.partnerSource,
    ...(config.featureId?.trim() ? { featureId: config.featureId.trim() } : {}),
  });
}

// This owner contract remains inactive until the next package supplies its first runtime binding.
// Keeping it internal avoids creating a premature plugin SDK or package export.
export function prepareCapiModelRequestV1(params: {
  config: CapiModelAdapterConfigV1;
  context: CapiModelRequestContextV1;
  method: string;
  headers?: HeadersInit;
  body: string | Uint8Array;
  credentialSlots: CredentialSlotReadinessV1[];
}): PreparedCapiModelRequestV1 {
  const { template, templateMode } = parseEndpointTemplate(params.config);
  if (params.method.toUpperCase() !== "POST") {
    throw new CapiModelAdapterError("invalid-request", "CAPI model requests must use POST");
  }
  if (!UUID_RE.test(params.context.tenantId)) {
    throw new CapiModelAdapterError("invalid-context", "CAPI tenant ID must be a UUID");
  }

  const body = normalizeBody(params.body);
  const parsedBody = parseBody(body);
  if (templateMode && !parsedBody.model) {
    throw new CapiModelAdapterError(
      "model-required",
      "CAPI endpoint template requires a model in the request body",
    );
  }
  if (parsedBody.model && !SAFE_MODEL_ID_RE.test(parsedBody.model)) {
    throw new CapiModelAdapterError(
      "invalid-model",
      "CAPI request model contains invalid path characters",
    );
  }

  const endpoint = templateMode
    ? template
        .replaceAll("{tenant_id}", params.context.tenantId)
        .replaceAll("{model}", parsedBody.model ?? "")
    : template;
  const url = assertHttpsUrl(endpoint, "Prepared CAPI endpoint");
  if (parsedBody.stream) {
    appendStreamSuffix(url);
  }
  url.searchParams.append("customer_id", params.context.tenantId);
  assertCredentialSlot(params.credentialSlots, url.origin);

  const sourceHeaders = new Headers(params.headers);
  const headers = new Headers();
  for (const name of CAPI_PASSTHROUGH_HEADERS) {
    const value = sourceHeaders.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  headers.set("x-ms-source", buildSourceHeader(params.config));
  setHeaderIfValid(headers, "x-ms-client-principal-id", params.context.userId);
  setHeaderIfValid(headers, "x-ms-client-tenant-id", params.context.tenantId);
  setHeaderIfValid(headers, "x-ms-correlation-id", params.context.correlationId);

  return {
    adapterId: CAPI_MODEL_ADAPTER_ID,
    adapterVersion: CAPI_MODEL_ADAPTER_VERSION,
    url: url.toString(),
    method: params.method,
    headers,
    body,
    credentialSlotRefs: [CAPI_BEARER_SLOT_ID],
    model: parsedBody.model,
    stream: parsedBody.stream,
    responsePolicy: {
      injectAnthropicSseEventTypes: parsedBody.stream,
    },
  };
}

function findSseBoundary(buffer: Uint8Array): number | undefined {
  const lineEndingLength = (index: number): number => {
    if (buffer[index] === 10) {
      return 1;
    }
    if (buffer[index] === 13) {
      return buffer[index + 1] === 10 ? 2 : 1;
    }
    return 0;
  };

  for (let index = 0; index < buffer.byteLength; index += 1) {
    const firstLength = lineEndingLength(index);
    if (firstLength === 0) {
      continue;
    }
    const secondLength = lineEndingLength(index + firstLength);
    if (secondLength > 0) {
      return index + firstLength + secondLength;
    }
  }
  return undefined;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function transformSseBlock(blockBytes: Uint8Array): Uint8Array | undefined {
  const block = new TextDecoder().decode(blockBytes);
  if (!block.trim()) {
    return blockBytes;
  }
  const lines = block.split(/\r\n|\n|\r/);
  const hasEvent = lines.some((line) => line.trimStart().startsWith("event:"));
  const dataLine = lines.find((line) => line.trimStart().startsWith("data:"));
  if (!dataLine) {
    return blockBytes;
  }
  const payload = dataLine.trimStart().slice("data:".length).trim();
  if (payload === "[DONE]") {
    return undefined;
  }
  if (hasEvent) {
    return blockBytes;
  }
  let eventType: unknown;
  try {
    eventType = (JSON.parse(payload) as { type?: unknown }).type;
  } catch {
    return blockBytes;
  }
  if (typeof eventType !== "string" || !SAFE_SSE_EVENT_TYPE_RE.test(eventType)) {
    return blockBytes;
  }
  const lineEnding = block.includes("\r\n") ? "\r\n" : "\n";
  return new TextEncoder().encode(`event: ${eventType}${lineEnding}${block}`);
}

function injectCapiSseEventTypes(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let oversizedEvent = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const boundary = findSseBoundary(buffer);
          if (boundary !== undefined) {
            if (oversizedEvent || boundary > CAPI_SSE_BUFFER_MAX_BYTES) {
              controller.enqueue(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary);
              oversizedEvent = false;
              return;
            }
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary);
            const transformed = transformSseBlock(block);
            if (transformed) {
              controller.enqueue(transformed);
              return;
            }
            continue;
          }

          if (oversizedEvent && buffer.byteLength > 3) {
            const emitLength = buffer.byteLength - 3;
            controller.enqueue(buffer.slice(0, emitLength));
            buffer = buffer.slice(emitLength);
            return;
          }
          if (buffer.byteLength > CAPI_SSE_BUFFER_MAX_BYTES) {
            oversizedEvent = true;
            continue;
          }

          const chunk = await reader.read();
          if (chunk.done) {
            if (buffer.byteLength > 0) {
              const transformed = oversizedEvent ? buffer : transformSseBlock(buffer);
              buffer = new Uint8Array();
              if (transformed) {
                controller.enqueue(transformed);
              }
            }
            controller.close();
            return;
          }
          buffer = appendBytes(buffer, chunk.value);
        }
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export function adaptCapiModelResponseV1(
  response: Response,
  policy: PreparedCapiModelRequestV1["responsePolicy"],
): Response {
  if (!policy.injectAnthropicSseEventTypes || !response.ok || !response.body) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(injectCapiSseEventTypes(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
