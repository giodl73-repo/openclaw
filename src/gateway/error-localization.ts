import type { MessageParam } from "@openclaw/localization-core";
import { ErrorCodes } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_ERROR_MESSAGE_KEYS } from "./error-localization-keys.js";

const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/u;
const MAX_MESSAGE_KEY_LENGTH = 160;
const MAX_MESSAGE_PARAMS = 16;
const MAX_PARAM_KEY_LENGTH = 64;
const MAX_PARAM_STRING_LENGTH = 4_096;

export type GatewayErrorLocalizationMetadata = {
  messageKey: string;
  messageParams?: Readonly<Record<string, MessageParam>>;
};

type GatewayErrorDetailsWithLocalization = Record<string, unknown> & {
  localization: GatewayErrorLocalizationMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageParam(value: unknown): value is MessageParam {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function validateLocalizationMetadata(
  value: GatewayErrorLocalizationMetadata,
): GatewayErrorLocalizationMetadata {
  if (
    value.messageKey.length > MAX_MESSAGE_KEY_LENGTH ||
    !MESSAGE_KEY_PATTERN.test(value.messageKey)
  ) {
    throw new Error(`invalid Gateway localization message key: ${value.messageKey}`);
  }
  const params = Object.entries(value.messageParams ?? {});
  if (params.length > MAX_MESSAGE_PARAMS) {
    throw new Error(`too many Gateway localization parameters: ${params.length}`);
  }
  for (const [key, param] of params) {
    if (
      !key ||
      key.length > MAX_PARAM_KEY_LENGTH ||
      !isMessageParam(param) ||
      (typeof param === "string" && param.length > MAX_PARAM_STRING_LENGTH)
    ) {
      throw new Error(`invalid Gateway localization parameter: ${key || "(empty)"}`);
    }
  }
  return Object.freeze({
    messageKey: value.messageKey,
    ...(value.messageParams ? { messageParams: Object.freeze({ ...value.messageParams }) } : {}),
  });
}

/**
 * Adds optional localization metadata inside the existing opaque details
 * envelope while preserving the canonical English message for old clients.
 */
export function attachGatewayErrorLocalization(
  error: ErrorShape,
  localization: GatewayErrorLocalizationMetadata,
): ErrorShape {
  if (error.details !== undefined && !isRecord(error.details)) {
    throw new Error("Gateway error localization requires object-shaped details.");
  }
  if (error.details && "localization" in error.details) {
    throw new Error("Gateway error details already contain localization metadata.");
  }
  return {
    ...error,
    details: {
      ...error.details,
      localization: validateLocalizationMetadata(localization),
    } satisfies GatewayErrorDetailsWithLocalization,
  };
}

/** Reads validated localization metadata without trusting arbitrary error details. */
export function readGatewayErrorLocalization(
  error: Pick<ErrorShape, "details">,
): GatewayErrorLocalizationMetadata | null {
  if (!isRecord(error.details) || !isRecord(error.details.localization)) {
    return null;
  }
  const { messageKey, messageParams } = error.details.localization;
  if (
    typeof messageKey !== "string" ||
    messageKey.length > MAX_MESSAGE_KEY_LENGTH ||
    !MESSAGE_KEY_PATTERN.test(messageKey)
  ) {
    return null;
  }
  let validatedParams: Record<string, MessageParam> | undefined;
  if (messageParams !== undefined) {
    if (!isRecord(messageParams)) {
      return null;
    }
    if (Object.keys(messageParams).length > MAX_MESSAGE_PARAMS) {
      return null;
    }
    validatedParams = {};
    for (const [key, value] of Object.entries(messageParams)) {
      if (
        !key ||
        key.length > MAX_PARAM_KEY_LENGTH ||
        !isMessageParam(value) ||
        (typeof value === "string" && value.length > MAX_PARAM_STRING_LENGTH)
      ) {
        return null;
      }
      validatedParams[key] = value;
    }
  }
  return {
    messageKey,
    ...(validatedParams ? { messageParams: validatedParams } : {}),
  };
}

/**
 * Converts only explicitly reviewed stable errors. Unknown errors retain their
 * original shape and English message. Production emission remains deliberately
 * unwired until the Gateway owner approves the details.localization contract.
 */
export function attachKnownGatewayErrorLocalization(error: ErrorShape): ErrorShape {
  const reason = isRecord(error.details) ? error.details.reason : undefined;
  if (isRecord(error.details) && "localization" in error.details) {
    return error;
  }
  if (error.code === ErrorCodes.INVALID_REQUEST && reason === ErrorCodes.APPROVAL_NOT_FOUND) {
    return attachGatewayErrorLocalization(error, {
      messageKey: GATEWAY_ERROR_MESSAGE_KEYS.approvalNotFound,
    });
  }
  return error;
}
