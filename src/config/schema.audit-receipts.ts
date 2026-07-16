import { z } from "zod";

const AuditReceiptsSchema = z
  .object({
    enabled: z.boolean().optional(),
    store: z
      .object({
        type: z.literal("sqlite"),
        path: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AuditSchema = z
  .object({
    enabled: z.boolean().optional(),
    messages: z.union([z.literal("off"), z.literal("direct"), z.literal("all")]).optional(),
    receipts: AuditReceiptsSchema.optional(),
  })
  .strict();

export const AUDIT_RECEIPT_FIELD_HELP: Record<string, string> = {
  audit:
    "Bounded metadata-only audit history for operator review. Run and tool records are enabled by default; message lifecycle metadata is a separate privacy-sensitive opt-in. The background writer is best-effort rather than a lossless compliance archive.",
  "audit.enabled":
    "Records new run, tool, and enabled message audit events. Default: true. Disabling event inserts does not immediately delete existing records; retained rows remain queryable until they expire.",
  "audit.messages":
    'Controls content-free message lifecycle records: "off" (default), "direct" for known direct conversations only, or "all" for direct, group, channel, and unknown conversation kinds. Both audit.enabled and audit.messages are startup-scoped; restart the Gateway after changing either setting.',
  "audit.receipts":
    "Durable typed business outcomes recorded by trusted tools. Receipts use a shared store so every local agent can search and count the same outcome history.",
  "audit.receipts.enabled":
    "Records new typed outcome receipts. Default: true. Disabling receipt recording does not delete existing rows.",
  "audit.receipts.store":
    "Shared receipt-store configuration. Version 1 supports a local SQLite database.",
  "audit.receipts.store.type": 'Receipt store type. Version 1 supports only "sqlite".',
  "audit.receipts.store.path":
    "Optional shared receipt SQLite path. Defaults to receipts.sqlite in the OpenClaw shared state directory.",
};

export const AUDIT_RECEIPT_FIELD_LABELS: Record<string, string> = {
  audit: "Audit Ledger",
  "audit.enabled": "Audit Ledger Enabled",
  "audit.messages": "Message Audit Scope",
  "audit.receipts": "Outcome Receipts",
  "audit.receipts.enabled": "Outcome Receipt Recording",
  "audit.receipts.store": "Outcome Receipt Store",
  "audit.receipts.store.type": "Outcome Receipt Store Type",
  "audit.receipts.store.path": "Outcome Receipt Database Path",
};
