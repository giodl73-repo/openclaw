import { describe, expect, it, vi } from "vitest";
import { respondUnknownOrExpiredApproval } from "./approval-shared.js";
import { respondApprovalNotFound } from "./approval.js";
import type { RespondFn } from "./types.js";

describe("approval Gateway error localization", () => {
  it("preserves the pending-approval English response and existing remediation", () => {
    const respond = vi.fn<RespondFn>();

    respondUnknownOrExpiredApproval(respond);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "unknown or expired approval id",
      details: {
        reason: "APPROVAL_NOT_FOUND",
        remediation:
          "Re-request the action; pending approvals are cleared after expiry or restart.",
        localization: {
          messageKey: "gateway.approval.notFound",
        },
      },
    });
  });

  it("preserves the durable-approval English response", () => {
    const respond = vi.fn<RespondFn>();

    respondApprovalNotFound(respond);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "approval not found",
      details: {
        reason: "APPROVAL_NOT_FOUND",
        localization: {
          messageKey: "gateway.approval.notFound",
        },
      },
    });
  });
});
