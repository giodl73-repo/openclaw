import { z } from "zod";

export const AuditSchema = z
  .object({
    enabled: z.boolean().optional(),
    messages: z.union([z.literal("off"), z.literal("direct"), z.literal("all")]).optional(),
  })
  .strict();

export const AUDIT_FIELD_HELP: Record<string, string> = {
  audit:
    "Bounded metadata-only audit history for operator review. Run and tool records are enabled by default; message lifecycle metadata is a separate privacy-sensitive opt-in. The background writer is best-effort rather than a lossless compliance archive.",
  "audit.enabled":
    "Records new run, tool, and enabled message audit events. Default: true. Disabling event inserts does not immediately delete existing records; retained rows remain queryable until they expire.",
  "audit.messages":
    'Controls content-free message lifecycle records: "off" (default), "direct" for known direct conversations only, or "all" for direct, group, channel, and unknown conversation kinds. Both audit.enabled and audit.messages are startup-scoped; restart the Gateway after changing either setting.',
};

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  audit: "Audit Ledger",
  "audit.enabled": "Audit Ledger Enabled",
  "audit.messages": "Message Audit Scope",
};
