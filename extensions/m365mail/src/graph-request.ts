import type {
  PreparedCredentialSlotBindingsV1,
  PreparedHostedProviderRequestV1,
} from "openclaw/plugin-sdk/provider-request-runtime";
import type { ResolvedM365MailAccount } from "./types.js";

export const M365MAIL_GRAPH_REQUEST_VERSION = "m365mail-graph-request/v1" as const;
export const M365MAIL_GRAPH_BEARER_SLOT_ID = "m365mail/graph-token" as const;
export const M365MAIL_GRAPH_PROVIDER_ID = "m365mail-graph" as const;
export const M365MAIL_GRAPH_ENDPOINT_CLASS = "microsoft-graph-mail" as const;

const MAX_GRAPH_REQUEST_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 300;

export const M365MAIL_GRAPH_ALLOWED_ORIGINS = Object.freeze([
  "https://dod-graph.microsoft.us",
  "https://graph.microsoft.com",
  "https://graph.microsoft.us",
  "https://microsoftgraph.chinacloudapi.cn",
]);

export type M365MailGraphCredentialSlotReadinessV1 = ReturnType<
  PreparedCredentialSlotBindingsV1["readiness"]
>[number];

export type M365MailGraphRequestContextV1 = {
  account: ResolvedM365MailAccount;
  agentId?: string;
};

export type M365MailGraphOperationV1 =
  | {
      kind: "reply";
      messageId: string;
      text: string;
    }
  | {
      kind: "send";
      text: string;
      toAddress: string;
      subject: string;
    };

export type PreparedM365MailGraphRequestV1 = PreparedHostedProviderRequestV1 & {
  version: typeof M365MAIL_GRAPH_REQUEST_VERSION;
  credentialSlotRefs: [] | [typeof M365MAIL_GRAPH_BEARER_SLOT_ID];
  responsePolicy: {
    mode: "m365mail-graph";
    successStatus: 202;
    replay: "never";
  };
};

export type M365MailGraphRequestFailureCode =
  | "body-too-large"
  | "credential-conflict"
  | "credential-missing"
  | "credential-slot-incompatible"
  | "identity-mismatch"
  | "identity-missing"
  | "response-rejected"
  | "target-denied"
  | "throttled";

export class M365MailGraphRequestError extends Error {
  readonly code: M365MailGraphRequestFailureCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: M365MailGraphRequestFailureCode,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "M365MailGraphRequestError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function exactGraphBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new M365MailGraphRequestError("target-denied", "Microsoft Graph base URL is invalid");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (
    parsed.protocol !== "https:" ||
    !M365MAIL_GRAPH_ALLOWED_ORIGINS.includes(parsed.origin) ||
    path !== "/v1.0" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new M365MailGraphRequestError(
      "target-denied",
      "Microsoft Graph mail requires one supported production v1.0 endpoint",
    );
  }
  return new URL(`${parsed.origin}/v1.0`);
}

function trustedAgentId(context: M365MailGraphRequestContextV1): string {
  const configured = context.account.agentId.trim();
  if (!configured) {
    throw new M365MailGraphRequestError(
      "identity-missing",
      "Microsoft 365 Email agent mailbox id is unavailable from trusted owner configuration",
    );
  }
  const asserted = context.agentId?.trim();
  if (asserted && asserted.toLowerCase() !== configured.toLowerCase()) {
    throw new M365MailGraphRequestError(
      "identity-mismatch",
      "Inbound agent mailbox identity does not match trusted owner configuration",
    );
  }
  return configured;
}

function resolveCredentialSlot(
  readiness: readonly M365MailGraphCredentialSlotReadinessV1[] | undefined,
): [] | [typeof M365MAIL_GRAPH_BEARER_SLOT_ID] {
  if (!readiness) {
    return [];
  }
  const matches = readiness.filter((entry) => entry.slotId === M365MAIL_GRAPH_BEARER_SLOT_ID);
  const slot = matches[0];
  if (matches.length !== 1 || !slot) {
    throw new M365MailGraphRequestError(
      "credential-slot-incompatible",
      "Microsoft 365 Email requires one exact m365mail/graph-token credential slot",
    );
  }
  const origins = slot.allowedOrigins.toSorted();
  if (
    slot.version !== "credential-slot/v1" ||
    slot.resolverVersion !== "credential-slot-resolver/v1" ||
    slot.placement !== "header" ||
    slot.headerName.trim().toLowerCase() !== "authorization" ||
    !slot.required ||
    origins.length !== M365MAIL_GRAPH_ALLOWED_ORIGINS.length ||
    origins.some((origin, index) => origin !== M365MAIL_GRAPH_ALLOWED_ORIGINS[index])
  ) {
    throw new M365MailGraphRequestError(
      "credential-slot-incompatible",
      "Microsoft 365 Email requires one exact m365mail/graph-token credential slot",
    );
  }
  return [M365MAIL_GRAPH_BEARER_SLOT_ID];
}

function encodeBody(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > MAX_GRAPH_REQUEST_BYTES) {
    throw new M365MailGraphRequestError(
      "body-too-large",
      "Microsoft Graph mail request exceeds the owner limit",
    );
  }
  return body;
}

export function prepareM365MailGraphRequestV1(params: {
  context: M365MailGraphRequestContextV1;
  operation: M365MailGraphOperationV1;
  headers?: HeadersInit;
  credentialSlots?: readonly M365MailGraphCredentialSlotReadinessV1[];
}): PreparedM365MailGraphRequestV1 {
  const baseUrl = exactGraphBaseUrl(params.context.account.graphBaseUrl);
  const agentId = encodeURIComponent(trustedAgentId(params.context));
  const sourceHeaders = new Headers(params.headers);
  if (sourceHeaders.has("authorization") || sourceHeaders.has("proxy-authorization")) {
    throw new M365MailGraphRequestError(
      "credential-conflict",
      "Microsoft Graph credentials must come from the selected owner binding",
    );
  }
  const headers = new Headers();
  const accept = sourceHeaders.get("accept");
  if (accept !== null) {
    headers.set("accept", accept);
  }
  headers.set("content-type", "application/json");

  let path: string;
  let body: Uint8Array;
  if (params.operation.kind === "reply") {
    const messageId = params.operation.messageId.trim();
    if (!messageId) {
      throw new M365MailGraphRequestError(
        "identity-missing",
        "Microsoft Graph threaded reply requires the source message ID",
      );
    }
    path = `/v1.0/users/${agentId}/messages/${encodeURIComponent(messageId)}/reply`;
    body = encodeBody({ comment: params.operation.text });
  } else {
    path = `/v1.0/users/${agentId}/sendMail`;
    body = encodeBody({
      message: {
        subject: params.operation.subject,
        body: { contentType: "Text", content: params.operation.text },
        toRecipients: [{ emailAddress: { address: params.operation.toAddress } }],
      },
      saveToSentItems: true,
    });
  }

  return Object.freeze({
    version: M365MAIL_GRAPH_REQUEST_VERSION,
    url: new URL(path, baseUrl).toString(),
    method: "POST",
    headers,
    body,
    credentialSlotRefs: resolveCredentialSlot(params.credentialSlots),
    responsePolicy: Object.freeze({
      mode: "m365mail-graph" as const,
      successStatus: 202 as const,
      replay: "never" as const,
    }),
  });
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
}

export async function acceptM365MailGraphResponseV1(
  response: Response,
  policy: PreparedM365MailGraphRequestV1["responsePolicy"],
): Promise<void> {
  if (
    policy.mode !== "m365mail-graph" ||
    policy.successStatus !== 202 ||
    policy.replay !== "never"
  ) {
    throw new M365MailGraphRequestError(
      "response-rejected",
      "Microsoft Graph mail response policy is incompatible",
    );
  }
  if (response.status === policy.successStatus) {
    return;
  }
  if (response.status === 429) {
    const delay = retryAfterMs(response);
    throw new M365MailGraphRequestError("throttled", "Microsoft Graph throttled the mail request", {
      status: response.status,
      ...(delay !== undefined ? { retryAfterMs: delay } : {}),
    });
  }
  throw new M365MailGraphRequestError(
    "response-rejected",
    `Microsoft Graph mail request was rejected with status ${response.status}`,
    { status: response.status },
  );
}
