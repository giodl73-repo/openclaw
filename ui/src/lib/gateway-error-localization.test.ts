import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  resolveGatewayErrorMessage,
  tryResolveLocalizedGatewayErrorMessage,
} from "./gateway-error-localization.ts";

function localizedError(
  localization: unknown,
  overrides: {
    code?: string;
    message?: string;
    reason?: string;
  } = {},
): GatewayRequestError {
  return new GatewayRequestError({
    code: overrides.code ?? "INVALID_REQUEST",
    message: overrides.message ?? "unknown or expired approval id",
    details: {
      reason: overrides.reason ?? "APPROVAL_NOT_FOUND",
      localization,
    },
  });
}

describe("resolveGatewayErrorMessage", () => {
  it("renders a recognized Gateway message key", () => {
    const translate = vi.fn(() => "La aprobación no existe o ha caducado.");

    expect(
      resolveGatewayErrorMessage(
        localizedError({
          messageKey: "gateway.approval.notFound",
        }),
        translate,
        () => true,
      ),
    ).toBe("La aprobación no existe o ha caducado.");
    expect(translate).toHaveBeenCalledWith("gateway.approval.notFound", {});
  });

  it("retains descriptor and retry metadata through the Gateway client error shape", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "approval not found",
      details: {
        reason: "APPROVAL_NOT_FOUND",
        localization: {
          messageKey: "gateway.approval.notFound",
        },
      },
      retryable: true,
      retryAfterMs: 250,
    });

    expect(error).toMatchObject({
      gatewayCode: "INVALID_REQUEST",
      message: "approval not found",
      details: {
        reason: "APPROVAL_NOT_FOUND",
        localization: {
          messageKey: "gateway.approval.notFound",
        },
      },
      retryable: true,
      retryAfterMs: 250,
    });
  });

  it("falls back to reviewed English for unknown or untranslated keys", () => {
    expect(
      resolveGatewayErrorMessage(
        localizedError({ messageKey: "gateway.unreviewed.message" }),
        vi.fn(() => "Untrusted text"),
        () => true,
      ),
    ).toBe("unknown or expired approval id");
    expect(
      resolveGatewayErrorMessage(
        localizedError({ messageKey: "gateway.approval.notFound" }),
        vi.fn((key) => key),
        () => true,
      ),
    ).toBe("unknown or expired approval id");
  });

  it("preserves canonical server English when the active locale lacks the key", () => {
    const translate = vi.fn(() => "Unknown or expired approval ID.");

    expect(
      resolveGatewayErrorMessage(
        localizedError({ messageKey: "gateway.approval.notFound" }),
        translate,
        () => false,
      ),
    ).toBe("unknown or expired approval id");
    expect(translate).not.toHaveBeenCalled();
  });

  it("rejects a recognized key attached to the wrong stable discriminator", () => {
    const translate = vi.fn(() => "Localized");

    expect(
      resolveGatewayErrorMessage(
        localizedError(
          { messageKey: "gateway.approval.notFound" },
          { reason: "SOME_OTHER_REASON" },
        ),
        translate,
        () => true,
      ),
    ).toBe("unknown or expired approval id");
    expect(
      resolveGatewayErrorMessage(
        localizedError({ messageKey: "gateway.approval.notFound" }, { code: "UNAVAILABLE" }),
        translate,
        () => true,
      ),
    ).toBe("unknown or expired approval id");
    expect(translate).not.toHaveBeenCalled();
  });

  it("rejects malformed or unbounded parameters", () => {
    expect(
      resolveGatewayErrorMessage(
        localizedError({
          messageKey: "gateway.approval.notFound",
          messageParams: { nested: { unsafe: true } },
        }),
        vi.fn(() => "Localized"),
        () => true,
      ),
    ).toBe("unknown or expired approval id");
    expect(
      resolveGatewayErrorMessage(
        localizedError({
          messageKey: "gateway.approval.notFound",
          messageParams: Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [`param${index}`, index]),
          ),
        }),
        vi.fn(() => "Localized"),
        () => true,
      ),
    ).toBe("unknown or expired approval id");
  });

  it("preserves ordinary non-Gateway errors", () => {
    expect(resolveGatewayErrorMessage(new Error("network unavailable"), vi.fn())).toBe(
      "network unavailable",
    );
  });

  it("returns null when no reviewed localized message can be rendered", () => {
    expect(
      tryResolveLocalizedGatewayErrorMessage(
        localizedError({ messageKey: "gateway.approval.notFound" }),
        vi.fn(() => "Unknown or expired approval ID."),
        () => false,
      ),
    ).toBeNull();
  });
});
