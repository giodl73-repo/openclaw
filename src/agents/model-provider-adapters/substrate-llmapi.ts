import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";

export const SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION =
  "substrate-llmapi-model-provider-adapter/v1" as const;
export const SUBSTRATE_LLMAPI_MODEL_ADAPTER_ID = "lobster/substrate-llmapi" as const;
export const SUBSTRATE_BEARER_SLOT_ID = "lobster/substrate-token" as const;

export const SUBSTRATE_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;
const SAFE_MODEL_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SubstrateLlmApiAdapterFailureCode =
  | "invalid-config"
  | "invalid-context"
  | "invalid-request"
  | "body-limit-exceeded"
  | "invalid-body"
  | "model-required"
  | "invalid-model"
  | "missing-credential-slot"
  | "incompatible-credential-slot";

export class SubstrateLlmApiAdapterError extends Error {
  readonly code: SubstrateLlmApiAdapterFailureCode;

  constructor(code: SubstrateLlmApiAdapterFailureCode, message: string) {
    super(message);
    this.name = "SubstrateLlmApiAdapterError";
    this.code = code;
  }
}

export type SubstrateTaxonomyConfigV1 = {
  experience: string;
  agent: string;
  inferenceStep: string;
  productionTrafficType: string;
  developmentTrafficType: string;
  extendedProperties: Readonly<Record<string, string>>;
};

export type SubstrateLlmApiAdapterConfigV1 = {
  version: typeof SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION;
  endpoint: string;
  scenarioGuid: string;
  appName: string;
  modelCatalog: string;
  modelMap: Readonly<Record<string, string>>;
  defaultModelType?: string;
  modelPath?: string;
  policyId?: string;
  taxonomy: SubstrateTaxonomyConfigV1;
};

export type SubstrateLlmApiRequestContextV1 = {
  originalUrl: string;
  correlationId: string;
};

export type PreparedSubstrateLlmApiRequestV1 = {
  adapterId: typeof SUBSTRATE_LLMAPI_MODEL_ADAPTER_ID;
  adapterVersion: typeof SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION;
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
  credentialSlotRefs: [typeof SUBSTRATE_BEARER_SLOT_ID];
  sourceModel: string | undefined;
  modelType: string;
  modelCatalog: string;
};

function invalidConfig(message: string): never {
  throw new SubstrateLlmApiAdapterError("invalid-config", message);
}

function requiredHeaderValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    invalidConfig(`${label} is required`);
  }
  try {
    const headers = new Headers();
    headers.set("x-validation", normalized);
  } catch {
    invalidConfig(`${label} is invalid`);
  }
  return normalized;
}

function parseEndpoint(config: SubstrateLlmApiAdapterConfigV1): URL {
  if (config.version !== SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION) {
    invalidConfig("Unsupported Substrate LLM API adapter version");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    invalidConfig("Substrate LLM API endpoint is invalid");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    invalidConfig("Substrate LLM API endpoint must be an HTTPS URL without credentials");
  }
  return endpoint;
}

function normalizeModelPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) {
    invalidConfig("Substrate LLM API model path must be an absolute path");
  }
  const parsed = new URL(normalized, "https://validation.invalid");
  if (parsed.origin !== "https://validation.invalid" || parsed.pathname !== normalized) {
    invalidConfig("Substrate LLM API model path is invalid");
  }
  return parsed.pathname;
}

function normalizeModelType(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_MODEL_TYPE_RE.test(normalized)) {
    throw new SubstrateLlmApiAdapterError("invalid-model", `${label} is invalid`);
  }
  return normalized;
}

function normalizeConfiguredModelType(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_MODEL_TYPE_RE.test(normalized)) {
    invalidConfig(`${label} is invalid`);
  }
  return normalized;
}

function normalizeBody(body: string | Uint8Array): Uint8Array {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > SUBSTRATE_REQUEST_BODY_MAX_BYTES) {
    throw new SubstrateLlmApiAdapterError(
      "body-limit-exceeded",
      `Substrate request body exceeds ${SUBSTRATE_REQUEST_BODY_MAX_BYTES} bytes`,
    );
  }
  return Uint8Array.from(bytes);
}

function parseSourceModel(body: Uint8Array): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SubstrateLlmApiAdapterError(
      "invalid-body",
      "Substrate request body must be valid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SubstrateLlmApiAdapterError(
      "invalid-body",
      "Substrate request body must be a JSON object",
    );
  }
  const model = (parsed as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

function resolveModelType(
  config: SubstrateLlmApiAdapterConfigV1,
  sourceModel: string | undefined,
): string {
  if (sourceModel) {
    const mapped = config.modelMap[sourceModel];
    return mapped === undefined
      ? normalizeModelType(sourceModel, "Substrate model type")
      : normalizeConfiguredModelType(mapped, "Mapped Substrate model type");
  }
  if (config.defaultModelType?.trim()) {
    return normalizeConfiguredModelType(config.defaultModelType, "Default Substrate model type");
  }
  throw new SubstrateLlmApiAdapterError(
    "model-required",
    "Substrate LLM API requires a request model or configured default model type",
  );
}

function assertModelMap(modelMap: Readonly<Record<string, string>>): void {
  for (const [source, target] of Object.entries(modelMap)) {
    if (!source.trim() || source !== source.trim()) {
      invalidConfig("Substrate model map contains an invalid source model");
    }
    normalizeConfiguredModelType(target, "Mapped Substrate model type");
  }
}

function assertCredentialSlot(slots: CredentialSlotReadinessV1[], expectedOrigin: string): void {
  const matching = slots.filter((slot) => slot.slotId === SUBSTRATE_BEARER_SLOT_ID);
  if (matching.length !== 1) {
    throw new SubstrateLlmApiAdapterError(
      "missing-credential-slot",
      `Substrate requires exactly one prepared "${SUBSTRATE_BEARER_SLOT_ID}" credential slot`,
    );
  }
  const slot = matching[0];
  if (
    slot.version !== CREDENTIAL_SLOT_VERSION ||
    slot.resolverVersion !== CREDENTIAL_SLOT_RESOLVER_VERSION ||
    slot.placement !== "header" ||
    slot.headerName !== "authorization" ||
    !slot.required ||
    slot.allowedOrigins.length !== 1 ||
    slot.allowedOrigins[0] !== expectedOrigin
  ) {
    throw new SubstrateLlmApiAdapterError(
      "incompatible-credential-slot",
      `Substrate credential slot "${SUBSTRATE_BEARER_SLOT_ID}" is incompatible with the endpoint`,
    );
  }
}

function modelPool(modelType: string): "dev" | "prod" {
  return modelType.startsWith("dev-") ? "dev" : "prod";
}

function taxonomyExtendedProperties(
  configured: Readonly<Record<string, string>>,
  pool: "dev" | "prod",
  modelType: string,
): string {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!key.trim() || typeof value !== "string") {
      invalidConfig("Substrate taxonomy extended properties are invalid");
    }
    properties[key] = value;
  }
  properties.ModelPool = pool;
  properties.ModelType = modelType;
  return JSON.stringify(properties);
}

function setOwnedHeader(headers: Headers, name: string, value: string): void {
  headers.delete(name);
  try {
    headers.set(name, value);
  } catch {
    invalidConfig(`Substrate ${name} header value is invalid`);
  }
}

export function prepareSubstrateLlmApiRequestV1(params: {
  config: SubstrateLlmApiAdapterConfigV1;
  context: SubstrateLlmApiRequestContextV1;
  method: string;
  headers?: HeadersInit;
  body: string | Uint8Array;
  credentialSlots: CredentialSlotReadinessV1[];
}): PreparedSubstrateLlmApiRequestV1 {
  const endpoint = parseEndpoint(params.config);
  if (params.method.toUpperCase() !== "POST") {
    throw new SubstrateLlmApiAdapterError(
      "invalid-request",
      "Substrate LLM API requests must use POST",
    );
  }
  let originalUrl: URL;
  try {
    originalUrl = new URL(params.context.originalUrl);
  } catch {
    throw new SubstrateLlmApiAdapterError(
      "invalid-context",
      "Substrate original request URL is invalid",
    );
  }
  if (!["http:", "https:"].includes(originalUrl.protocol)) {
    throw new SubstrateLlmApiAdapterError(
      "invalid-context",
      "Substrate original request URL is unsupported",
    );
  }
  const correlationId = params.context.correlationId.trim();
  if (!correlationId) {
    throw new SubstrateLlmApiAdapterError(
      "invalid-context",
      "Substrate correlation ID is required",
    );
  }

  assertModelMap(params.config.modelMap);
  const body = normalizeBody(params.body);
  const sourceModel = parseSourceModel(body);
  const modelType = resolveModelType(params.config, sourceModel);
  endpoint.pathname = normalizeModelPath(params.config.modelPath) ?? originalUrl.pathname;
  endpoint.search = originalUrl.search;
  endpoint.hash = "";
  assertCredentialSlot(params.credentialSlots, endpoint.origin);

  const pool = modelPool(modelType);
  const headers = new Headers(params.headers);
  headers.delete("authorization");
  setOwnedHeader(headers, "content-type", "application/json");
  setOwnedHeader(
    headers,
    "x-scenarioguid",
    requiredHeaderValue(params.config.scenarioGuid, "Substrate scenario GUID"),
  );
  setOwnedHeader(
    headers,
    "x-appname",
    requiredHeaderValue(params.config.appName, "Substrate application name"),
  );
  setOwnedHeader(headers, "x-modeltype", modelType);
  setOwnedHeader(
    headers,
    "x-modelcatalog",
    requiredHeaderValue(params.config.modelCatalog, "Substrate model catalog"),
  );
  setOwnedHeader(
    headers,
    "x-taxonomy-experience",
    requiredHeaderValue(params.config.taxonomy.experience, "Substrate taxonomy experience"),
  );
  setOwnedHeader(
    headers,
    "x-taxonomy-agent",
    requiredHeaderValue(params.config.taxonomy.agent, "Substrate taxonomy agent"),
  );
  setOwnedHeader(
    headers,
    "x-taxonomy-inferencestep",
    requiredHeaderValue(params.config.taxonomy.inferenceStep, "Substrate taxonomy inference step"),
  );
  setOwnedHeader(
    headers,
    "x-taxonomy-traffictype",
    requiredHeaderValue(
      pool === "dev"
        ? params.config.taxonomy.developmentTrafficType
        : params.config.taxonomy.productionTrafficType,
      "Substrate taxonomy traffic type",
    ),
  );
  setOwnedHeader(
    headers,
    "x-taxonomy-extendedproperties",
    taxonomyExtendedProperties(params.config.taxonomy.extendedProperties, pool, modelType),
  );
  setOwnedHeader(headers, "x-cv", correlationId);
  if (params.config.policyId?.trim()) {
    setOwnedHeader(
      headers,
      "x-policy-id",
      requiredHeaderValue(params.config.policyId, "Substrate policy ID"),
    );
  } else {
    headers.delete("x-policy-id");
  }

  return {
    adapterId: SUBSTRATE_LLMAPI_MODEL_ADAPTER_ID,
    adapterVersion: SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION,
    url: endpoint.toString(),
    method: "POST",
    headers,
    body,
    credentialSlotRefs: [SUBSTRATE_BEARER_SLOT_ID],
    sourceModel,
    modelType,
    modelCatalog: params.config.modelCatalog.trim(),
  };
}
