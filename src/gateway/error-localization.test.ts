import { describe, expect, it } from "vitest";
import { isGatewayResponseFrame } from "../../packages/gateway-protocol/src/frame-guards.js";
import {
  ErrorCodes,
  errorShape,
  validateResponseFrame,
} from "../../packages/gateway-protocol/src/index.js";
import {
  attachKnownGatewayErrorLocalization,
  attachGatewayErrorLocalization,
  readGatewayErrorLocalization,
} from "./error-localization.js";

describe("Gateway error localization metadata", () => {
  it("preserves English errors and existing details inside the compatible envelope", () => {
    const localized = attachGatewayErrorLocalization(
      errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
        details: {
          reason: ErrorCodes.APPROVAL_NOT_FOUND,
          remediation: "Re-request the action.",
        },
      }),
      {
        messageKey: "gateway.approval.notFound",
      },
    );
    const frame = {
      type: "res",
      id: "request-1",
      ok: false,
      error: localized,
    } as const;

    expect(localized.message).toBe("unknown or expired approval id");
    expect(localized.details).toMatchObject({
      reason: ErrorCodes.APPROVAL_NOT_FOUND,
      remediation: "Re-request the action.",
      localization: {
        messageKey: "gateway.approval.notFound",
      },
    });
    expect(isGatewayResponseFrame(frame)).toBe(true);
    expect(validateResponseFrame(frame)).toBe(true);
  });

  it("round-trips bounded scalar parameters", () => {
    const localized = attachGatewayErrorLocalization(
      errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.read"),
      {
        messageKey: "gateway.auth.missingScope",
        messageParams: { scope: "operator.read", retryable: false, attempts: 1 },
      },
    );

    expect(readGatewayErrorLocalization(localized)).toEqual({
      messageKey: "gateway.auth.missingScope",
      messageParams: { scope: "operator.read", retryable: false, attempts: 1 },
    });
  });

  it("converts only reviewed stable errors", () => {
    const approvalNotFound = errorShape(
      ErrorCodes.INVALID_REQUEST,
      "unknown or expired approval id",
      {
        details: { reason: ErrorCodes.APPROVAL_NOT_FOUND },
      },
    );
    const unavailable = errorShape(ErrorCodes.UNAVAILABLE, "gateway unavailable", {
      retryable: true,
    });

    expect(attachKnownGatewayErrorLocalization(approvalNotFound)).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown or expired approval id",
      details: {
        reason: ErrorCodes.APPROVAL_NOT_FOUND,
        localization: {
          messageKey: "gateway.approval.notFound",
        },
      },
    });
    expect(attachKnownGatewayErrorLocalization(unavailable)).toBe(unavailable);

    const alreadyLocalized = attachGatewayErrorLocalization(approvalNotFound, {
      messageKey: "gateway.approval.notFound",
    });
    expect(attachKnownGatewayErrorLocalization(alreadyLocalized)).toBe(alreadyLocalized);
  });

  it("rejects malformed or colliding metadata", () => {
    expect(() =>
      attachGatewayErrorLocalization(errorShape(ErrorCodes.INVALID_REQUEST, "invalid"), {
        messageKey: "not-namespaced",
      }),
    ).toThrow("invalid Gateway localization message key");

    expect(() =>
      attachGatewayErrorLocalization(
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid", { details: "legacy-string" }),
        {
          messageKey: "gateway.request.invalid",
        },
      ),
    ).toThrow("requires object-shaped details");

    expect(() =>
      attachGatewayErrorLocalization(
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid", {
          details: {
            localization: {
              messageKey: "gateway.existing.message",
            },
          },
        }),
        {
          messageKey: "gateway.request.invalid",
        },
      ),
    ).toThrow("already contain localization metadata");

    expect(
      readGatewayErrorLocalization({
        details: {
          localization: {
            messageKey: "gateway.request.invalid",
            messageParams: { unsafe: { nested: true } },
          },
        },
      }),
    ).toBeNull();

    expect(() =>
      attachGatewayErrorLocalization(errorShape(ErrorCodes.INVALID_REQUEST, "invalid"), {
        messageKey: "gateway.request.invalid",
        messageParams: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`param${index}`, index]),
        ),
      }),
    ).toThrow("too many Gateway localization parameters");
  });
});
