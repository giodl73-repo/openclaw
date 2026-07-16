/** Local operator query surface for durable typed outcome receipts. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  countAuditReceipts,
  getAuditReceipt,
  listAuditReceipts,
  type AuditReceiptFilters,
  type RecordedAuditReceipt,
} from "../audit/receipt-store.sqlite.js";
import { getRuntimeConfig } from "../config/config.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export type ReceiptsCommandOptions = {
  id?: string;
  count?: boolean;
  type?: string;
  subjectType?: string;
  subjectId?: string;
  agent?: string;
  session?: string;
  run?: string;
  limit?: string;
  cursor?: string;
  json?: boolean;
};

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parsePositive(value: string | undefined, flag: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  const parsed = parseStrictPositiveInteger(value ?? "");
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function buildFilters(options: ReceiptsCommandOptions): AuditReceiptFilters {
  const subjectType = optionalTrimmed(options.subjectType);
  const subjectId = optionalTrimmed(options.subjectId);
  if (subjectId && !subjectType) {
    throw new Error("--subject-id requires --subject-type.");
  }
  const agentIds = optionalTrimmed(options.agent)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    ...(optionalTrimmed(options.type) ? { type: options.type!.trim() } : {}),
    ...(subjectType ? { subjectType } : {}),
    ...(subjectId ? { subjectId } : {}),
    ...(agentIds ? { agentIds } : {}),
    ...(optionalTrimmed(options.session) ? { sessionKey: options.session!.trim() } : {}),
    ...(optionalTrimmed(options.run) ? { runId: options.run!.trim() } : {}),
  };
}

function formatReceipt(receipt: RecordedAuditReceipt): string {
  const subject = receipt.subject ? ` ${receipt.subject.type}:${receipt.subject.id}` : "";
  return sanitizeTerminalText(
    `${timestampMsToIsoString(receipt.occurredAt) ?? receipt.occurredAt} ${receipt.type}${subject} ${receipt.receiptId} agent=${receipt.agentId} session=${receipt.sessionKey ?? receipt.sessionId} run=${receipt.runId}`,
  );
}

/** Get, list, or count receipts in the configured single-host store. */
export async function receiptsCommand(
  options: ReceiptsCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const receiptId = optionalTrimmed(options.id);
  if (receiptId) {
    if (
      options.count ||
      options.cursor ||
      options.limit ||
      options.type ||
      options.subjectType ||
      options.subjectId ||
      options.agent ||
      options.session ||
      options.run
    ) {
      throw new Error("--id cannot be combined with list or count filters.");
    }
    const receipt = getAuditReceipt({ receiptId, store: { cfg } });
    if (!receipt) {
      throw new Error(`receipt not found: ${receiptId}`);
    }
    writeRuntimeJson(runtime, receipt);
    return;
  }

  const filters = buildFilters(options);
  if (options.count) {
    if (options.cursor || options.limit) {
      throw new Error("--count cannot be combined with --cursor or --limit.");
    }
    const count = countAuditReceipts({ filters, store: { cfg } });
    if (options.json) {
      writeRuntimeJson(runtime, { count });
    } else {
      runtime.log(String(count));
    }
    return;
  }

  const limit = parsePositive(options.limit, "--limit", DEFAULT_LIMIT);
  if (limit > MAX_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_LIMIT}.`);
  }
  const cursor = options.cursor ? parsePositive(options.cursor, "--cursor") : undefined;
  const page = listAuditReceipts({ filters, limit, cursor, store: { cfg } });
  if (options.json) {
    writeRuntimeJson(runtime, page);
    return;
  }
  for (const receipt of page.receipts) {
    runtime.log(formatReceipt(receipt));
  }
  if (page.nextCursor !== undefined) {
    runtime.log(`More receipts: --cursor ${page.nextCursor}`);
  }
}
