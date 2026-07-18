import { GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS } from "../../../src/gateway/error-localization-keys.ts";
import { GatewayRequestError } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";

type GatewayErrorLocalizationDescriptor =
  (typeof GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS)[keyof typeof GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS];

const RECOGNIZED_GATEWAY_ERROR_DESCRIPTORS = new Map<string, GatewayErrorLocalizationDescriptor>(
  Object.values(GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS).map((descriptor) => [
    descriptor.messageKey,
    descriptor,
  ]),
);
const MAX_MESSAGE_PARAMS = 16;
const MAX_PARAM_KEY_LENGTH = 64;
const MAX_PARAM_STRING_LENGTH = 4_096;

type GatewayErrorTranslate = (key: string, params?: Record<string, string>) => string;
type GatewayErrorHasTranslation = (key: string) => boolean;

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

export function tryResolveLocalizedGatewayErrorMessage(
  error: unknown,
  translate: GatewayErrorTranslate = t,
  hasTranslation: GatewayErrorHasTranslation = (key) => i18n.hasTranslation(key),
): string | null {
  if (!(error instanceof GatewayRequestError) || !isRecord(error.details)) {
    return null;
  }
  const localization = error.details.localization;
  if (!isRecord(localization) || typeof localization.messageKey !== "string") {
    return null;
  }
  const messageKey = localization.messageKey;
  const descriptor = RECOGNIZED_GATEWAY_ERROR_DESCRIPTORS.get(messageKey);
  if (
    !descriptor ||
    error.gatewayCode !== descriptor.code ||
    error.details.reason !== descriptor.reason
  ) {
    return null;
  }
  const params = readMessageParams(localization.messageParams);
  if (!params || !hasTranslation(messageKey)) {
    return null;
  }
  const localized = translate(messageKey, params);
  return localized && localized !== messageKey ? localized : null;
}

/**
 * Localizes only reviewed Gateway message keys and retains the server's
 * English message for unknown, malformed, or untranslated descriptors.
 */
export function resolveGatewayErrorMessage(
  error: unknown,
  translate: GatewayErrorTranslate = t,
  hasTranslation?: GatewayErrorHasTranslation,
): string {
  return (
    tryResolveLocalizedGatewayErrorMessage(error, translate, hasTranslation) ??
    fallbackErrorMessage(error)
  );
}
