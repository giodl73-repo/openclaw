import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";
import { wrapWebContent } from "../../security/external-content.js";
import { resolveSiteName } from "../tools/web-search-provider-common.js";
import { readResponseText } from "../tools/web-shared.js";

export const WEBIQ_ADAPTER_VERSION = "webiq-web-search-provider-adapter/v1" as const;
export const WEBIQ_ADAPTER_ID = "lobster/webiq" as const;
export const WEBIQ_API_KEY_SLOT_ID = "lobster/webiq-key" as const;
export const WEBIQ_SEARCH_PATH = "/v3/search/web";
export const WEBIQ_REQUEST_BODY_MAX_BYTES = 64 * 1024;
export const WEBIQ_RESPONSE_BODY_MAX_BYTES = 2_000_000;
const WEBIQ_ERROR_BODY_MAX_BYTES = 64_000;

type WebIqContentFormatV1 = "passage" | "text" | "html" | "markdown";

export type WebIqAdapterConfigV1 = {
  version: typeof WEBIQ_ADAPTER_VERSION;
  baseUrl: string;
  region?: string;
  language?: string;
  contentFormat?: WebIqContentFormatV1;
  maxLength?: number;
};

export type WebIqSearchRequestV1 = {
  query: string;
  maxResults?: number;
  region?: string;
  language?: string;
  contentFormat?: WebIqContentFormatV1;
  maxLength?: number;
};

type WebIqCredentialSlotReadinessV1 = Omit<CredentialSlotReadinessV1, "allowedOrigins"> & {
  readonly allowedOrigins: readonly string[];
};

export type PreparedWebIqRequestV1 = {
  adapterId: typeof WEBIQ_ADAPTER_ID;
  adapterVersion: typeof WEBIQ_ADAPTER_VERSION;
  url: string;
  method: "POST";
  headers: Headers;
  body: Uint8Array;
  credentialSlotRefs: [typeof WEBIQ_API_KEY_SLOT_ID];
  responsePolicy: WebIqResponsePolicyV1;
};

export type WebIqAdapterFailureCode =
  | "invalid-config"
  | "invalid-request"
  | "body-limit-exceeded"
  | "missing-credential-slot"
  | "incompatible-credential-slot"
  | "provider-error"
  | "invalid-response"
  | "response-limit-exceeded";

export type WebIqResponsePolicyV1 = {
  query: string;
  maxResults: number;
};

export type WebIqSearchResultV1 = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
};

export type WebIqSearchPayloadV1 = {
  query: string;
  provider: "webiq";
  count: number;
  tookMs: number;
  externalContent: {
    untrusted: true;
    source: "web_search";
    provider: "webiq";
    wrapped: true;
  };
  results: WebIqSearchResultV1[];
};

export class WebIqAdapterError extends Error {
  readonly code: WebIqAdapterFailureCode;

  constructor(code: WebIqAdapterFailureCode, message: string) {
    super(message);
    this.name = "WebIqAdapterError";
    this.code = code;
  }
}

function invalidConfig(message: string): never {
  throw new WebIqAdapterError("invalid-config", message);
}

function endpoint(config: WebIqAdapterConfigV1): URL {
  if (config.version !== WEBIQ_ADAPTER_VERSION) {
    invalidConfig("Unsupported WebIQ adapter version");
  }
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    invalidConfig("WebIQ base URL is invalid");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    invalidConfig("WebIQ base URL must be an HTTPS URL without credentials, query, or fragment");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${WEBIQ_SEARCH_PATH}`;
  return base;
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new WebIqAdapterError("invalid-request", `${label} is invalid`);
  }
  return value;
}

function text(value: unknown, fallback: string, label: string): string {
  const selected = value ?? fallback;
  if (typeof selected !== "string") {
    throw new WebIqAdapterError("invalid-request", `${label} is invalid`);
  }
  const normalized = selected.trim();
  if (!normalized) {
    throw new WebIqAdapterError("invalid-request", `${label} is required`);
  }
  return normalized;
}

function contentFormat(value: unknown): WebIqContentFormatV1 {
  if (value === "passage" || value === "text" || value === "html" || value === "markdown") {
    return value;
  }
  throw new WebIqAdapterError("invalid-request", "WebIQ content format is invalid");
}

function assertCredentialSlot(
  slots: readonly WebIqCredentialSlotReadinessV1[],
  expectedOrigin: string,
): void {
  const matching = slots.filter((slot) => slot.slotId === WEBIQ_API_KEY_SLOT_ID);
  if (matching.length !== 1) {
    throw new WebIqAdapterError(
      "missing-credential-slot",
      `WebIQ requires exactly one prepared "${WEBIQ_API_KEY_SLOT_ID}" credential slot`,
    );
  }
  const slot = matching[0];
  if (
    slot.version !== CREDENTIAL_SLOT_VERSION ||
    slot.resolverVersion !== CREDENTIAL_SLOT_RESOLVER_VERSION ||
    slot.placement !== "header" ||
    slot.headerName !== "x-apikey" ||
    !slot.required ||
    slot.allowedOrigins.length !== 1 ||
    slot.allowedOrigins[0] !== expectedOrigin
  ) {
    throw new WebIqAdapterError(
      "incompatible-credential-slot",
      `WebIQ credential slot "${WEBIQ_API_KEY_SLOT_ID}" is incompatible with the endpoint`,
    );
  }
}

export function prepareWebIqRequestV1(params: {
  config: WebIqAdapterConfigV1;
  request: WebIqSearchRequestV1;
  headers?: HeadersInit;
  credentialSlots: readonly WebIqCredentialSlotReadinessV1[];
}): PreparedWebIqRequestV1 {
  const url = endpoint(params.config);
  assertCredentialSlot(params.credentialSlots, url.origin);
  const query = text(params.request.query, "", "WebIQ query");
  const resolvedContentFormat = contentFormat(
    params.request.contentFormat ?? params.config.contentFormat ?? "passage",
  );
  const maxResults = boundedInteger(params.request.maxResults, 5, 50, "WebIQ result count");
  const body = new TextEncoder().encode(
    JSON.stringify({
      query,
      maxResults,
      region: text(params.request.region ?? params.config.region, "US", "WebIQ region"),
      language: text(params.request.language ?? params.config.language, "en", "WebIQ language"),
      contentFormat: resolvedContentFormat,
      maxLength: boundedInteger(
        params.request.maxLength ?? params.config.maxLength,
        6000,
        500_000,
        "WebIQ maximum content length",
      ),
    }),
  );
  if (body.byteLength > WEBIQ_REQUEST_BODY_MAX_BYTES) {
    throw new WebIqAdapterError(
      "body-limit-exceeded",
      `WebIQ request body exceeds ${WEBIQ_REQUEST_BODY_MAX_BYTES} bytes`,
    );
  }
  const headers = new Headers(params.headers);
  for (const name of ["authorization", "x-api-key", "x-apikey", "api-key"]) {
    headers.delete(name);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  return {
    adapterId: WEBIQ_ADAPTER_ID,
    adapterVersion: WEBIQ_ADAPTER_VERSION,
    url: url.toString(),
    method: "POST",
    headers,
    body,
    credentialSlotRefs: [WEBIQ_API_KEY_SLOT_ID],
    responsePolicy: Object.freeze({ query, maxResults }),
  };
}

function normalizeWebIqResults(raw: unknown, count: number): WebIqSearchResultV1[] {
  const values = Array.isArray(raw) ? raw : [];
  const results: WebIqSearchResultV1[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.isAdult === true ||
      typeof candidate.url !== "string" ||
      typeof candidate.title !== "string"
    ) {
      continue;
    }
    const siteName = resolveSiteName(candidate.url);
    results.push({
      title: wrapWebContent(candidate.title, "web_search"),
      url: candidate.url,
      snippet:
        typeof candidate.content === "string"
          ? wrapWebContent(candidate.content, "web_search")
          : "",
      ...(siteName ? { siteName } : {}),
    });
    if (results.length >= count) {
      break;
    }
  }
  return results;
}

export async function adaptWebIqResponseV1(
  response: Response,
  policy: WebIqResponsePolicyV1,
  tookMs: number,
): Promise<Response> {
  if (!response.ok) {
    const detail = await readResponseText(response, { maxBytes: WEBIQ_ERROR_BODY_MAX_BYTES });
    throw new WebIqAdapterError(
      "provider-error",
      `WebIQ search error (${response.status}): ${detail.text || response.statusText}`,
    );
  }
  const responseBody = await readResponseText(response, {
    maxBytes: WEBIQ_RESPONSE_BODY_MAX_BYTES,
  });
  if (responseBody.truncated) {
    throw new WebIqAdapterError("response-limit-exceeded", "WebIQ response is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody.text);
  } catch {
    throw new WebIqAdapterError("invalid-response", "WebIQ returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebIqAdapterError("invalid-response", "WebIQ response must be a JSON object");
  }
  const results = normalizeWebIqResults(
    (parsed as { webResults?: unknown }).webResults,
    policy.maxResults,
  );
  const payload: WebIqSearchPayloadV1 = {
    query: policy.query,
    provider: "webiq",
    count: results.length,
    tookMs: Math.max(0, Math.floor(tookMs)),
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "webiq",
      wrapped: true,
    },
    results,
  };
  return Response.json(payload, {
    status: response.status,
    statusText: response.statusText,
  });
}
