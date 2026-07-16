import {
  countAuditReceipts,
  listAuditReceipts,
  type RecordedAuditReceipt,
} from "../audit/receipt-store.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

type ReceiptQueryOptions = {
  sessionKey?: string;
  follow?: boolean;
  json?: boolean;
  count?: boolean;
  receiptType?: string;
};

function formatReceiptLine(receipt: RecordedAuditReceipt): string {
  const subject = receipt.subject ? ` subject=${receipt.subject.type}:${receipt.subject.id}` : "";
  return `${new Date(receipt.occurredAt).toISOString()} ${receipt.receiptType} agent=${receipt.agentId} session=${receipt.sessionKey ?? receipt.sessionId} run=${receipt.runId}${subject}`;
}

/** Handles a shared receipt query, returning false when normal trajectory tailing should continue. */
export function handleSessionsTailReceiptQuery(params: {
  cfg: OpenClawConfig;
  targets: Array<{ agentId: string }>;
  options: ReceiptQueryOptions;
  tailCount: number;
  runtime: RuntimeEnv;
}): boolean {
  const receiptType = params.options.receiptType?.trim();
  if (params.options.receiptType !== undefined && !receiptType) {
    params.runtime.error("--receipt-type must be a non-empty business type.");
    params.runtime.exit(1);
    return true;
  }
  if (params.options.count && !receiptType) {
    params.runtime.error("--count requires --receipt-type.");
    params.runtime.exit(1);
    return true;
  }
  if (params.options.json && !receiptType) {
    params.runtime.error(
      "--json requires --receipt-type so only sanitized audit receipts are emitted.",
    );
    params.runtime.exit(1);
    return true;
  }
  if (!receiptType) {
    return false;
  }
  if (params.options.follow) {
    params.runtime.error(
      "--receipt-type does not support --follow; rerun the snapshot query as needed.",
    );
    params.runtime.exit(1);
    return true;
  }
  const filters = {
    receiptType,
    agentIds: params.targets.map((target) => target.agentId),
    ...(params.options.sessionKey?.trim() ? { sessionKey: params.options.sessionKey.trim() } : {}),
  };
  if (params.options.count) {
    params.runtime.log(String(countAuditReceipts({ filters, store: { cfg: params.cfg } })));
    return true;
  }
  const receipts = listAuditReceipts({
    filters,
    limit: params.tailCount,
    store: { cfg: params.cfg },
  }).toReversed();
  for (const receipt of receipts) {
    params.runtime.log(params.options.json ? JSON.stringify(receipt) : formatReceiptLine(receipt));
  }
  return true;
}
