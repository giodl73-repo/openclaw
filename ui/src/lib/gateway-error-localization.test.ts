import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { resolveGatewayErrorMessage } from "./gateway-error-localization.ts";

function localizedError(localization: unknown): GatewayRequestError {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "unknown or expired approval id",
    details: {
      reason: "APPROVAL_NOT_FOUND",
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
      ),
    ).toBe("La aprobación no existe o ha caducado.");
    expect(translate).toHaveBeenCalledWith("gateway.approval.notFound", {});
  });

  it("falls back to reviewed English for unknown or untranslated keys", () => {
    expect(
      resolveGatewayErrorMessage(
        localizedError({ messageKey: "gateway.unreviewed.message" }),
        vi.fn(() => "Untrusted text"),
      ),
    ).toBe("unknown or expired approval id");
    expect(
      resolveGatewayErrorMessage(
        localizedError({ messageKey: "gateway.approval.notFound" }),
        vi.fn((key) => key),
      ),
    ).toBe("unknown or expired approval id");
  });

  it("rejects malformed or unbounded parameters", () => {
    expect(
      resolveGatewayErrorMessage(
        localizedError({
          messageKey: "gateway.approval.notFound",
          messageParams: { nested: { unsafe: true } },
        }),
        vi.fn(() => "Localized"),
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
      ),
    ).toBe("unknown or expired approval id");
  });

  it("preserves ordinary non-Gateway errors", () => {
    expect(resolveGatewayErrorMessage(new Error("network unavailable"), vi.fn())).toBe(
      "network unavailable",
    );
  });
});
