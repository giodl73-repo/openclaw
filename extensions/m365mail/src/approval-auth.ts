import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveAccount } from "./accounts.js";

function normalizeM365MailApproverId(value: string | number): string | undefined {
  const trimmed = String(value).trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const m365MailApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Microsoft 365 Email",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveAccount(cfg ?? {}, accountId);
    return resolveApprovalApprovers({
      allowFrom: account.allowedSenders,
      normalizeApprover: normalizeM365MailApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeM365MailApproverId(value),
});
