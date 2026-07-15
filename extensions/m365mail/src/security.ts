/**
 * Security helpers: sender allowlist authorization, input sanitization, and a
 * per-sender rate limiter.
 *
 * This channel runs brokered behind an external host runtime, so there is no inbound
 * webhook token to validate — trust is established by the loopback binding and
 * the runtime's own AAD validation of the upstream `bot-activities` callback.
 */

import {
  createFixedWindowRateLimiter,
  type FixedWindowRateLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";

export type DmAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "allowlist-empty" | "not-allowlisted" };

/**
 * Produce a stable, non-reversible fingerprint of a sender key for logs.
 *
 * The raw sender key is an email address (PII); the webhook handler must never
 * emit it (see its "never the email body or sender PII" contract). This yields
 * a short hex token that is stable per sender, so unauthorized / rate-limit
 * events stay correlatable across a spammer's messages without exposing the
 * address. FNV-1a 32-bit — dependency-free and deterministic; used only for
 * log correlation, never for security decisions.
 */
export function maskSender(sender: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sender.length; i += 1) {
    hash ^= sender.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `sender#${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Check if a sender (email address or AAD object id) is in the allowed list.
 * Allowlist mode must be explicit; empty lists should not match any sender.
 */
export function checkSenderAllowed(sender: string, allowedSenders: string[]): boolean {
  if (allowedSenders.length === 0) {
    return false;
  }
  return allowedSenders.includes(sender.trim().toLowerCase());
}

/**
 * Cross-tenant sender authorization (fail-closed).
 *
 * When cross-tenant senders are not opted in (`allowCrossTenant=false`, the
 * default) and the agent owner's tenant is known, the sender MUST positively be
 * in that same tenant: `senderTenant` has to be present AND equal to
 * `ownerTenant`. A sender whose tenant is absent — the common AOS email shape,
 * which carries no authenticated `from.tenantId` — or different is rejected, so
 * an opted-in agent is never driven by an unauthenticated / external sender.
 * This is the security boundary: it fails closed on a missing sender tenant
 * rather than falling through to the per-sender dmPolicy (`open` accepts
 * everyone), which is what previously let the tenant-less shape reach an
 * `open`-policy agent.
 *
 * `allowCrossTenant=true` opts into accepting external senders. If the owner
 * tenant itself is unknown the same-tenant compare cannot run, so this gate
 * defers to the downstream dmPolicy + rate limiter rather than dropping mail on
 * a state the runtime is not expected to produce.
 *
 * NOTE: same-tenant acceptance still trusts the platform-stamped
 * `from.tenantId`; a full owner-only / verified-identity model (comparing the
 * sender against the owner's own mailbox) is a deferred follow-up that depends
 * on confirming the `from.tenantId` authenticity contract. This function only
 * guarantees the DEFAULT posture rejects external / tenant-less senders.
 */
export function authorizeSenderTenant(
  allowCrossTenant: boolean,
  senderTenant: string,
  ownerTenant: string,
): boolean {
  if (allowCrossTenant) {
    return true;
  }
  if (!ownerTenant) {
    return true;
  }
  return senderTenant === ownerTenant;
}

/**
 * Resolve DM authorization for a sender across all DM policy modes.
 */
export function authorizeSenderForDm(
  sender: string,
  dmPolicy: "open" | "allowlist" | "disabled",
  allowedSenders: string[],
): DmAuthorizationResult {
  if (dmPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (dmPolicy === "open") {
    return { allowed: true };
  }
  if (allowedSenders.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  if (!checkSenderAllowed(sender, allowedSenders)) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

/**
 * Sanitize inbound email text to defang the most common prompt-injection
 * patterns and bound the payload size.
 */
export function sanitizeInput(text: string): string {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    /you\s+are\s+now\s+/gi,
    /system:\s*/gi,
    /<\|.*?\|>/g,
  ];

  let sanitized = text;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }

  const maxLength = 16_000;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + "... [truncated]";
  }

  return sanitized;
}

/** Fixed-window rate limiter keyed per sender. */
export class RateLimiter {
  private readonly limiter: FixedWindowRateLimiter;
  private readonly limit: number;

  constructor(limit = 30, windowSeconds = 60, maxTrackedSenders = 5_000) {
    this.limit = limit;
    this.limiter = createFixedWindowRateLimiter({
      windowMs: Math.max(1, Math.floor(windowSeconds * 1000)),
      maxRequests: Math.max(1, Math.floor(limit)),
      maxTrackedKeys: Math.max(1, Math.floor(maxTrackedSenders)),
    });
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(sender: string): boolean {
    return !this.limiter.isRateLimited(sender);
  }

  size(): number {
    return this.limiter.size();
  }

  clear(): void {
    this.limiter.clear();
  }

  maxRequests(): number {
    return this.limit;
  }
}
