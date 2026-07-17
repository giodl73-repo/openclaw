import { GATEWAY_ERROR_MESSAGE_KEYS } from "../../../src/gateway/error-localization-keys.ts";
import { GatewayRequestError } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";

const RECOGNIZED_GATEWAY_ERROR_KEYS = new Set<string>(Object.values(GATEWAY_ERROR_MESSAGE_KEYS));
const MAX_MESSAGE_PARAMS = 16;
const MAX_PARAM_KEY_LENGTH = 64;
const MAX_PARAM_STRING_LENGTH = 4_096;

type GatewayErrorTranslate = (key: string, params?: Record<string, string>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function readMessageParams(value: unknown): Record<string, string> | null {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_MESSAGE_PARAMS) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [key, param] of Object.entries(value)) {
    if (!key || key.length > MAX_PARAM_KEY_LENGTH) {
      return null;
    }
    if (typeof param === "number" && !Number.isFinite(param)) {
      return null;
    }
    if (typeof param !== "string" && typeof param !== "number" && typeof param !== "boolean") {
      return null;
    }
    const rendered = String(param);
    if (rendered.length > MAX_PARAM_STRING_LENGTH) {
      return null;
    }
    params[key] = rendered;
  }
  return params;
}

/**
 * Localizes only reviewed Gateway message keys and retains the server's
 * English message for unknown, malformed, or untranslated descriptors.
 */
export function resolveGatewayErrorMessage(
  error: unknown,
  translate: GatewayErrorTranslate = t,
): string {
  const fallback = fallbackErrorMessage(error);
  if (!(error instanceof GatewayRequestError) || !isRecord(error.details)) {
    return fallback;
  }
  const localization = error.details.localization;
  if (!isRecord(localization) || typeof localization.messageKey !== "string") {
    return fallback;
  }
  const messageKey = localization.messageKey;
  if (!RECOGNIZED_GATEWAY_ERROR_KEYS.has(messageKey)) {
    return fallback;
  }
  const params = readMessageParams(localization.messageParams);
  if (!params) {
    return fallback;
  }
  const localized = translate(messageKey, params);
  return localized && localized !== messageKey ? localized : fallback;
}
