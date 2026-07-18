import { ErrorCodes } from "../../packages/gateway-protocol/src/schema/error-codes.js";

export const GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS = {
  approvalNotFound: {
    code: ErrorCodes.INVALID_REQUEST,
    reason: ErrorCodes.APPROVAL_NOT_FOUND,
    messageKey: "gateway.approval.notFound",
  },
} as const;

export const GATEWAY_ERROR_MESSAGE_KEYS = {
  approvalNotFound: GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS.approvalNotFound.messageKey,
} as const;
