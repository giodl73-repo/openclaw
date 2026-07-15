import type { PreparedHostedProviderRequestV1 } from "openclaw/plugin-sdk/provider-request-runtime";

export const MSTEAMS_ACF_CHANNEL_REQUEST_VERSION = "msteams-acf-channel-request/v1" as const;
export const MSTEAMS_ACF_BEARER_SLOT_ID = "msteams/acf-token" as const;
export const MSTEAMS_ACF_PROVIDER_ID = "msteams-acf" as const;
export const MSTEAMS_ACF_ENDPOINT_CLASS = "bot-framework-connector" as const;

const MAX_INLINE_ACTIVITY_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVITY_PATH_RE = /(?:^|\/)v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/;

export const MSTEAMS_ACF_ALLOWED_ORIGINS = Object.freeze([
  "https://msteams.botframework.azure.cn",
  "https://smba.infra.dod.teams.microsoft.us",
  "https://smba.infra.gcc.teams.microsoft.com",
  "https://smba.infra.gov.teams.microsoft.us",
  "https://smba.trafficmanager.net",
]);

export type MSTeamsAcfCredentialSlotReadinessV1 = {
  slotId: string;
  version: string;
  resolverVersion: string;
  placement: "header";
  headerName: string;
  allowedOrigins: string[];
  required: boolean;
};

export type MSTeamsAcfRequestContextV1 = {
  tenantId: string;
  agentId: string;
  recipientId: string;
  conversationId: string;
};

export type PreparedMSTeamsAcfChannelRequestV1 = PreparedHostedProviderRequestV1 & {
  version: typeof MSTEAMS_ACF_CHANNEL_REQUEST_VERSION;
  responsePolicy: {
    mode: "msteams-acf";
    streaming: false;
  };
};

export type MSTeamsAcfRequestFailureCode =
  | "body-invalid"
  | "body-too-large"
  | "credential-conflict"
  | "credential-slot-incompatible"
  | "identity-missing"
  | "identity-mismatch"
  | "method-unsupported"
  | "target-denied";

export class MSTeamsAcfRequestError extends Error {
  readonly code: MSTeamsAcfRequestFailureCode;

  constructor(code: MSTeamsAcfRequestFailureCode, message: string) {
    super(message);
    this.name = "MSTeamsAcfRequestError";
    this.code = code;
  }
}

function requireIdentity(value: string, label: string, uuid = false): string {
  const normalized = value.trim();
  if (!normalized || (uuid && !UUID_RE.test(normalized))) {
    throw new MSTeamsAcfRequestError("identity-missing", `${label} is required`);
  }
  return normalized;
}

function resolveSlot(readiness: readonly MSTeamsAcfCredentialSlotReadinessV1[]) {
  const matches = readiness.filter((entry) => entry.slotId === MSTEAMS_ACF_BEARER_SLOT_ID);
  const slot = matches[0];
  if (matches.length !== 1 || !slot) {
    throw new MSTeamsAcfRequestError(
      "credential-slot-incompatible",
      "Microsoft Teams ACF requires one exact msteams/acf-token credential slot",
    );
  }
  const origins = slot.allowedOrigins.toSorted();
  if (
    slot.version !== "credential-slot/v1" ||
    slot.resolverVersion !== "credential-slot-resolver/v1" ||
    slot.placement !== "header" ||
    slot.headerName.trim().toLowerCase() !== "authorization" ||
    !slot.required ||
    origins.length !== MSTEAMS_ACF_ALLOWED_ORIGINS.length ||
    origins.some((origin, index) => origin !== MSTEAMS_ACF_ALLOWED_ORIGINS[index])
  ) {
    throw new MSTeamsAcfRequestError(
      "credential-slot-incompatible",
      "Microsoft Teams ACF requires one exact msteams/acf-token credential slot",
    );
  }
  return slot;
}

function parseTarget(url: string, method: string, conversationId: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MSTeamsAcfRequestError("target-denied", "Microsoft Teams ACF URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    !MSTEAMS_ACF_ALLOWED_ORIGINS.includes(parsed.origin) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new MSTeamsAcfRequestError(
      "target-denied",
      "Microsoft Teams ACF URL is outside the supported Bot Connector origins",
    );
  }
  const pathMatch = ACTIVITY_PATH_RE.exec(parsed.pathname);
  const activityId = pathMatch?.[2];
  let targetConversationId: string;
  try {
    targetConversationId = decodeURIComponent(pathMatch?.[1] ?? "");
  } catch {
    throw new MSTeamsAcfRequestError("target-denied", "Microsoft Teams ACF path is invalid");
  }
  if (!pathMatch || targetConversationId !== conversationId) {
    throw new MSTeamsAcfRequestError(
      "identity-mismatch",
      "Microsoft Teams ACF URL does not match the prepared conversation",
    );
  }
  if ((method === "POST" && activityId) || (method !== "POST" && !activityId)) {
    throw new MSTeamsAcfRequestError(
      "method-unsupported",
      "Microsoft Teams ACF method does not match the activity route",
    );
  }
  return parsed;
}

function toBytes(body: string | Uint8Array): Uint8Array {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > MAX_INLINE_ACTIVITY_BYTES) {
    throw new MSTeamsAcfRequestError(
      "body-too-large",
      "Microsoft Teams ACF activity exceeds the hosted request limit",
    );
  }
  return new Uint8Array(bytes);
}

function parseActivity(body: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("activity must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new MSTeamsAcfRequestError(
      "body-invalid",
      "Microsoft Teams ACF activity body must be valid JSON",
    );
  }
}

function nestedId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id.trim() : "";
}

function nestedString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested.trim() : "";
}

function activityTenantIds(activity: Record<string, unknown>): string[] {
  const tenantIds = [
    typeof activity.tenantId === "string" ? activity.tenantId.trim() : "",
    nestedString(activity.conversation, "tenantId"),
  ];
  const channelData = activity.channelData;
  if (channelData && typeof channelData === "object" && !Array.isArray(channelData)) {
    tenantIds.push(nestedId((channelData as Record<string, unknown>).tenant));
  }
  return tenantIds.filter(Boolean);
}

function assertActivityIdentity(
  activity: Record<string, unknown>,
  context: Required<MSTeamsAcfRequestContextV1>,
  requireComplete: boolean,
): void {
  const tenantIds = activityTenantIds(activity);
  const fromId = nestedId(activity.from);
  const recipientId = nestedId(activity.recipient);
  const conversationId = nestedId(activity.conversation);
  if (
    (requireComplete && tenantIds.length === 0) ||
    tenantIds.some((tenantId) => tenantId !== context.tenantId) ||
    (requireComplete && fromId === "") ||
    (fromId !== "" && fromId !== context.agentId) ||
    (recipientId !== "" && recipientId !== context.recipientId) ||
    (requireComplete && conversationId === "") ||
    (conversationId !== "" && conversationId !== context.conversationId)
  ) {
    throw new MSTeamsAcfRequestError(
      "identity-mismatch",
      "Microsoft Teams ACF activity identity does not match the Channel context",
    );
  }
}

export function prepareMSTeamsAcfChannelRequestV1(params: {
  context: MSTeamsAcfRequestContextV1;
  method: string;
  url: string;
  headers?: HeadersInit;
  body?: string | Uint8Array;
  credentialSlots: readonly MSTeamsAcfCredentialSlotReadinessV1[];
}): PreparedMSTeamsAcfChannelRequestV1 {
  const context = {
    tenantId: requireIdentity(params.context.tenantId, "Microsoft Teams tenant identity", true),
    agentId: requireIdentity(params.context.agentId, "Microsoft Teams agent identity"),
    recipientId: requireIdentity(params.context.recipientId, "Microsoft Teams recipient identity"),
    conversationId: requireIdentity(
      params.context.conversationId,
      "Microsoft Teams conversation identity",
    ),
  };
  const method = params.method.trim().toUpperCase();
  if (!["DELETE", "POST", "PUT"].includes(method)) {
    throw new MSTeamsAcfRequestError(
      "method-unsupported",
      "Microsoft Teams ACF supports only activity create, update, and delete",
    );
  }
  const target = parseTarget(params.url, method, context.conversationId);
  resolveSlot(params.credentialSlots);

  const sourceHeaders = new Headers(params.headers);
  if (sourceHeaders.has("authorization") || sourceHeaders.has("proxy-authorization")) {
    throw new MSTeamsAcfRequestError(
      "credential-conflict",
      "Microsoft Teams ACF credentials must come from the selected credential slot",
    );
  }
  const headers = new Headers();
  for (const name of ["accept", "user-agent"]) {
    const value = sourceHeaders.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  let body: Uint8Array | undefined;
  if (method === "DELETE") {
    if (params.body !== undefined) {
      throw new MSTeamsAcfRequestError(
        "body-invalid",
        "Microsoft Teams ACF delete requests cannot include a body",
      );
    }
  } else {
    if (params.body === undefined) {
      throw new MSTeamsAcfRequestError(
        "body-invalid",
        "Microsoft Teams ACF activity request requires a body",
      );
    }
    body = toBytes(params.body);
    assertActivityIdentity(parseActivity(body), context, method === "POST");
    headers.set("content-type", "application/json");
  }

  return Object.freeze({
    version: MSTEAMS_ACF_CHANNEL_REQUEST_VERSION,
    url: target.toString(),
    method,
    headers,
    ...(body ? { body } : {}),
    credentialSlotRefs: [MSTEAMS_ACF_BEARER_SLOT_ID],
    responsePolicy: Object.freeze({
      mode: "msteams-acf" as const,
      streaming: false as const,
    }),
  });
}

export function adaptMSTeamsAcfChannelResponseV1(
  response: Response,
  policy: PreparedMSTeamsAcfChannelRequestV1["responsePolicy"],
): Response {
  if (policy.mode !== "msteams-acf" || policy.streaming) {
    throw new MSTeamsAcfRequestError(
      "body-invalid",
      "Microsoft Teams ACF response policy is incompatible",
    );
  }
  return response;
}
